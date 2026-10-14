import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../../src/run.js';
import type { Finding } from '../../src/types.js';

const fixture = (name: string): string => resolve(import.meta.dirname, '../fixtures', name);

describe('check() on the drift fixture', () => {
  const expected: Finding[] = [
    {
      file: 'AGENTS.md',
      line: 6,
      col: 31,
      checkId: 'paths',
      severity: 'error',
      message:
        'Path `src/utils/format.ts` does not exist (did you mean `src/utils/formatting.ts`?)',
      suggestion: 'src/utils/formatting.ts',
    },
    {
      file: 'AGENTS.md',
      line: 7,
      col: 33,
      checkId: 'paths',
      severity: 'error',
      message: 'Path `src/old/config.ts` does not exist (moved to `src/config.ts`?)',
      suggestion: 'src/config.ts',
    },
    {
      file: 'AGENTS.md',
      line: 16,
      col: 10,
      checkId: 'scripts',
      severity: 'error',
      message: 'Script `typecheck` is not defined in `package.json`',
    },
    {
      file: 'AGENTS.md',
      line: 17,
      col: 9,
      checkId: 'scripts',
      severity: 'error',
      message: 'Script `buidl` is not defined in `package.json` (did you mean `build`?)',
      suggestion: 'build',
    },
    {
      file: 'AGENTS.md',
      line: 18,
      col: 6,
      checkId: 'scripts',
      severity: 'warning',
      message:
        'Script `dev` is not defined in `package.json` (it is defined in `packages/web/package.json`)',
    },
    {
      file: 'AGENTS.md',
      line: 19,
      col: 1,
      checkId: 'commands',
      severity: 'warning',
      message: 'Command `tsx` is not installed as a dependency',
    },
    {
      file: 'docs/guide.md',
      line: 5,
      col: 24,
      checkId: 'paths',
      severity: 'error',
      message: 'Path `../src/old/config.ts` does not exist (moved to `src/config.ts`?)',
      suggestion: 'src/config.ts',
    },
  ];

  it('reports exactly the known drift', async () => {
    const { report } = await check({ root: fixture('drift') });
    expect(report.findings).toEqual(expected);
  });

  it('summarises counts and per-file freshness', async () => {
    const { report } = await check({ root: fixture('drift') });
    expect(report.summary).toMatchObject({
      files: 3,
      claims: 20,
      pass: 10,
      fail: 7,
      unknown: 3,
      errors: 5,
      warnings: 2,
    });
    expect(report.summary.freshness).toBeCloseTo(10 / 17);
    expect(report.files.map((f) => [f.file, f.freshness])).toEqual([
      ['AGENTS.md', 1 / 3],
      ['CLAUDE.md', 1],
      ['docs/guide.md', 2 / 3],
    ]);
  });

  it('marks gitignored, weak and system claims as unknown with a reason', async () => {
    const { report } = await check({ root: fixture('drift') });
    const unknowns = report.files
      .flatMap((f) => f.results)
      .filter((r) => r.status === 'unknown')
      .map((r) => [r.claim.value, r.reason]);
    expect(unknowns).toEqual([
      ['dist', 'gitignored'],
      ['react-dom/client', 'not a repository path'],
      ['git', 'system binary'],
    ]);
  });

  it('does not report claims hidden by ctxtruth-ignore', async () => {
    const { report } = await check({ root: fixture('drift') });
    expect(JSON.stringify(report)).not.toContain('legacy/runner');
  });
});

describe('check() on the clean fixture', () => {
  it('finds nothing', async () => {
    const { report } = await check({ root: fixture('clean') });
    expect(report.findings).toEqual([]);
    expect(report.summary).toMatchObject({
      files: 2,
      claims: 8,
      pass: 8,
      fail: 0,
      unknown: 0,
      errors: 0,
      warnings: 0,
      freshness: 1,
    });
  });
});

describe('check() path narrowing', () => {
  const root = fixture('drift');

  it('limits the scan to a directory prefix', async () => {
    const { report } = await check({ root, paths: ['docs'], cwd: root });
    expect(report.files.map((f) => f.file)).toEqual(['docs/guide.md']);
    expect(report.findings).toHaveLength(1);
  });

  it('accepts a single file', async () => {
    const { report } = await check({ root, paths: ['CLAUDE.md'], cwd: root });
    expect(report.files.map((f) => f.file)).toEqual(['CLAUDE.md']);
    expect(report.summary.freshness).toBe(1);
  });

  it('treats an argument that matches nothing as an empty report', async () => {
    const { report } = await check({ root, paths: ['nope/'], cwd: root });
    expect(report.files).toEqual([]);
    expect(report.summary.claims).toBe(0);
  });
});
