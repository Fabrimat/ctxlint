import { buildReport } from '../../src/report/index.js';
import type { Baseline, CheckId, CheckResult, Report } from '../../src/types.js';

export const opts = { color: false, verbose: false };

export function pass(file = 'AGENTS.md', line = 1): CheckResult {
  return {
    claim: { kind: 'path', value: 'ok', file, line, col: 1, section: [], source: 'inline-code' },
    checkId: 'paths',
    status: 'pass',
    resolvedFiles: [],
  };
}

export interface FailOpts {
  file?: string;
  line?: number;
  col?: number;
  checkId?: CheckId;
  severity?: 'error' | 'warning';
  value?: string;
  message?: string;
  suggestion?: string;
  baseline?: Baseline;
  introducedBy?: 'code' | 'docs';
}

export function fail(o: FailOpts = {}): CheckResult {
  const file = o.file ?? 'AGENTS.md';
  const line = o.line ?? 2;
  const col = o.col ?? 3;
  const checkId = o.checkId ?? 'paths';
  return {
    claim: {
      kind: 'path',
      value: o.value ?? 'src/gone.ts',
      file,
      line,
      col,
      section: ['Setup'],
      source: 'inline-code',
    },
    checkId,
    status: 'fail',
    finding: {
      file,
      line,
      col,
      checkId,
      severity: o.severity ?? 'error',
      message: o.message ?? 'Path `src/gone.ts` does not exist',
      ...(o.suggestion !== undefined && { suggestion: o.suggestion }),
      ...(o.introducedBy !== undefined && { introducedBy: o.introducedBy }),
    },
    resolvedFiles: [],
    ...(o.baseline !== undefined && { baseline: o.baseline }),
  };
}

export function unknown(): CheckResult {
  return {
    claim: {
      kind: 'path',
      value: 'dist',
      file: 'AGENTS.md',
      line: 9,
      col: 2,
      section: [],
      source: 'inline-code',
    },
    checkId: 'paths',
    status: 'unknown',
    reason: 'gitignored',
    resolvedFiles: [],
  };
}

export const report = (results: CheckResult[], docs = ['AGENTS.md']): Report =>
  buildReport(results, docs, { toolVersion: '1.2.3', durationMs: 0 });

/** A compared report: 2 new (code, docs), 1 existing, 1 not-comparable, 1 fixed. */
export function compared(): Report {
  const r = report([
    pass(),
    fail({ line: 4, introducedBy: 'docs', baseline: 'new', message: 'Docs problem' }),
    fail({ line: 2, introducedBy: 'code', baseline: 'new', message: 'Code problem' }),
    fail({ line: 6, baseline: 'existing', message: 'Old problem' }),
    fail({ line: 8, baseline: 'not-comparable', message: 'Unknown problem' }),
  ]);
  r.comparison = {
    base: 'origin/main',
    baseSha: 'abc',
    introduced: 2,
    existing: 1,
    fixed: 1,
    notComparable: 1,
  };
  return r;
}
