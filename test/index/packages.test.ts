import { afterEach, describe, expect, it } from 'vitest';
import { buildRepoIndex } from '../../src/index/index.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
async function index(files: Record<string, string>) {
  const r = makeTmpRepo(files, { git: true });
  cleanups.push(r.cleanup);
  return buildRepoIndex(r.dir);
}
const pkg = (o: object) => JSON.stringify(o);

describe('buildRepoIndex packages', () => {
  it('missing root package.json yields an empty root', async () => {
    const idx = await index({ 'a.txt': '' });
    expect(idx.packages.root).toEqual({ dir: '', scripts: {}, deps: {}, bins: [] });
    expect(idx.packages.all).toEqual([idx.packages.root]);
  });

  it('unions dependency fields and reads scripts and name', async () => {
    const idx = await index({
      'package.json': pkg({
        name: 'root',
        scripts: { build: 'tsc' },
        dependencies: { a: '1' },
        devDependencies: { b: '2' },
        peerDependencies: { c: '3' },
        optionalDependencies: { d: '4' },
      }),
    });
    expect(idx.packages.root).toEqual({
      dir: '',
      name: 'root',
      scripts: { build: 'tsc' },
      deps: { a: '1', b: '2', c: '3', d: '4' },
      bins: [],
    });
  });

  it('expands npm workspaces (array form)', async () => {
    const idx = await index({
      'package.json': pkg({ workspaces: ['packages/*'] }),
      'packages/a/package.json': pkg({ name: 'a' }),
      'packages/b/package.json': pkg({ name: 'b' }),
      'other/c/package.json': pkg({ name: 'c' }),
    });
    expect(idx.packages.all.map((p) => [p.dir, p.name])).toEqual([
      ['', undefined],
      ['packages/a', 'a'],
      ['packages/b', 'b'],
    ]);
  });

  it('expands npm workspaces (object form)', async () => {
    const idx = await index({
      'package.json': pkg({ workspaces: { packages: ['apps/*'] } }),
      'apps/web/package.json': pkg({ name: 'web' }),
    });
    expect(idx.packages.all.map((p) => p.dir)).toEqual(['', 'apps/web']);
  });

  it('reads pnpm-workspace.yaml with quotes and exclusions', async () => {
    const idx = await index({
      'package.json': pkg({}),
      'pnpm-workspace.yaml':
        "packages:\n  - 'packages/*'\n  - \"tools/*\"\n  - libs/*  # comment\n  - '!packages/skip'\nother: 1\n",
      'packages/a/package.json': pkg({ name: 'a' }),
      'packages/skip/package.json': pkg({ name: 'skip' }),
      'tools/t/package.json': pkg({ name: 't' }),
      'libs/l/package.json': pkg({ name: 'l' }),
    });
    expect(idx.packages.all.map((p) => p.dir)).toEqual(['', 'packages/a', 'tools/t', 'libs/l']);
  });

  it('skips workspace packages with invalid JSON', async () => {
    const idx = await index({
      'package.json': pkg({ workspaces: ['packages/*'] }),
      'packages/ok/package.json': pkg({ name: 'ok' }),
      'packages/bad/package.json': '{ nope',
    });
    expect(idx.packages.all.map((p) => p.dir)).toEqual(['', 'packages/ok']);
  });

  it('invalid root package.json yields an empty root without crashing', async () => {
    const idx = await index({ 'package.json': '{ nope' });
    expect(idx.packages.root).toEqual({ dir: '', scripts: {}, deps: {}, bins: [] });
  });

  it('reads node_modules/.bin, stripping Windows shims and deduping', async () => {
    const idx = await index({
      'package.json': pkg({}),
      'node_modules/.bin/tsc': '',
      'node_modules/.bin/tsc.cmd': '',
      'node_modules/.bin/tsc.ps1': '',
      'node_modules/.bin/vitest.exe': '',
    });
    expect([...idx.packages.root.bins].sort()).toEqual(['tsc', 'vitest']);
  });

  it('reads pnpm-workspace.yaml with a column-0 list and column-0 comments', async () => {
    const idx = await index({
      'package.json': pkg({}),
      'pnpm-workspace.yaml': [
        'packages:',
        '- "a/*"',
        '# note',
        '- b/*',
        'catalog:',
        '  x: 1',
        '',
      ].join('\n'),
      'a/one/package.json': pkg({ name: 'one' }),
      'b/two/package.json': pkg({ name: 'two' }),
    });
    expect(idx.packages.all.map((p) => p.dir)).toEqual(['', 'a/one', 'b/two']);
  });

  it('does not re-add the root for a ** workspace glob', async () => {
    const idx = await index({
      'package.json': pkg({ workspaces: ['**'] }),
      'x/package.json': pkg({ name: 'x' }),
    });
    expect(idx.packages.all.map((p) => p.dir)).toEqual(['', 'x']);
  });

  it('adds declared bin names (string form uses the unscoped name)', async () => {
    const str = await index({ 'package.json': pkg({ name: '@acme/tool', bin: './cli.js' }) });
    expect(str.packages.root.bins).toEqual(['tool']);
    const obj = await index({ 'package.json': pkg({ bin: { a: 'a.js', b: 'b.js' } }) });
    expect(obj.packages.root.bins).toEqual(['a', 'b']);
  });
});
