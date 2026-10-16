import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../../src/run.js';
import { formatReport } from '../../src/report/index.js';
import { compared, fail, opts, pass, report, unknown } from './make.js';

describe('agent format', () => {
  it('reports a clean run', () => {
    expect(formatReport(report([pass(), pass()]), 'agent', opts)).toBe(
      'ctxtruth: no stale claims (2 claims verified). The docs checked are consistent with the code.\n',
    );
  });

  it('phrases suggestions per check', () => {
    const r = report([
      fail({ line: 2, suggestion: 'src/new.ts', message: 'm1' }),
      fail({ line: 3, checkId: 'scripts', value: 'buidl', suggestion: 'build', message: 'm2' }),
      fail({
        line: 4,
        checkId: 'symbols',
        severity: 'warning',
        value: 'fo',
        suggestion: 'foo',
        message: 'm3',
      }),
      fail({ line: 5, checkId: 'versions', value: 'zod@3', suggestion: 'zod@4', message: 'm4' }),
      fail({ line: 6, message: 'm5' }),
    ]);
    expect(formatReport(r, 'agent', opts)).toBe(
      [
        'ctxtruth: 5 stale claims in 1 file. These facts were verified against the repository; trust them over the docs.',
        'AGENTS.md:2:3 [error paths] m1 → replace `src/gone.ts` with `src/new.ts`',
        'AGENTS.md:3:3 [error scripts] m2 → replace script `buidl` with `build`',
        'AGENTS.md:4:3 [warning symbols] m3 → replace `fo` with `foo`',
        'AGENTS.md:5:3 [error versions] m4 → replace `zod@3` with `zod@4`',
        'AGENTS.md:6:3 [error paths] m5',
        'To fix: edit the docs at the positions above using the → replacements; re-run `ctxtruth check` to confirm.',
        '',
      ].join('\n'),
    );
  });

  it('hides existing and not-comparable results and tags code changes', () => {
    expect(formatReport(compared(), 'agent', opts)).toBe(
      [
        'ctxtruth: 2 stale claims in 1 file. These facts were verified against the repository; trust them over the docs.',
        '(code change) AGENTS.md:2:3 [error paths] Code problem',
        'AGENTS.md:4:3 [error paths] Docs problem',
        'To fix: edit the docs at the positions above so they match the repository; re-run `ctxtruth check` to confirm.',
        '',
      ].join('\n'),
    );
  });

  it('lists unknown claims only when verbose', () => {
    const r = report([pass(), unknown()]);
    expect(formatReport(r, 'agent', { ...opts, verbose: true })).toBe(
      [
        'ctxtruth: no stale claims (1 claim verified). The docs checked are consistent with the code.',
        'AGENTS.md:9 [unknown path] dist: gitignored',
        '',
      ].join('\n'),
    );
    expect(formatReport(r, 'agent', opts)).not.toContain('unknown');
  });

  it('formats the drift fixture', async () => {
    const { report: r } = await check({ root: resolve('test/fixtures/drift') });
    const lines = formatReport(r, 'agent', opts).split('\n');
    expect(lines[0]).toBe(
      'ctxtruth: 10 stale claims in 2 files. These facts were verified against the repository; trust them over the docs.',
    );
    expect(lines).toContain(
      'AGENTS.md:17:9 [error scripts] Script `buidl` is not defined in `package.json` (did you mean `build`?) → replace script `buidl` with `build`',
    );
    expect(lines).toContain(
      'AGENTS.md:33:28 [warning versions] Docs say `zod@3` but `package.json` requires `^4.1.0` → replace `zod@3` with `zod@4`',
    );
    expect(lines).toHaveLength(13);
  });
});
