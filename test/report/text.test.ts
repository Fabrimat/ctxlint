import { describe, expect, it } from 'vitest';
import { formatJson, formatReport, formatText } from '../../src/report/index.js';
import type { CheckResult, Report } from '../../src/types.js';

const plain = { color: false, verbose: false };

function pass(file: string, line: number): CheckResult {
  return {
    claim: { kind: 'path', value: 'ok', file, line, col: 1, section: [], source: 'inline-code' },
    checkId: 'paths',
    status: 'pass',
    resolvedFiles: [],
  };
}

function fail(
  file: string,
  line: number,
  col: number,
  severity: 'error' | 'warning',
  checkId: 'paths' | 'commands',
  message: string,
  suggestion?: string,
): CheckResult {
  return {
    claim: { kind: 'path', value: 'bad', file, line, col, section: [], source: 'inline-code' },
    checkId,
    status: 'fail',
    finding: { file, line, col, checkId, severity, message, ...(suggestion && { suggestion }) },
    resolvedFiles: [],
  };
}

function unknown(file: string, line: number, col: number): CheckResult {
  return {
    claim: { kind: 'symbol', value: 'Foo.bar', file, line, col, section: [], source: 'prose' },
    checkId: 'symbols',
    status: 'unknown',
    reason: 'no matching export found',
    resolvedFiles: [],
  };
}

function makeReport(
  files: Record<string, CheckResult[]>,
  summary: Partial<Report['summary']> = {},
): Report {
  const entries = Object.entries(files);
  const all = entries.flatMap(([, rs]) => rs);
  const p = all.filter((r) => r.status === 'pass').length;
  const f = all.filter((r) => r.status === 'fail').length;
  const findings = all.flatMap((r) => (r.finding ? [r.finding] : []));
  return {
    version: 1,
    tool: { name: 'ctxtruth', version: '0.0.0' },
    files: entries.map(([file, results]) => {
      const fp = results.filter((r) => r.status === 'pass').length;
      const ff = results.filter((r) => r.status === 'fail').length;
      return { file, freshness: fp + ff === 0 ? null : fp / (fp + ff), results };
    }),
    findings,
    summary: {
      files: entries.length,
      claims: all.length,
      pass: p,
      fail: f,
      unknown: all.filter((r) => r.status === 'unknown').length,
      errors: findings.filter((x) => x.severity === 'error').length,
      warnings: findings.filter((x) => x.severity === 'warning').length,
      freshness: p + f === 0 ? null : p / (p + f),
      durationMs: 34,
      ...summary,
    },
  };
}

describe('formatText', () => {
  it('formats findings with a suggestion', () => {
    const report = makeReport({
      'AGENTS.md': [
        pass('AGENTS.md', 1),
        pass('AGENTS.md', 2),
        pass('AGENTS.md', 3),
        pass('AGENTS.md', 4),
        fail(
          'AGENTS.md',
          12,
          5,
          'error',
          'paths',
          'Path `src/foo.ts` does not exist (moved to `src/bar.ts`?)',
          'src/bar.ts',
        ),
        unknown('AGENTS.md', 40, 1),
        unknown('AGENTS.md', 41, 1),
      ],
    });
    // Keep the sample from the brief: one error, one warning.
    report.files[0]?.results.push(
      fail(
        'AGENTS.md',
        30,
        3,
        'warning',
        'commands',
        'Command `tsx` is not installed as a dependency',
      ),
    );
    report.summary.warnings = 1;
    report.summary.claims = 8;
    report.summary.fail = 2;
    report.summary.freshness = 4 / 6;
    if (report.files[0]) report.files[0].freshness = 4 / 6;
    expect(formatText(report, plain)).toBe(
      [
        'AGENTS.md  freshness 67% (4/6)',
        '  12:5  error    Path `src/foo.ts` does not exist (moved to `src/bar.ts`?)  paths',
        '                 suggestion: src/bar.ts',
        '  30:3  warning  Command `tsx` is not installed as a dependency             commands',
        '',
        '✖ 1 error, 1 warning · 8 claims · 4 verified · 2 unknown · freshness 67% · 34 ms',
        '',
      ].join('\n'),
    );
  });

  it('lists several files and omits clean ones', () => {
    const report = makeReport({
      'a.md': [fail('a.md', 1, 1, 'error', 'paths', 'one')],
      'b.md': [pass('b.md', 1)],
      'c.md': [pass('c.md', 1), fail('c.md', 10, 20, 'warning', 'commands', 'two')],
    });
    expect(formatText(report, plain)).toBe(
      [
        'a.md  freshness 0% (0/1)',
        '  1:1  error  one  paths',
        '',
        'c.md  freshness 50% (1/2)',
        '  10:20  warning  two  commands',
        '',
        '✖ 1 error, 1 warning · 4 claims · 2 verified · 0 unknown · freshness 50% · 34 ms',
        '',
      ].join('\n'),
    );
  });

  it('aligns columns within a file block', () => {
    const report = makeReport({
      'a.md': [
        fail('a.md', 3, 1, 'error', 'paths', 'short'),
        fail('a.md', 120, 14, 'warning', 'commands', 'much longer message'),
      ],
    });
    expect(formatText(report, plain).split('\n').slice(1, 3)).toEqual([
      '  3:1     error    short                paths',
      '  120:14  warning  much longer message  commands',
    ]);
  });

  it('lists unknown results in verbose mode', () => {
    const report = makeReport({
      'a.md': [
        pass('a.md', 1),
        unknown('a.md', 7, 2),
        fail('a.md', 9, 1, 'error', 'paths', 'gone'),
      ],
      'b.md': [unknown('b.md', 3, 4)],
    });
    expect(formatText(report, { color: false, verbose: true })).toBe(
      [
        'a.md  freshness 50% (1/2)',
        '  7:2  unknown  symbol `Foo.bar` — no matching export found',
        '  9:1  error    gone                                         paths',
        '',
        'b.md  freshness n/a (0/0)',
        '  3:4  unknown  symbol `Foo.bar` — no matching export found',
        '',
        '✖ 1 error · 4 claims · 1 verified · 2 unknown · freshness 50% · 34 ms',
        '',
      ].join('\n'),
    );
  });

  it('hides unknown results when not verbose', () => {
    const report = makeReport({ 'a.md': [pass('a.md', 1), unknown('a.md', 7, 2)] });
    expect(formatText(report, plain)).not.toContain('unknown  symbol');
  });

  it('formats a clean run', () => {
    const report = makeReport({ 'a.md': [pass('a.md', 1), unknown('a.md', 2, 1)] });
    expect(formatText(report, plain)).toBe(
      '✔ No drift found · 2 claims · 1 verified · 1 unknown · freshness 100% · 34 ms\n',
    );
  });

  it('prints freshness n/a when null', () => {
    const report = makeReport({ 'a.md': [] });
    expect(formatText(report, plain)).toBe(
      '✔ No drift found · 0 claims · 0 verified · 0 unknown · freshness n/a · 34 ms\n',
    );
  });

  it('pluralises counts', () => {
    const report = makeReport({
      'a.md': [
        fail('a.md', 1, 1, 'error', 'paths', 'x'),
        fail('a.md', 2, 1, 'error', 'paths', 'y'),
        fail('a.md', 3, 1, 'warning', 'commands', 'z'),
      ],
    });
    expect(formatText(report, plain)).toContain('✖ 2 errors, 1 warning · 3 claims');
    const single = makeReport({ 'a.md': [pass('a.md', 1)] });
    expect(formatText(single, plain)).toContain('1 claim ·');
  });

  it('emits no ANSI escapes when color is off, and some when on', () => {
    const report = makeReport({ 'a.md': [fail('a.md', 1, 1, 'error', 'paths', 'x', 's')] });
    expect(formatText(report, plain)).not.toContain('\u001b');
    expect(formatText(report, { color: true, verbose: false })).toContain('\u001b');
  });
});

describe('formatJson / formatReport', () => {
  it('pretty prints with a trailing newline', () => {
    const report = makeReport({ 'a.md': [] });
    const json = formatJson(report);
    expect(json.endsWith('}\n')).toBe(true);
    expect(json).toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(JSON.parse(json)).toEqual(report);
  });

  it('dispatches on format', () => {
    const report = makeReport({ 'a.md': [] });
    expect(formatReport(report, 'json', plain)).toBe(formatJson(report));
    expect(formatReport(report, 'text', plain)).toBe(formatText(report, plain));
  });
});
