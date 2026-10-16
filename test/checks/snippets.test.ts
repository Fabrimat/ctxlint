import { afterEach, describe, expect, it } from 'vitest';
import { snippetsCheck } from '../../src/checks/snippets.js';
import type { Claim } from '../../src/types.js';
import { makeClaim, makeCtx, makeIndex } from '../helpers/repo.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    module: 'ESNext',
    moduleResolution: 'Bundler',
    target: 'ES2022',
  },
});
const FORMAT = 'export function formatTimestamp(t: number): string { return String(t); }\n';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

const snip = (value: string, over: Partial<Claim> = {}) =>
  makeClaim({
    kind: 'snippet',
    value,
    line: 10,
    col: 1,
    source: 'fence',
    meta: { lang: 'ts' },
    ...over,
  });

/** Runs the check over a tmp repo; `packages` are workspace package dirs/names. */
async function run(
  files: Record<string, string>,
  claims: Claim[],
  packages: { dir: string; name?: string }[] = [],
) {
  const repo = makeTmpRepo(files);
  cleanups.push(repo.cleanup);
  const index = makeIndex({ files: Object.keys(files), root: repo.dir, packages });
  return snippetsCheck.run(claims, makeCtx(index));
}

describe('snippets check', () => {
  it('returns nothing for no claims', async () => {
    expect(await snippetsCheck.run([], makeCtx(makeIndex()))).toEqual([]);
  });

  it('passes a snippet importing a relative module and lists it', async () => {
    const [r] = await run({ 'tsconfig.json': TSCONFIG, 'src/format.ts': FORMAT }, [
      snip("import { formatTimestamp } from './src/format';\nformatTimestamp(1);"),
    ]);
    expect(r?.status).toBe('pass');
    expect(r?.resolvedFiles).toEqual(['src/format.ts']);
  });

  it('fails a renamed export with a suggestion on the import line', async () => {
    const [r] = await run({ 'tsconfig.json': TSCONFIG, 'src/format.ts': FORMAT }, [
      snip("import { formatTimestmp } from './src/format';\nformatTimestmp(1);", { col: 3 }),
    ]);
    expect(r?.status).toBe('fail');
    expect(r?.finding).toMatchObject({
      line: 10,
      col: 12,
      checkId: 'snippets',
      severity: 'error',
      suggestion: 'formatTimestamp',
    });
    expect(r?.finding?.message).toContain('(TS2724)');
    expect(r?.finding?.message).toMatch(/^Snippet does not type-check: /);
    expect(r?.resolvedFiles).toEqual(['src/format.ts']);
  });

  it('positions a wrong argument count on its doc line and column', async () => {
    const code = "import { formatTimestamp } from './src/format';\n\nformatTimestamp(1, 2);";
    const [r] = await run({ 'tsconfig.json': TSCONFIG, 'src/format.ts': FORMAT }, [
      snip(code, { line: 20, col: 5 }),
    ]);
    expect(r?.status).toBe('fail');
    expect(r?.finding?.message).toContain('(TS2554)');
    expect(r?.finding).toMatchObject({ line: 22, col: 5 + 19 });
  });

  it('fails a missing module in a real dir, is unknown for an illustrative one', async () => {
    const files = { 'tsconfig.json': TSCONFIG, 'src/format.ts': FORMAT };
    const [gone, missing, illustrative, asset, external] = await run(files, [
      snip("import { a } from './src/gone';"),
      snip("import { a } from './nope';"),
      snip("import { a } from './path/to/module.js';\na(1, 2);"),
      snip("import './app.css';\nconst n: number = 1;"),
      snip("import leftPad from 'left-pad';\nleftPad('x', 3);"),
    ]);
    expect(gone?.status).toBe('fail');
    expect(gone?.finding?.message).toContain('(TS2307)');
    for (const r of [missing, illustrative]) {
      expect(r).toMatchObject({
        status: 'unknown',
        reason: 'imports an illustrative relative module',
      });
    }
    expect(asset?.status).toBe('pass');
    expect(external?.status).toBe('pass');
  });

  it('ignores undeclared names', async () => {
    const [r] = await run({ 'tsconfig.json': TSCONFIG }, [snip('createUser(name);')]);
    expect(r?.status).toBe('pass');
  });

  it('reports unknown for syntax errors, elisions and opt-outs', async () => {
    const results = await run({ 'tsconfig.json': TSCONFIG }, [
      snip('const = ;'),
      snip('function f() {\n  ...\n}'),
      snip('foo(...)'),
      snip('const a = {\n  b: 1, // ...\n};'),
      snip("import { zzz } from './nope';", { meta: { lang: 'ts', info: 'ts ignore' } }),
    ]);
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ['unknown', 'not valid TypeScript'],
      ['unknown', 'contains elision'],
      ['unknown', 'contains elision'],
      ['unknown', 'contains elision'],
      ['unknown', 'opted out'],
    ]);
  });

  it('does not treat spread as an elision', async () => {
    const [r] = await run({}, [snip('const a = [1];\nconst b = [...a];')]);
    expect(r?.status).toBe('pass');
  });

  it('resolves workspace packages from source and fails a missing export', async () => {
    const files = {
      'tsconfig.json': TSCONFIG,
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'package.json': '{"name":"root"}',
      'packages/core/package.json': JSON.stringify({
        name: '@acme/core',
        main: './dist/index.js',
        types: './dist/index.d.ts',
      }),
      'packages/core/src/index.ts': 'export const hello = 1;\n',
    };
    const pkgs = [
      { dir: '', name: 'root' },
      { dir: 'packages/core', name: '@acme/core' },
    ];
    const [ok, bad] = await run(
      files,
      [
        snip("import { hello } from '@acme/core';\nhello;"),
        snip("import { nope } from '@acme/core';"),
      ],
      pkgs,
    );
    expect(ok?.status).toBe('pass');
    expect(ok?.resolvedFiles).toEqual(['packages/core/src/index.ts']);
    expect(bad?.status).toBe('fail');
    expect(bad?.finding?.message).toContain('(TS2305)');
  });

  it('only trusts a missing export in a snippet importing a workspace package', async () => {
    const files = {
      'tsconfig.json': TSCONFIG,
      'package.json': '{"name":"root"}',
      'packages/core/package.json': JSON.stringify({
        name: '@acme/core',
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './config': { types: './config.d.ts', default: './dist/config.js' },
          './package.json': './package.json',
        },
      }),
      'packages/core/src/index.ts': 'export const expect = (v: unknown) => ({ v });\n',
      'packages/core/src/config.ts': 'export const defineConfig = (c: object) => c;\n',
      // A built-output shim: resolving to it would hide every export.
      'packages/core/config.d.ts': "export * from './dist/config.js';\n",
    };
    const pkgs = [
      { dir: '', name: 'root' },
      { dir: 'packages/core', name: '@acme/core' },
    ];
    const [merged, sub, missing] = await run(
      files,
      [
        // `.to` comes from declaration merging the source mapping cannot see.
        snip("import { expect } from '@acme/core';\nexpect(true).to.be.true;"),
        snip("import { defineConfig } from '@acme/core/config';\ndefineConfig({});"),
        snip("import { defineConfg } from '@acme/core/config';"),
      ],
      pkgs,
    );
    expect(merged).toMatchObject({
      status: 'unknown',
      reason: 'imports a workspace package; its types may be incomplete',
    });
    expect(sub?.status).toBe('pass');
    expect(sub?.resolvedFiles).toEqual(['packages/core/src/config.ts']);
    expect(missing?.status).toBe('fail');
    expect(missing?.finding?.message).toContain('(TS2724)');
  });

  it('works without a tsconfig using defaults', async () => {
    const [ok, bad] = await run({ 'src/format.ts': FORMAT }, [
      snip(
        "import { formatTimestamp } from './src/format';\nconst s: string = formatTimestamp(1);",
      ),
      snip("import { formatTimestamp } from './src/format';\nformatTimestamp();"),
    ]);
    expect(ok?.status).toBe('pass');
    expect(bad?.status).toBe('fail');
  });

  it('honours a tsconfig that extends another', async () => {
    const [r] = await run(
      {
        'tsconfig.base.json': TSCONFIG,
        'tsconfig.json': '{"extends":"./tsconfig.base.json"}',
        'src/format.ts': FORMAT,
      },
      [snip("import { formatTimestamp } from './src/format';\nformatTimestamp(1, 2);")],
    );
    expect(r?.status).toBe('fail');
  });

  it('resolves relative imports from the doc directory', async () => {
    const [r] = await run(
      { 'tsconfig.json': TSCONFIG, 'docs/a.ts': 'export const a = 1;\n', 'docs/guide.md': '' },
      [snip("import { a } from './a';\na;", { file: 'docs/guide.md' })],
    );
    expect(r?.status).toBe('pass');
    expect(r?.resolvedFiles).toEqual(['docs/a.ts']);
  });

  it('keeps snippets in one doc independent', async () => {
    const results = await run({}, [
      snip('const x = 1;\nx;', { line: 5 }),
      snip("const x = 'a';\nx;", { line: 15 }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['pass', 'pass']);
  });

  it('handles tsx snippets', async () => {
    const [ok, bad] = await run({}, [
      snip('const el = <div className="a">hi</div>;\nel;', { meta: { lang: 'tsx' } }),
      snip('const f = (n: number) => <b>{n}</b>;\nf(1, 2);', { meta: { lang: 'tsx' } }),
    ]);
    expect(ok?.status).toBe('pass');
    expect(bad?.status).toBe('fail');
  });

  it('reports the count of further drift diagnostics', async () => {
    const [r] = await run({ 'src/format.ts': FORMAT }, [
      snip("import { a, b } from './src/format';"),
    ]);
    expect(r?.finding?.message).toContain('(+1 more)');
  });
});
