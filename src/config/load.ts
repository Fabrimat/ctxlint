import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { configSchema, type Config } from './schema.js';

const CONFIG_NAMES = [
  'ctxtruth.config.ts',
  'ctxtruth.config.mts',
  'ctxtruth.config.mjs',
  'ctxtruth.config.js',
  'ctxtruth.config.json',
];

export class ConfigError extends Error {
  override name = 'ConfigError';
}

async function readRaw(path: string): Promise<unknown> {
  try {
    if (path.endsWith('.json')) return JSON.parse(await readFile(path, 'utf8'));
    return ((await import(pathToFileURL(path).href)) as { default?: unknown }).default;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Failed to load config ${path}: ${reason}`, { cause: err });
  }
}

export interface LoadOptions {
  /**
   * The repository is untrusted: never import its config or plugin code (only a JSON config is
   * read, and its `plugins` are ignored).
   */
  untrusted?: boolean;
}

export async function loadConfig(
  root: string,
  explicitPath?: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _opts: LoadOptions = {},
): Promise<{ config: Config; path: string | null }> {
  let path: string | null;
  if (explicitPath !== undefined) {
    path = resolve(root, explicitPath);
    if (!existsSync(path)) throw new ConfigError(`Config file not found: ${path}`);
  } else {
    path = CONFIG_NAMES.map((n) => join(root, n)).find((p) => existsSync(p)) ?? null;
  }
  if (path === null) return { config: configSchema.parse({}), path };

  const parsed = configSchema.safeParse((await readRaw(path)) ?? {});
  if (!parsed.success) {
    throw new ConfigError(`Invalid config ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  return { config: parsed.data, path };
}
