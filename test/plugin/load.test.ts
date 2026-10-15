import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/index.js';
import { load } from '../../src/run.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const repos: ReturnType<typeof makeTmpRepo>[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

const plugin = (body: string) => `export default ${body};\n`;
const ok = (name = 'demo', extra = '') =>
  plugin(
    `{ name: '${name}', apiVersion: 1, checks: [{ id: '${name}/one', match: { inlineCode: /^x/ }, verify: (c) => c.map(() => ({ status: 'pass' })) }${extra}] }`,
  );

function setup(files: Record<string, string>, config: unknown) {
  const r = makeTmpRepo({ ...files, 'ctxtruth.config.json': JSON.stringify(config) });
  repos.push(r);
  return r.dir;
}

describe('plugin loading', () => {
  it('resolves relative paths and package names, calls factories with options', async () => {
    const dir = setup(
      {
        'cfg/local.mjs': ok('local'),
        'node_modules/ctxtruth-pkg/package.json': JSON.stringify({
          name: 'ctxtruth-pkg',
          exports: { '.': { default: './main.mjs' } },
        }),
        'node_modules/ctxtruth-pkg/main.mjs': plugin(
          `(o) => ({ name: 'pkg', apiVersion: 1, checks: [{ id: 'pkg/' + o.id, defaultSeverity: 'error', match: {}, verify: () => [] }] })`,
        ),
      },
      {
        plugins: ['./cfg/local.mjs', ['ctxtruth-pkg', { id: 'opt' }]],
        rules: { 'local/one': 'off' },
      },
    );
    const loaded = await load(dir, {});
    expect(loaded.checks.slice(-2).map((c) => c.id)).toEqual(['local/one', 'pkg/opt']);
    expect(loaded.config.rules).toMatchObject({ 'local/one': 'off', 'pkg/opt': 'error' });
    // An `off` check still adopts its claims.
    expect(loaded.parse.matchers?.map((m) => m.id)).toEqual(['local/one', 'pkg/opt']);
  });

  it.each([
    [
      'apiVersion',
      plugin(`{ name: 'p', apiVersion: 2, checks: [] }`),
      /apiVersion 2 is not supported/,
    ],
    ['name', plugin(`{ name: 'P!', apiVersion: 1, checks: [] }`), /name must match/],
    [
      'namespace',
      ok('p').replace("id: 'p/one'", "id: 'q/one'"),
      /check id `q\/one` must be `p\/<check>`/,
    ],
    ['flags', ok('p').replace('/^x/', '/^x/g'), /must not use the g or y flag/],
    ['verify', ok('p').replace('verify:', 'nope:'), /verify must be a function/],
    [
      'duplicates',
      ok('p', `, { id: 'p/one', match: {}, verify: () => [] }`),
      /duplicate check id `p\/one`/,
    ],
    ['default export', 'export const x = 1;\n', /not a plugin object/],
  ])('refuses a bad %s with a ConfigError naming the plugin', async (_, source, message) => {
    const dir = setup({ 'p.mjs': source }, { plugins: ['./p.mjs'] });
    const err = await load(dir, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/^Plugin \.\/p\.mjs: /);
    expect((err as Error).message).toMatch(message);
  });

  it('refuses a missing module and ids duplicated across plugins', async () => {
    const missing = setup({}, { plugins: ['ctxtruth-nope'] });
    await expect(load(missing, {})).rejects.toThrow(/Plugin ctxtruth-nope: failed to load/);
    const dup = setup({ 'a.mjs': ok('p'), 'b.mjs': ok('p') }, { plugins: ['./a.mjs', './b.mjs'] });
    await expect(load(dup, {})).rejects.toThrow(/Plugin \.\/b\.mjs: duplicate check id/);
  });

  it('warns about rules of plugins that are not loaded', async () => {
    const dir = setup({}, { rules: { 'gone/check': 'error' } });
    const warnings: string[] = [];
    await load(dir, { onWarning: (m) => warnings.push(m) });
    expect(warnings).toEqual(['rule `gone/check` names a check that no loaded plugin provides']);
  });

  it('loads no plugin code when untrusted, and only notes the ignored plugins', async () => {
    const dir = setup(
      { 'p.mjs': 'throw new Error("imported");\n' },
      { plugins: ['./p.mjs'], rules: { 'p/one': 'error' } },
    );
    const warnings: string[] = [];
    const loaded = await load(dir, { untrusted: true, onWarning: (m) => warnings.push(m) });
    expect(loaded.checks.every((c) => !c.id.includes('/'))).toBe(true);
    expect(warnings).toEqual([expect.stringMatching(/^--untrusted: ignoring `plugins`/)]);
  });
});
