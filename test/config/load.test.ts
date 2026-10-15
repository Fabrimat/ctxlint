import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, defaultConfig, loadConfig } from '../../src/config/index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ctxtruth-config-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (name: string, body: string): Promise<void> => writeFile(join(dir, name), body);

describe('loadConfig', () => {
  it('returns defaults when no config exists', async () => {
    expect(await loadConfig(dir)).toEqual({ config: defaultConfig, path: null, warnings: [] });
  });

  it('loads ctxtruth.config.json', async () => {
    await write('ctxtruth.config.json', '{"prose": true, "rules": {"paths": "warning"}}');
    const { config, path } = await loadConfig(dir);
    expect(path).toBe(join(dir, 'ctxtruth.config.json'));
    expect(config.prose).toBe(true);
    expect(config.rules.paths).toBe('warning');
    expect(config.rules.scripts).toBe('error');
  });

  it('loads ctxtruth.config.mjs', async () => {
    await write('ctxtruth.config.mjs', "export default { failOn: 'warning' };\n");
    const { config, path } = await loadConfig(dir);
    expect(path).toBe(join(dir, 'ctxtruth.config.mjs'));
    expect(config.failOn).toBe('warning');
  });

  it('loads ctxtruth.config.ts with native type stripping', async () => {
    await write(
      'ctxtruth.config.ts',
      "import type { UserConfig } from '../src/config/index.js';\n" +
        "const config: UserConfig = { ignore: ['docs/old/**'] };\n" +
        'export default config;\n',
    );
    const { config, path } = await loadConfig(dir);
    expect(path).toBe(join(dir, 'ctxtruth.config.ts'));
    expect(config.ignore).toEqual(['docs/old/**']);
  });

  it('prefers .ts over .json when both exist', async () => {
    await write('ctxtruth.config.ts', 'export default { prose: true };\n');
    await write('ctxtruth.config.json', '{"prose": false}');
    expect((await loadConfig(dir)).config.prose).toBe(true);
  });

  it('loads an explicit path relative to root', async () => {
    await write('custom.json', '{"failOn": "none"}');
    const { config, path } = await loadConfig(dir, 'custom.json');
    expect(path).toBe(join(dir, 'custom.json'));
    expect(config.failOn).toBe('none');
  });

  it('throws when an explicit path is missing', async () => {
    await expect(loadConfig(dir, 'nope.json')).rejects.toThrow(
      `Config file not found: ${join(dir, 'nope.json')}`,
    );
  });

  it('reports invalid JSON with the file path', async () => {
    await write('ctxtruth.config.json', '{ nope');
    const err = await loadConfig(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain(join(dir, 'ctxtruth.config.json'));
  });

  it('reports schema violations with the file path and field', async () => {
    await write('ctxtruth.config.json', '{"failOn": "sometimes", "extra": true}');
    const err = await loadConfig(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    expect(msg).toContain(`Invalid config ${join(dir, 'ctxtruth.config.json')}`);
    expect(msg).toContain('failOn');
    expect(msg).toContain('extra');
  });
});
