import { afterEach, describe, expect, it } from 'vitest';
import { pathsCheck } from '../../src/checks/paths.js';
import type { Claim } from '../../src/types.js';
import { makeClaim, makeCtx, makeIndex } from '../helpers/repo.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const claim = (value: string, over: Partial<Claim> = {}) =>
  makeClaim({ kind: 'path', value, ...over });
const finding = (c: Claim, message: string, suggestion?: string) => ({
  file: c.file,
  line: c.line,
  col: c.col,
  checkId: 'paths',
  severity: 'error',
  message,
  ...(suggestion ? { suggestion } : {}),
});

const files = [
  'README.md',
  'src/index.ts',
  'src/util/helpers.ts',
  'docs/guide.md',
  'docs/src/only.ts',
];
const ctx = makeCtx(makeIndex({ files }));

describe('paths check', () => {
  it('passes an existing file relative to the root', async () => {
    const c = claim('src/index.ts');
    expect(await pathsCheck.run([c], ctx)).toEqual([
      { claim: c, checkId: 'paths', status: 'pass', resolvedFiles: ['src/index.ts'] },
    ]);
  });

  it('prefers the doc-relative resolution', async () => {
    const c = claim('src/only.ts', { file: 'docs/guide.md' });
    expect((await pathsCheck.run([c], ctx))[0]?.resolvedFiles).toEqual(['docs/src/only.ts']);
  });

  it('falls back to the repo root', async () => {
    const c = claim('src/index.ts', { file: 'docs/guide.md' });
    expect((await pathsCheck.run([c], ctx))[0]?.resolvedFiles).toEqual(['src/index.ts']);
  });

  it('anchor=root skips doc-relative resolution', async () => {
    const c = claim('src/only.ts', { file: 'docs/guide.md', meta: { anchor: 'root' } });
    const [r] = await pathsCheck.run([c], ctx);
    expect(r?.status).toBe('fail');
    expect(r?.resolvedFiles).toEqual(['src/only.ts']);
  });

  it('passes directories, and dir=true requires one', async () => {
    const d = claim('src/util/');
    expect((await pathsCheck.run([d], ctx))[0]?.status).toBe('pass');
    const f = claim('src/index.ts', { meta: { dir: 'true' } });
    expect((await pathsCheck.run([f], ctx))[0]?.status).toBe('fail');
  });

  it('escaping the repo is unknown', async () => {
    const c = claim('../../etc/passwd', { file: 'docs/guide.md' });
    expect(await pathsCheck.run([c], ctx)).toEqual([
      {
        claim: c,
        checkId: 'paths',
        status: 'unknown',
        reason: 'outside repository',
        resolvedFiles: [],
      },
    ]);
  });

  it('suggests the single moved file by basename', async () => {
    const c = claim('lib/helpers.ts');
    expect(await pathsCheck.run([c], ctx)).toEqual([
      {
        claim: c,
        checkId: 'paths',
        status: 'fail',
        finding: finding(
          c,
          'Path `lib/helpers.ts` does not exist (moved to `src/util/helpers.ts`?)',
          'src/util/helpers.ts',
        ),
        resolvedFiles: ['lib/helpers.ts'],
      },
    ]);
  });

  it('suggests the closest path of the same extension', async () => {
    const c = claim('src/indx.ts');
    expect(await pathsCheck.run([c], ctx)).toEqual([
      {
        claim: c,
        checkId: 'paths',
        status: 'fail',
        finding: finding(
          c,
          'Path `src/indx.ts` does not exist (did you mean `src/index.ts`?)',
          'src/index.ts',
        ),
        resolvedFiles: ['src/indx.ts'],
      },
    ]);
  });

  it('does not suggest an ambiguous basename or a distant path, and uses ctx severity', async () => {
    const amb = makeCtx(makeIndex({ files: ['a/x.ts', 'b/x.ts'] }), 'warning');
    const c = claim('zzzzzzzzzz/x.ts');
    const [r] = await pathsCheck.run([c], amb);
    expect(r?.finding).toEqual({
      ...finding(c, 'Path `zzzzzzzzzz/x.ts` does not exist'),
      severity: 'warning',
    });
  });
});

describe('paths check: gitignored', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it('reports ignored missing paths as unknown, others as fail', async () => {
    const repo = makeTmpRepo(
      { '.gitignore': 'dist/\n.env\ncoverage/\n', 'a.txt': '' },
      { git: true },
    );
    cleanups.push(repo.cleanup);
    const c = makeCtx(makeIndex({ files: ['.gitignore', 'a.txt'], root: repo.dir }));
    const ignoredClaims = [
      claim('dist/'),
      claim('dist/main.js'),
      claim('.env'),
      claim('coverage/lcov.info'),
    ];
    const missing = claim('nope.txt');
    const results = await pathsCheck.run([...ignoredClaims, missing], c);
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ['unknown', 'gitignored'],
      ['unknown', 'gitignored'],
      ['unknown', 'gitignored'],
      ['unknown', 'gitignored'],
      ['fail', undefined],
    ]);
  });

  it('returns unknown for weak claims whose first segment is not a directory', async () => {
    const c = claim('react-dom/client', { meta: { shape: 'weak' } });
    expect(await pathsCheck.run([c], ctx)).toEqual([
      {
        claim: c,
        checkId: 'paths',
        status: 'unknown',
        reason: 'not a repository path',
        resolvedFiles: [],
      },
    ]);
  });

  it('verifies weak claims anchored in an existing directory', async () => {
    const ok = claim('src/util', { meta: { shape: 'weak' } });
    const bad = claim('src/gone', { meta: { shape: 'weak' } });
    const [r1, r2] = await pathsCheck.run([ok, bad], ctx);
    expect(r1?.status).toBe('pass');
    expect(r2?.finding?.message).toBe('Path `src/gone` does not exist');
  });

  it('passes a bare filename that exists anywhere in the repo', async () => {
    const c = claim('helpers.ts');
    expect(await pathsCheck.run([c], ctx)).toEqual([
      { claim: c, checkId: 'paths', status: 'pass', resolvedFiles: ['src/util/helpers.ts'] },
    ]);
  });

  it('suggests a sibling whose name extends the missing stem', async () => {
    const c = claim('src/util/help.ts');
    const [r] = await pathsCheck.run([c], ctx);
    expect(r?.finding).toEqual(
      finding(
        c,
        'Path `src/util/help.ts` does not exist (did you mean `src/util/helpers.ts`?)',
        'src/util/helpers.ts',
      ),
    );
  });
});
