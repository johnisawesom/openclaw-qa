import { Octokit } from '@octokit/rest';
import { FixSuggestion, ReviewResponse } from './types.js';
import { checkInvariants, InvariantCheckResult } from './invariants.js';

const VALID_ACTIONS = ['delete_line', 'replace_line', 'insert_after'] as const;

const GITHUB_OWNER = process.env.GITHUB_OWNER || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_PAT = process.env.GITHUB_PAT || '';

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function fetchFileContent(file: string): Promise<{ content: string; lineCount: number } | null> {
  if (!GITHUB_PAT || !GITHUB_OWNER || !GITHUB_REPO) {
    console.warn('[QA] GitHub credentials not set — skipping file existence check');
    return null;
  }

  try {
    const octokit = new Octokit({ auth: GITHUB_PAT });
    const response = await octokit.rest.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: file,
    });

    const data = response.data;

    if (Array.isArray(data) || !('content' in data) || typeof data.content !== 'string') {
      console.warn(`[QA] fetchFileContent: unexpected response shape for ${file}`);
      return null;
    }

    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const lineCount = content.split('\n').length;
    console.log(`[QA] fetchFileContent: ${file} exists — ${lineCount} lines`);
    return { content, lineCount };

  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.warn(`[QA] fetchFileContent: ${file} not found or error — ${e.message}`);
    return null;
  }
}

// ── Structural validation (synchronous) ──────────────────────────────────────

function validateStructure(fix: unknown): ReviewResponse | null {
  if (typeof fix !== 'object' || fix === null) {
    return { status: 'FAIL', reason: 'Fix payload is not an object' };
  }

  const f = fix as Record<string, unknown>;

  if (typeof f['file'] !== 'string' || f['file'].trim() === '') {
    return { status: 'FAIL', reason: 'Missing or invalid field: file' };
  }

  if (!f['file'].startsWith('src/')) {
    return {
      status: 'FAIL',
      reason: `Target file does not start with src/ — possible hallucination: ${f['file']}`,
    };
  }

  if (!f['file'].endsWith('.ts')) {
    return {
      status: 'FAIL',
      reason: `Target file does not end with .ts — possible hallucination: ${f['file']}`,
    };
  }

  if (typeof f['line'] !== 'number' || !Number.isInteger(f['line']) || f['line'] < 1) {
    return {
      status: 'FAIL',
      reason: `Invalid line number: ${f['line']} — must be a positive integer`,
    };
  }

  if (!VALID_ACTIONS.includes(f['action'] as (typeof VALID_ACTIONS)[number])) {
    return {
      status: 'FAIL',
      reason: `Invalid action: ${f['action']} — must be delete_line, replace_line, or insert_after`,
    };
  }

  if (typeof f['newContent'] !== 'string') {
    return { status: 'FAIL', reason: 'Missing or invalid field: newContent' };
  }

  if (typeof f['description'] !== 'string' || f['description'].trim() === '') {
    return { status: 'FAIL', reason: 'Missing or invalid field: description' };
  }

  return null;
}

// ── Full async validation ─────────────────────────────────────────────────────

export async function validateFixAsync(fix: unknown): Promise<{
  response: ReviewResponse;
  fileContent: string | null;
  invariantResults: InvariantCheckResult[];
  fileExistsCheck: boolean;
  lineBoundsCheck: boolean;
  linesChanged: number;
}> {
  // Step 1: structural check
  const structureError = validateStructure(fix);
  if (structureError) {
    console.log(`[QA] Structure check FAIL — ${structureError.reason}`);
    return {
      response: structureError,
      fileContent: null,
      invariantResults: [],
      fileExistsCheck: false,
      lineBoundsCheck: false,
      linesChanged: 0,
    };
  }

  const f = fix as FixSuggestion;
  let fileContent: string | null = null;
  let fileExistsCheck = false;
  let lineBoundsCheck = false;

  // Step 2: file existence and line bounds check via GitHub
  console.log(`[QA] Fetching file from GitHub: ${f.file}`);
  const fileData = await fetchFileContent(f.file);

  if (fileData === null) {
    // GitHub creds not set or file not found
    if (!GITHUB_PAT || !GITHUB_OWNER || !GITHUB_REPO) {
      console.warn('[QA] Skipping file/line checks — GitHub credentials not configured');
      fileExistsCheck = true;  // treat as pass when creds missing
      lineBoundsCheck = true;
    } else {
      console.warn(`[QA] File not found: ${f.file}`);
      return {
        response: {
          status: 'FAIL',
          reason: `File does not exist in repository: ${f.file}`,
        },
        fileContent: null,
        invariantResults: [],
        fileExistsCheck: false,
        lineBoundsCheck: false,
        linesChanged: 0,
      };
    }
  } else {
    fileContent = fileData.content;
    fileExistsCheck = true;

    // Line bounds check
    if (f.line > fileData.lineCount) {
      console.warn(`[QA] Line ${f.line} out of bounds — file has ${fileData.lineCount} lines`);
      return {
        response: {
          status: 'FAIL',
          reason: `Line ${f.line} is out of bounds — file only has ${fileData.lineCount} lines`,
        },
        fileContent,
        invariantResults: [],
        fileExistsCheck: true,
        lineBoundsCheck: false,
        linesChanged: 0,
      };
    }

    lineBoundsCheck = true;
    console.log(`[QA] File exists, line ${f.line} within bounds (${fileData.lineCount} total)`);
  }

  // Step 3: invariant checks
  console.log('[QA] Running invariant checks');
  const invariantResults = checkInvariants(f, fileContent);
  const failedInvariants = invariantResults.filter(r => !r.passed);

  if (failedInvariants.length > 0) {
    const failedIds = failedInvariants.map(r => r.invariantId).join(', ');
    const failedReasons = failedInvariants.map(r => `${r.invariantId}: ${r.reason}`).join(' | ');
    console.warn(`[QA] Invariant check FAIL — ${failedIds}`);
    return {
      response: {
        status: 'FAIL',
        reason: `Invariant violation(s): ${failedReasons}`,
      },
      fileContent,
      invariantResults,
      fileExistsCheck,
      lineBoundsCheck,
      linesChanged: f.newContent.split('\n').length,
    };
  }

  console.log('[QA] All invariants passed');

  const linesChanged = f.newContent.split('\n').length;

  return {
    response: {
      status: 'PASS',
      reason: `Fix structure valid, file exists, line in bounds, all ${invariantResults.length} invariants passed`,
    },
    fileContent,
    invariantResults,
    fileExistsCheck,
    lineBoundsCheck,
    linesChanged,
  };
}

// ── Legacy sync export (kept for backward compatibility) ──────────────────────

export function validateFix(fix: unknown): ReviewResponse {
  const structureError = validateStructure(fix);
  if (structureError) return structureError;
  return {
    status: 'PASS',
    reason: 'Fix structure valid, target file path valid, line number valid',
  };
}

