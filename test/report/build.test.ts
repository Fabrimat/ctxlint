import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/report/index.js';
import type { CheckResult, CheckStatus, Severity } from '../../src/types.js';

function result(
  file: string,
  line: number,
  status: CheckStatus,
  opts: { col?: number; severity?: Severity } = {},
): CheckResult {
  const col = opts.col ?? 1;
  return {
    claim: { kind: 'path', value: 'x', file, line, col, section: [], source: 'inline-code' },
    checkId: 'paths',
    status,
    ...(status === 'fail' && {
      finding: {
        file,
        line,
        col,
        checkId: 'paths' as const,
        severity: opts.severity ?? 'error',
        message: 'm',
      },
    }),
    resolvedFiles: [],
  };
}

const meta = { toolVersion: '1.2.3', durationMs: 42 };

describe('buildReport', () => {
  it('computes per-file and aggregate freshness', () => {
    const report = buildReport(
      [
        result('a.md', 1, 'pass'),
        result('a.md', 2, 'pass'),
        result('a.md', 3, 'pass'),
        result('a.md', 4, 'fail'),
        result('a.md', 5, 'unknown'),
      ],
      ['a.md'],
      meta,
    );
    expect(report.files[0]?.freshness).toBe(0.75);
    expect(report.summary).toEqual({
      files: 1,
      claims: 5,
      pass: 3,
      fail: 1,
      unknown: 1,
      errors: 1,
      warnings: 0,
      freshness: 0.75,
      durationMs: 42,
    });
    expect(report.version).toBe(1);
    expect(report.tool).toEqual({ name: 'ctxtruth', version: '1.2.3' });
  });

  it('uses null freshness when nothing is verifiable', () => {
    const report = buildReport([result('a.md', 1, 'unknown')], ['a.md', 'b.md'], meta);
    expect(report.files.map((f) => [f.file, f.freshness])).toEqual([
      ['a.md', null],
      ['b.md', null],
    ]);
    expect(report.summary.freshness).toBeNull();
  });

  it('includes files with zero claims, sorted by path', () => {
    const report = buildReport([result('b.md', 1, 'pass')], ['z.md', 'b.md', 'a.md'], meta);
    expect(report.files.map((f) => f.file)).toEqual(['a.md', 'b.md', 'z.md']);
    expect(report.files[0]?.results).toEqual([]);
    expect(report.summary.files).toBe(3);
  });

  it('sorts findings by file, line, col and counts severities', () => {
    const report = buildReport(
      [
        result('b.md', 1, 'fail'),
        result('a.md', 9, 'fail', { severity: 'warning' }),
        result('a.md', 2, 'fail', { col: 7 }),
        result('a.md', 2, 'fail', { col: 3 }),
      ],
      ['a.md', 'b.md'],
      meta,
    );
    expect(report.findings.map((f) => `${f.file}:${f.line}:${f.col}`)).toEqual([
      'a.md:2:3',
      'a.md:2:7',
      'a.md:9:1',
      'b.md:1:1',
    ]);
    expect(report.summary.errors).toBe(3);
    expect(report.summary.warnings).toBe(1);
  });
});
