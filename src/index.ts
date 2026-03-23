import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
dotenv.config();

import { validateFixAsync } from './validator.js';
import { ReviewRequest, ReviewResponse } from './types.js';
import { callLLM } from './llm-router.js';
import { QA_CONSTITUTION } from './qa-constitution.js';
import { INVARIANTS } from './invariants.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT ?? '8080';
const BOT_VERSION = '1.2.0';

const QDRANT_URL = process.env.QDRANT_URL || '';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';
const QA_LOGS_COLLECTION = 'qa_logs';
const DIMS = 384;

// ── Qdrant helper ─────────────────────────────────────────────────────────────

async function qdrantUpsert(payload: Record<string, unknown>): Promise<void> {
  if (!QDRANT_URL || !QDRANT_API_KEY) {
    console.warn('[QA] QDRANT_URL or QDRANT_API_KEY not set — skipping qa_logs write');
    return;
  }

  const dummyVector = Array(DIMS).fill(0);
  dummyVector[0] = 0.001;

  const id = crypto.randomUUID();

  const res = await fetch(`${QDRANT_URL}/collections/${QA_LOGS_COLLECTION}/points`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'api-key': QDRANT_API_KEY,
    },
    body: JSON.stringify({
      points: [{ id, vector: dummyVector, payload }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[QA] Qdrant upsert failed: ${res.status} ${text}`);
  }

  console.log(`[QA] qa_logs point written: ${id}`);
}

// ── LLM test instruction ──────────────────────────────────────────────────────

async function generateTestInstruction(
  fix: { file: string; line: number; action: string; newContent: string; description: string },
  fileContent: string | null
): Promise<string> {
  console.log('[QA] Generating test instruction via LLM');

  const fileSnippet = fileContent
    ? `\nRelevant file snippet around line ${fix.line}:\n${fileContent.split('\n').slice(Math.max(0, fix.line - 5), fix.line + 5).join('\n')}`
    : '';

  const prompt = `${QA_CONSTITUTION}

A fix has passed all validation checks. Generate a test instruction for John to verify it after deploy.

Fix details:
- File: ${fix.file}
- Line: ${fix.line}
- Action: ${fix.action}
- New content: ${fix.newContent}
- Description: ${fix.description}
${fileSnippet}

Respond with ONLY the test instruction — one to three sentences. No preamble, no labels, just the instruction text.`;

  try {
    const response = await callLLM({
      task: 'qa_validation',
      prompt,
      systemPrompt: 'You generate concise test instructions for engineers reviewing auto-generated fixes. One to three sentences only. Be specific about observable behaviour.',
      maxTokens: 150,
    });

    console.log(`[QA] Test instruction generated via ${response.provider}`);
    return response.text.trim();

  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.warn(`[QA] LLM test instruction failed — using default: ${e.message}`);
    return `After deploy, confirm GET /health returns HTTP 200 and check Fly logs for errors related to ${fix.file}.`;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', bot: 'openclaw-qa', version: BOT_VERSION });
});

app.post('/review', async (req: Request, res: Response): Promise<void> => {
  console.log('[QA] Received review request');

  const body = req.body as Partial<ReviewRequest>;

  if (!body.prUrl || typeof body.prUrl !== 'string') {
    const response: ReviewResponse = {
      status: 'FAIL',
      reason: 'Missing or invalid field: prUrl',
    };
    console.log(`[QA] FAIL — ${response.reason}`);
    res.status(400).json(response);
    return;
  }

  if (!body.fix) {
    const response: ReviewResponse = {
      status: 'FAIL',
      reason: 'Missing field: fix',
    };
    console.log(`[QA] FAIL — ${response.reason}`);
    res.status(400).json(response);
    return;
  }

  const timestamp = new Date().toISOString();

  try {
    const validation = await validateFixAsync(body.fix);
    const { response, fileContent, invariantResults, fileExistsCheck, lineBoundsCheck, linesChanged } = validation;

    console.log(`[QA] ${response.status} — ${response.reason}`);

    const invariantsPassed = invariantResults.filter(r => r.passed).map(r => r.invariantId);
    const invariantsFailed = invariantResults.filter(r => !r.passed).map(r => r.invariantId);
    const allInvariantIds = INVARIANTS.map(i => i.id);

    let testInstruction: string | undefined;

    if (response.status === 'PASS') {
      const fix = body.fix as { file: string; line: number; action: string; newContent: string; description: string };
      testInstruction = await generateTestInstruction(fix, fileContent);
      console.log(`[QA] Test instruction: ${testInstruction}`);
    }

    // Write QA record to qa_logs
    const fix = body.fix as Record<string, unknown>;
    const qaRecord = {
      timestamp,
      prUrl: body.prUrl,
      fixFile: String(fix['file'] ?? ''),
      fixLine: Number(fix['line'] ?? 0),
      fixAction: String(fix['action'] ?? ''),
      invariantsChecked: allInvariantIds,
      invariantsPassed,
      invariantsFailed,
      fileExistsCheck,
      lineBoundsCheck,
      linesChanged,
      result: response.status,
      failReason: response.status === 'FAIL' ? response.reason : undefined,
      testInstruction,
    };

    qdrantUpsert(qaRecord).catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.warn(`[QA] qa_logs write failed — not blocking response: ${e.message}`);
    });

    // Return response with test instruction appended if PASS
    const finalResponse: ReviewResponse = response.status === 'PASS' && testInstruction
      ? { status: 'PASS', reason: `${response.reason} | Test: ${testInstruction}` }
      : response;

    res.status(response.status === 'PASS' ? 200 : 400).json(finalResponse);

  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error(`[QA] Unexpected error in /review: ${e.message}`);
    res.status(500).json({ status: 'FAIL', reason: `Internal QA error: ${e.message}` });
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

app.listen(parseInt(PORT), '0.0.0.0', () => {
  console.log(`[QA] Boot confirmed — openclaw-qa v${BOT_VERSION}`);
  console.log(`[QA] LLM router loaded — task: qa_validation`);
  console.log(`[QA] Invariants loaded — ${INVARIANTS.length} blocking checks`);
  console.log(`[QA] Health server on port ${PORT}`);
});
