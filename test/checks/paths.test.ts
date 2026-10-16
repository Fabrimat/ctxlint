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

describe('paths check: site links and generated files', () => {
  const site = makeCtx(
    makeIndex({
      files: [
        'README.md',
        'docs/.vitepress/config.ts',
        'docs/guide/index.md',
        'docs/guide/reporters.md',
        'docs/config/pool.md',
        'site/api.md',
      ],
      sites: [{ dir: 'docs', kind: 'VitePress' }],
    }),
  );
  const link = (value: string, file: string, meta?: Record<string, string>) =>
    claim(value, { file, source: 'link', ...(meta && { meta }) });
  const run = async (c: Claim) => (await pathsCheck.run([c], site))[0];

  it('resolves an extensionless link to `<p>.md` or the directory of `<p>/index.md`', async () => {
    expect(await run(link('../guide/reporters', 'docs/config/pool.md'))).toMatchObject({
      status: 'pass',
      resolvedFiles: ['docs/guide/reporters.md'],
    });
    expect((await run(link('guide', 'docs/x.md')))?.resolvedFiles).toEqual(['docs/guide']);
  });

  it('resolves a leading `/` from the site root, else from the top-level docs dir', async () => {
    const rooted = link('config/pool', 'docs/guide/x.md', { anchor: 'root' });
    expect((await run(rooted))?.resolvedFiles).toEqual(['docs/config/pool.md']);
    const plain = makeCtx(makeIndex({ files: ['docs/config/pool.md'] }));
    const [r] = await pathsCheck.run([rooted], plain);
    expect(r?.resolvedFiles).toEqual(['docs/config/pool.md']);
  });

  it('is unknown for an unresolved site route, anywhere', async () => {
    for (const c of [
      link('config/gone', 'docs/guide/x.md', { anchor: 'root' }),
      link('logo.svg', 'docs/guide/x.md', { anchor: 'root' }),
      link('../guide/gone', 'docs/config/pool.md'),
      link('site/gone', 'README.md'),
    ]) {
      expect(await run(c), c.value).toMatchObject({ status: 'unknown', reason: 'site route' });
    }
  });

  it('still fails a missing file link with an extension, or extensionless inline code', async () => {
    expect((await run(link('docs/gone.md', 'README.md')))?.status).toBe('fail');
    expect((await run(link('logo.svg', 'README.md', { anchor: 'root' })))?.status).toBe('fail');
    expect((await run(claim('docs/guide/gone/')))?.status).toBe('fail');
  });

  it('is unknown for a missing path the docs describe as generated', async () => {
    const c = claim('docs/.vitepress/names.json', { meta: { generated: 'true' } });
    expect(await run(c)).toMatchObject({ status: 'unknown', reason: 'described as generated' });
    const there = claim('docs/.vitepress/config.ts', { meta: { generated: 'true' } });
    expect((await run(there))?.status).toBe('pass');
  });
});
