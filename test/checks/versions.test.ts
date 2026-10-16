import { afterEach, describe, expect, it } from 'vitest';
import { versionsCheck } from '../../src/checks/versions.js';
import type { CheckResult, Claim, PackageInfo } from '../../src/types.js';
import { makeClaim, makeCtx, makeIndex } from '../helpers/repo.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

type Pkg = Partial<PackageInfo> & { dir: string };

/** Runs a claim `pkg@range` against packages (and optional on-disk files for installed versions). */
async function run(
  value: string,
  packages: Pkg[],
  opts: { file?: string; disk?: Record<string, string> } = {},
): Promise<CheckResult> {
  const cut = value.lastIndexOf('@');
  const claim: Claim = makeClaim({
    kind: 'version',
    value,
    file: opts.file ?? 'README.md',
    meta: { pkg: value.slice(0, cut), range: value.slice(cut + 1) },
  });
  const index = makeIndex({ files: ['package.json'], packages });
  if (opts.disk) {
    const r = makeTmpRepo(opts.disk);
    cleanups.push(r.cleanup);
    index.root = r.dir;
  }
  return (await versionsCheck.run([claim], makeCtx(index, 'warning')))[0] as CheckResult;
}

const root = (deps: Record<string, string>): Pkg[] => [{ dir: '', deps }];
const installed = (version: string) => ({
  'node_modules/zod/package.json': JSON.stringify({ version }),
});

describe('versions check: declared only', () => {
  it('passes when the ranges intersect', async () => {
    const r = await run('zod@3', root({ zod: '^3.22.0' }));
    expect(r.status).toBe('pass');
    expect(r.resolvedFiles).toEqual(['package.json']);
  });

  it('fails with the manifest and a same-precision suggestion', async () => {
    const r = await run('zod@3', root({ zod: '^4.0.0' }));
    expect(r.status).toBe('fail');
    expect(r.finding).toMatchObject({
      severity: 'warning',
      message: 'Docs say `zod@3` but `package.json` requires `^4.0.0`',
      suggestion: 'zod@4',
    });
  });

  it('names the declaring workspace package.json', async () => {
    const r = await run('zod@3', [{ dir: '' }, { dir: 'packages/web', deps: { zod: '^4.0.0' } }], {
      file: 'packages/web/README.md',
    });
    expect(r.finding?.message).toContain('`packages/web/package.json` requires');
    expect(r.resolvedFiles).toEqual(['packages/web/package.json']);
  });

  it('falls back to any package declaring the dependency', async () => {
    const r = await run('zod@4', [{ dir: '' }, { dir: 'packages/web', deps: { zod: '^4.0.0' } }]);
    expect(r.status).toBe('pass');
    expect(r.resolvedFiles).toEqual(['packages/web/package.json']);
  });

  it('prefers the nearest package over another declarer', async () => {
    const pkgs = [
      { dir: '', deps: { zod: '^3.0.0' } },
      { dir: 'packages/web', deps: { zod: '^4.0.0' } },
    ];
    expect((await run('zod@4', pkgs, { file: 'packages/web/README.md' })).status).toBe('pass');
    expect((await run('zod@3', pkgs)).status).toBe('pass');
  });

  it('is unknown when nothing declares or installs it', async () => {
    const r = await run('zod@3', root({ react: '^18' }));
    expect(r).toMatchObject({ status: 'unknown', reason: 'not a dependency' });
  });

  it.each(['workspace:*', 'catalog:', 'link:../zod', 'file:../zod', 'github:a/b', 'npm:other@^1'])(
    'is unknown for the specifier %s',
    async (spec) => {
      const r = await run('zod@3', root({ zod: spec }));
      expect(r).toMatchObject({ status: 'unknown', reason: 'non-semver specifier' });
    },
  );
});

describe('versions check: installed version', () => {
  it('passes when the installed version satisfies the claim', async () => {
    const r = await run('zod@3.22', root({ zod: '^4.0.0' }), { disk: installed('3.22.4') });
    expect(r.status).toBe('pass');
  });

  it('is unknown for installed but undeclared (transitive) packages', async () => {
    const r = await run('zod@3', [{ dir: '' }], { disk: installed('3.22.4') });
    expect(r).toMatchObject({ status: 'unknown', reason: 'not a dependency' });
  });

  it('passes when any declaring package passes (monorepo fallback)', async () => {
    const pkgs = [
      { dir: '' },
      { dir: 'a', deps: { react: '^19.0.0' } },
      { dir: 'b', deps: { react: '^18.0.0' } },
    ];
    const r = await run('react@18', pkgs);
    expect(r.status).toBe('pass');
    expect(r.resolvedFiles).toEqual(['b/package.json']);
    const bad = await run('react@17', pkgs);
    expect(bad.status).toBe('fail');
    expect(bad.finding?.message).toContain('`a/package.json`');
  });

  it('fails with the installed version and declared range', async () => {
    const r = await run('zod@3', root({ zod: '^4.0.0' }), { disk: installed('4.1.2') });
    expect(r.finding).toMatchObject({
      message: 'Docs say `zod@3` but `4.1.2` is installed (package.json: `^4.0.0`)',
      suggestion: 'zod@4',
    });
  });

  it('beats a non-semver specifier', async () => {
    const r = await run('zod@4', root({ zod: 'workspace:*' }), { disk: installed('4.1.2') });
    expect(r.status).toBe('pass');
  });

  it('reports the lockfile as a resolved file, not node_modules', async () => {
    const lock = JSON.stringify({ packages: { 'node_modules/zod': { version: '4.1.2' } } });
    const r = await run('zod@3', root({ zod: '^4' }), { disk: { 'package-lock.json': lock } });
    expect(r.status).toBe('fail');
    expect(r.resolvedFiles).toEqual(['package.json', 'package-lock.json']);
    const ok = await run('zod@4', root({ zod: '^4' }), { disk: installed('4.1.2') });
    expect(ok.resolvedFiles).toEqual(['package.json']);
  });

  it('counts prereleases as satisfying', async () => {
    const r = await run('zod@4.0.0-beta.1', root({ zod: '^4.0.0-beta' }), {
      disk: installed('4.0.0-beta.1'),
    });
    expect(r.status).toBe('pass');
  });
});

describe('versions check: suggestion precision', () => {
  it.each([
    ['zod@3', 'zod@4'],
    ['zod@3.22', 'zod@4.1'],
    ['zod@3.22.4', 'zod@4.1.2'],
    ['zod@^3.22', 'zod@^4.1'],
    ['zod@~3.22.1', 'zod@~4.1.2'],
    ['zod@3.x', 'zod@4.x'],
    ['zod@3.22.x', 'zod@4.1.x'],
  ])('%s -> %s', async (claim, suggestion) => {
    const r = await run(claim, root({ zod: '^4.0.0' }), { disk: installed('4.1.2') });
    expect(r.finding?.suggestion).toBe(suggestion);
  });

  it('uses the minimum of the declared range without an install', async () => {
    const r = await run('zod@^3.22', root({ zod: '^4.1.0' }));
    expect(r.finding?.suggestion).toBe('zod@^4.1');
  });

  it.each(['zod@>=3 <3.5', 'zod@3.22.4-beta.1', 'zod@3 || 4'])(
    'omits the suggestion for %s',
    async (claim) => {
      const r = await run(claim, root({ zod: '^5.0.0' }));
      expect(r.status).toBe('fail');
      expect(r.finding?.suggestion).toBeUndefined();
    },
  );
});

describe('versions check: bounds', () => {
  it('is unknown for a version stated as a bound or another version', async () => {
    const claim: Claim = makeClaim({
      kind: 'version',
      value: 'zod@3',
      meta: { pkg: 'zod', range: '3', bound: 'true' },
    });
    const index = makeIndex({ files: ['package.json'], packages: root({ zod: '^4.0.0' }) });
    const [r] = await versionsCheck.run([claim], makeCtx(index));
    expect(r).toMatchObject({ status: 'unknown', reason: 'a bound or another version' });
  });
});
