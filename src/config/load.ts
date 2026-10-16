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

// The one predicate deciding how a config is read: JSON is parsed, anything else is imported.
const isJson = (path: string): boolean => path.endsWith('.json');

async function readRaw(path: string): Promise<unknown> {
  try {
    if (isJson(path)) return JSON.parse(await readFile(path, 'utf8'));
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
  opts: LoadOptions = {},
): Promise<{ config: Config; path: string | null; warnings: string[] }> {
  const untrusted = opts.untrusted === true;
  const warnings: string[] = [];
  let path: string | null;
  if (explicitPath !== undefined) {
    path = resolve(root, explicitPath);
    if (!existsSync(path)) throw new ConfigError(`Config file not found: ${path}`);
    if (untrusted && !isJson(path)) {
      throw new ConfigError(`Refusing to import ${path} with --untrusted; use a JSON config.`);
    }
  } else {
    const found = CONFIG_NAMES.map((n) => join(root, n)).filter((p) => existsSync(p));
    if (untrusted) {
      for (const p of found.filter((f) => !isJson(f))) {
        warnings.push(`--untrusted: skipping ${p} (it would be imported)`);
      }
    }
    path = found.find((p) => !untrusted || isJson(p)) ?? null;
  }
  if (path === null) return { config: configSchema.parse({}), path, warnings };

  const raw: unknown = (await readRaw(path)) ?? {};
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid config ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data;
  if (untrusted && config.plugins.length > 0) {
    warnings.push(`--untrusted: ignoring \`plugins\` in ${path}`);
    config.plugins = [];
  }
  // The llm block decides what a run may spend (prices, budget, models, caps): an untrusted
  // repository must not set it. `rules.semantic` stays: it only changes a finding's severity.
  if (untrusted && typeof raw === 'object' && raw !== null && 'llm' in raw) {
    warnings.push(`--untrusted: ignoring \`llm\` in ${path}`);
    config.llm = configSchema.parse({}).llm;
  }
  return { config, path, warnings };
}
