import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli.js';
import { makeTmpRepo } from '../helpers/tmp.js';

async function run(args: string[], cwd: string) {
  let out = '';
  let err = '';
  const io: CliIO = {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    cwd,
    isTTY: false,
    env: {},
  };
  return { code: await main(args, io), out, err };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function setup(files: Record<string, string> = {}) {
  const repo = makeTmpRepo(
    { 'README.md': '# Docs\n\nSee `src/a.ts`.\n', 'src/a.ts': 'export const a = 1;\n', ...files },
    { git: true },
  );
  cleanups.push(repo.cleanup);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'init');
  return repo;
}

/** A config module that leaves a marker file when imported. */
const evil = (dir: string) =>
  `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir, 'marker'))}, 'x');\nexport default {};\n`;

describe('--untrusted', { timeout: 30_000 }, () => {
  it('imports a code config without the flag', async () => {
    const repo = setup();
    writeFileSync(join(repo.dir, 'ctxtruth.config.ts'), evil(repo.dir));
    expect((await run(['check', '--root', repo.dir], repo.dir)).code).toBe(0);
    expect(existsSync(join(repo.dir, 'marker'))).toBe(true);
  });

  it('skips an auto-discovered code config with a warning', async () => {
    const repo = setup();
    writeFileSync(join(repo.dir, 'ctxtruth.config.ts'), evil(repo.dir));
    const r = await run(['check', '--untrusted', '--root', repo.dir], repo.dir);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/^warning: --untrusted: skipping .*ctxtruth\.config\.ts/m);
    expect(existsSync(join(repo.dir, 'marker'))).toBe(false);
  });

  it('uses the JSON config next to a code config', async () => {
    const repo = setup({
      'ctxtruth.config.json': '{"rules":{"paths":"off"}}',
      'ctxtruth.config.mjs': 'throw new Error("imported");',
    });
    const r = await run(['check', '--untrusted', '--root', repo.dir], repo.dir);
    expect(r.code).toBe(0);
    expect(r.err).toContain('ctxtruth.config.mjs');
  });

  it('rejects an explicit code config with exit 2', async () => {
    const repo = setup();
    writeFileSync(join(repo.dir, 'x.ts'), evil(repo.dir));
    const r = await run(['check', '--untrusted', '--config', 'x.ts', '--root', repo.dir], repo.dir);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--untrusted');
    expect(existsSync(join(repo.dir, 'marker'))).toBe(false);
  });

  it.each(['cfg.txt', 'cfg.JS', 'cfg'])('rejects explicit non-JSON config %s', async (name) => {
    const repo = setup();
    writeFileSync(join(repo.dir, name), evil(repo.dir));
    const r = await run(['check', '--untrusted', '--config', name, '--root', repo.dir], repo.dir);
    expect(r.code).toBe(2);
    expect(existsSync(join(repo.dir, 'marker'))).toBe(false);
  });

  it('ignores plugins in a JSON config with a warning', async () => {
    const repo = setup({ 'ctxtruth.config.json': '{"plugins":["./evil.mjs"]}' });
    for (const cmd of ['check', 'blame']) {
      const r = await run([cmd, '--untrusted', '--root', repo.dir], repo.dir);
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/warning: --untrusted: ignoring `plugins`/);
    }
  });

  it('works for history', async () => {
    const repo = setup({ 'ctxtruth.config.mjs': 'throw new Error("imported");' });
    const r = await run(['history', '--untrusted', '--root', repo.dir], repo.dir);
    expect(r.code).toBe(0);
    expect(r.err).toContain('warning: --untrusted: skipping');
  });
});
