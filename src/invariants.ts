export interface Invariant {
  id: string;
  description: string;
  severity: 'BLOCKING';
}

export const INVARIANTS: Invariant[] = [
  {
    id: 'INV-001',
    description: 'Must not remove health endpoint',
    severity: 'BLOCKING',
  },
  {
    id: 'INV-002',
    description: 'Must not swallow errors silently',
    severity: 'BLOCKING',
  },
  {
    id: 'INV-003',
    description: 'Must preserve .js extensions on local imports',
    severity: 'BLOCKING',
  },
  {
    id: 'INV-004',
    description: 'Must not change LLM model strings',
    severity: 'BLOCKING',
  },
  {
    id: 'INV-005',
    description: 'Must not remove try/catch blocks',
    severity: 'BLOCKING',
  },
  {
    id: 'INV-006',
    description: 'Minimal footprint — max 15 lines changed',
    severity: 'BLOCKING',
  },
];

export interface InvariantCheckResult {
  invariantId: string;
  description: string;
  passed: boolean;
  reason: string;
}

export function checkInvariants(
  fix: { file: string; line: number; action: string; newContent: string; description: string },
  fileContent: string | null
): InvariantCheckResult[] {
  const results: InvariantCheckResult[] = [];

  // INV-001: Must not remove health endpoint
  const removesHealth =
    fix.action === 'delete_line' &&
    fileContent !== null &&
    (() => {
      const lines = fileContent.split('\n');
      const targetLine = lines[fix.line - 1] ?? '';
      return targetLine.includes('/health') || targetLine.includes('health');
    })();

  results.push({
    invariantId: 'INV-001',
    description: INVARIANTS[0].description,
    passed: !removesHealth,
    reason: removesHealth
      ? 'Fix deletes a line containing health endpoint reference'
      : 'Health endpoint not affected',
  });

  // INV-002: Must not swallow errors silently
  const swallowsError =
    fix.newContent.includes('catch') &&
    fix.newContent.includes('{}') &&
    !fix.newContent.includes('console');

  results.push({
    invariantId: 'INV-002',
    description: INVARIANTS[1].description,
    passed: !swallowsError,
    reason: swallowsError
      ? 'Fix introduces empty catch block with no logging'
      : 'No silent error swallowing detected',
  });

  // INV-003: Must preserve .js extensions on local imports
  const removesJsExtension =
    fix.newContent.includes('from \'./') &&
    !fix.newContent.includes('.js\'') &&
    !fix.newContent.includes('.js"');

  const removesJsExtensionDouble =
    fix.newContent.includes('from "./') &&
    !fix.newContent.includes('.js"') &&
    !fix.newContent.includes(".js'");

  const violatesImport = removesJsExtension || removesJsExtensionDouble;

  results.push({
    invariantId: 'INV-003',
    description: INVARIANTS[2].description,
    passed: !violatesImport,
    reason: violatesImport
      ? 'Fix introduces local import without .js extension'
      : 'Import style preserved',
  });

  // INV-004: Must not change LLM model strings
  const modelStrings = [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
  ];

  const changesModel = modelStrings.some(
    (m) => fix.newContent.includes(m) && fix.action === 'replace_line'
  );

  // Only flag if replacing a line that already had a model string
  const replacesModelLine =
    fix.action === 'replace_line' &&
    fileContent !== null &&
    (() => {
      const lines = fileContent.split('\n');
      const targetLine = lines[fix.line - 1] ?? '';
      return modelStrings.some((m) => targetLine.includes(m));
    })();

  results.push({
    invariantId: 'INV-004',
    description: INVARIANTS[3].description,
    passed: !replacesModelLine,
    reason: replacesModelLine
      ? 'Fix replaces a line containing an LLM model string'
      : 'No model string changes detected',
  });

  // INV-005: Must not remove try/catch blocks
  const removesTryCatch =
    fix.action === 'delete_line' &&
    fileContent !== null &&
    (() => {
      const lines = fileContent.split('\n');
      const targetLine = lines[fix.line - 1] ?? '';
      return targetLine.trim() === 'try {' || targetLine.trim() === '} catch' ||
        targetLine.includes('} catch (');
    })();

  results.push({
    invariantId: 'INV-005',
    description: INVARIANTS[4].description,
    passed: !removesTryCatch,
    reason: removesTryCatch
      ? 'Fix deletes a try or catch line'
      : 'Try/catch structure preserved',
  });

  // INV-006: Minimal footprint — max 15 lines changed
  const linesChanged = fix.newContent.split('\n').length;
  const tooManyLines = linesChanged > 15;

  results.push({
    invariantId: 'INV-006',
    description: INVARIANTS[5].description,
    passed: !tooManyLines,
    reason: tooManyLines
      ? `Fix changes ${linesChanged} lines — exceeds 15 line maximum`
      : `Fix changes ${linesChanged} line(s) — within limit`,
  });

  return results;
}
