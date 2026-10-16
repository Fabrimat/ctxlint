import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FORMATS, formatReport } from '../../src/report/index.js';
import { check } from '../../src/run.js';
import { makeTmpRepo } from '../helpers/tmp.js';
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
      col: 11,
      checkId: 'commands',
      severity: 'warning',
      message: 'Command `tsx` is not installed as a dependency',
    },
    {
      file: 'AGENTS.md',
      line: 31,
      col: 31,
      checkId: 'symbols',
      severity: 'warning',
      message:
        'Symbol `formatTimeStamp` is not defined in the codebase (did you mean `formatTimestamp`?)',
      suggestion: 'formatTimestamp',
    },
    {
      file: 'AGENTS.md',
      line: 32,
      col: 9,
      checkId: 'symbols',
      severity: 'warning',
      message: '`Config` has no member `reload`',
    },
    {
      file: 'AGENTS.md',
      line: 33,
      col: 28,
      checkId: 'versions',
      severity: 'warning',
      message: 'Docs say `zod@3` but `package.json` requires `^4.1.0`',
      suggestion: 'zod@4',
    },
    {
      file: 'AGENTS.md',
      line: 38,
      col: 29,
      checkId: 'snippets',
      severity: 'error',
      message: 'Snippet does not type-check: Expected 1 arguments, but got 2. (TS2554)',
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
      claims: 24,
      pass: 10,
      fail: 11,
      unknown: 3,
      errors: 6,
      warnings: 5,
    });
    expect(report.summary.freshness).toBeCloseTo(10 / 21);
    expect(report.files.map((f) => [f.file, f.freshness])).toEqual([
      ['AGENTS.md', 3 / 13],
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
      claims: 11,
      pass: 11,
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

describe('check() on a repo with a documentation site', () => {
  const files = {
    'package.json': '{"name":"site-repo"}',
    'README.md': 'See `src/gone.ts`.\n',
    'src/index.ts': '',
    'docs/.vitepress/config.ts': 'export default {};\n',
    'docs/guide.md': 'Create `./examples/simple` first, then open `src/missing.ts`.\n',
    'docs/api.md': 'See `src/missing.ts`.\n',
    'docs/AGENTS.md': 'Edit `docs/nope.ts`.\n',
  };
  const cleanups: (() => void)[] = [];
  afterEach(() => cleanups.splice(0).forEach((c) => c()));
  const repo = (extra: Record<string, string> = {}) => {
    const r = makeTmpRepo({ ...files, ...extra });
    cleanups.push(r.cleanup);
    return r.dir;
  };

  it('skips the site pages by default but keeps its agent files, and says so', async () => {
    const { report } = await check({ root: repo() });
    expect(report.files.map((f) => f.file)).toEqual(['README.md', 'docs/AGENTS.md']);
    expect(report.findings.map((f) => f.file)).toEqual(['README.md', 'docs/AGENTS.md']);
    expect(report.skipped).toEqual([{ dir: 'docs', reason: 'VitePress site', files: 2 }]);
    const line = 'skipped docs/ (VitePress site, 2 files); add it to `targets` to check it';
    // JSON carries the structured `skipped` field instead.
    for (const format of FORMATS.filter((f) => f !== 'json')) {
      expect(formatReport(report, format, { color: false, verbose: false }), format).toContain(
        line,
      );
    }
  });

  it('checks the site pages when the config names them', async () => {
    const config = { 'ctxtruth.config.json': '{"targets":["docs/**/*.md"]}' };
    const { report } = await check({ root: repo(config) });
    expect(report.files.map((f) => f.file)).toEqual([
      'docs/AGENTS.md',
      'docs/api.md',
      'docs/guide.md',
    ]);
    expect(report.skipped).toBeUndefined();
  });
});

describe('check() on historical records', () => {
  it('skips decision records and release notes by default', async () => {
    const r = makeTmpRepo({
      'docs/adrs/001-x.md': 'Uses `src/old.ts`.\n',
      'docs/releases/v1.md': 'Adds `src/new.ts`.\n',
      'docs/guide.md': 'Hi.\n',
      'docs/adrs/AGENTS.md': 'Hi.\n',
    });
    try {
      const { report } = await check({ root: r.dir });
      expect(report.files.map((f) => f.file)).toEqual(['docs/adrs/AGENTS.md', 'docs/guide.md']);
      expect(report.skipped).toEqual([
        { dir: 'docs/adrs', reason: 'decision records', files: 1 },
        { dir: 'docs/releases', reason: 'release notes', files: 1 },
      ]);
    } finally {
      r.cleanup();
    }
  });
});
