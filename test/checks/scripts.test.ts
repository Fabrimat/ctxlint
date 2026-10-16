import { describe, expect, it } from 'vitest';
import { scriptsCheck } from '../../src/checks/scripts.js';
import type { CheckResult, Claim } from '../../src/types.js';
import { makeClaim, makeCtx, makeIndex } from '../helpers/repo.js';

const claim = (value: string, over: Partial<Claim> = {}) =>
  makeClaim({ kind: 'script', value, ...over });

const ctx = makeCtx(
  makeIndex({
    files: ['package.json'],
    packages: [
      { dir: '', name: 'root', scripts: { build: 'tsc', test: 'vitest' } },
      { dir: 'packages/foo', name: '@acme/foo', scripts: { dev: 'vite', lint: 'eslint' } },
      { dir: 'packages/bar', name: '@acme/bar', scripts: { gen: 'x' } },
    ],
  }),
);
const run = async (c: Claim) => (await scriptsCheck.run([c], ctx))[0] as CheckResult;

describe('implicit pnpm/yarn scripts', () => {
  const index = makeIndex({
    files: ['package.json'],
    packages: [{ dir: '', scripts: { build: 'tsc' }, deps: { vitest: '^4' } }],
  });
  const implicit = (value: string) => claim(value, { meta: { pm: 'pnpm', implicit: 'true' } });
  const one = async (c: Claim, i = index) => (await scriptsCheck.run([c], makeCtx(i)))[0];

  it('passes a dependency binary run without `run`', async () => {
    expect((await one(implicit('vitest')))?.status).toBe('pass');
  });

  it('still fails `pnpm run <binary>` and unknown names', async () => {
    const explicit = claim('vitest', { meta: { pm: 'pnpm' } });
    expect((await one(explicit))?.status).toBe('fail');
    expect((await one(implicit('buidl')))?.status).toBe('fail');
  });

  it('is unknown at a past commit, which has no installed binaries', async () => {
    const past = { ...index, depsRoot: '/head' };
    expect((await one(implicit('vite'), past))?.status).toBe('unknown');
    expect((await one(implicit('buidl'), past))?.status).toBe('fail');
  });
});

describe('scripts check', () => {
  it('passes a root script from the root doc', async () => {
    const c = claim('build');
    expect(await run(c)).toEqual({
      claim: c,
      checkId: 'scripts',
      status: 'pass',
      resolvedFiles: ['package.json'],
    });
  });

  it('uses the nearest ancestor package of the doc', async () => {
    const c = claim('dev', { file: 'packages/foo/docs/README.md' });
    expect(await run(c)).toEqual({
      claim: c,
      checkId: 'scripts',
      status: 'pass',
      resolvedFiles: ['packages/foo/package.json'],
    });
  });

  it('does not match a sibling directory with a shared prefix', async () => {
    const c = claim('build', { file: 'packages/foobar/README.md' });
    expect((await run(c)).resolvedFiles).toEqual(['package.json']);
  });

  it('filter by name, dir forms, and glob', async () => {
    for (const filter of [
      '@acme/foo',
      './packages/foo',
      'packages/foo',
      '{packages/foo}',
      '@acme/f*',
    ]) {
      expect((await run(claim('dev', { meta: { filter } }))).resolvedFiles).toEqual([
        'packages/foo/package.json',
      ]);
    }
  });

  it('unresolved filter is unknown', async () => {
    const c = claim('dev', { meta: { filter: 'ghost' } });
    expect(await run(c)).toEqual({
      claim: c,
      checkId: 'scripts',
      status: 'unknown',
      reason: 'unresolved workspace filter ghost',
      resolvedFiles: [],
    });
  });

  it('meta.dir resolves relative to the doc dir, then root', async () => {
    const a = claim('dev', { file: 'packages/README.md', meta: { dir: 'foo' } });
    expect((await run(a)).resolvedFiles).toEqual(['packages/foo/package.json']);
    const b = claim('dev', { file: 'docs/README.md', meta: { dir: 'packages/foo' } });
    expect((await run(b)).resolvedFiles).toEqual(['packages/foo/package.json']);
    const c = claim('dev', { meta: { dir: 'nowhere' } });
    expect(await run(c)).toMatchObject({ status: 'unknown', reason: 'no package at nowhere' });
  });

  it('recursive passes when any package defines the script', async () => {
    const c = claim('gen', { meta: { recursive: 'true' } });
    expect(await run(c)).toEqual({
      claim: c,
      checkId: 'scripts',
      status: 'pass',
      resolvedFiles: ['packages/bar/package.json'],
    });
  });

  it('missing in target but defined elsewhere is always a warning', async () => {
    const c = claim('dev');
    const strict = makeCtx(ctx.index, 'error');
    expect(await scriptsCheck.run([c], strict)).toEqual([
      {
        claim: c,
        checkId: 'scripts',
        status: 'fail',
        finding: {
          file: c.file,
          line: c.line,
          col: c.col,
          checkId: 'scripts',
          severity: 'warning',
          message:
            'Script `dev` is not defined in `package.json` (it is defined in `packages/foo/package.json`)',
        },
        resolvedFiles: ['package.json'],
      },
    ]);
  });

  it('is unknown in a subpackage doc for a script only the root defines', async () => {
    const c = claim('build', { file: 'packages/foo/AGENTS.md' });
    expect(await run(c)).toMatchObject({
      status: 'unknown',
      reason: 'defined in the root package; may be run from the root',
    });
  });

  it('still warns for a sibling workspace script or an explicit target', async () => {
    const sibling = claim('gen', { file: 'packages/foo/AGENTS.md' });
    expect((await run(sibling)).finding?.message).toBe(
      'Script `gen` is not defined in `packages/foo/package.json` (it is defined in `packages/bar/package.json`)',
    );
    const filtered = claim('build', { meta: { filter: '@acme/foo' } });
    expect((await run(filtered)).status).toBe('fail');
  });

  it('missing everywhere uses ctx severity and suggests a near name', async () => {
    const c = claim('biuld');
    expect(await run(c)).toEqual({
      claim: c,
      checkId: 'scripts',
      status: 'fail',
      finding: {
        file: c.file,
        line: c.line,
        col: c.col,
        checkId: 'scripts',
        severity: 'error',
        message: 'Script `biuld` is not defined in `package.json` (did you mean `build`?)',
        suggestion: 'build',
      },
      resolvedFiles: ['package.json'],
    });
  });

  it('missing everywhere without a near name has no suggestion', async () => {
    const r = await run(claim('deploy-everything'));
    expect(r.finding?.message).toBe('Script `deploy-everything` is not defined in `package.json`');
    expect(r.finding?.suggestion).toBeUndefined();
  });
});

describe('scripts check without a package.json', () => {
  it('is unknown rather than fail', async () => {
    const c = claim('build');
    const empty = makeCtx(makeIndex({ files: ['README.md'] }));
    expect(await scriptsCheck.run([c], empty)).toEqual([
      {
        claim: c,
        checkId: 'scripts',
        status: 'unknown',
        reason: 'no package.json',
        resolvedFiles: [],
      },
    ]);
  });
});
