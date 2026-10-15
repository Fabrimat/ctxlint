import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError } from '../config/load.js';
import type { Config } from '../config/schema.js';
import type { CtxtruthPlugin } from './types.js';

export interface LoadedPlugin {
  plugin: CtxtruthPlugin;
  options: unknown;
}

const NAME = /^[a-z0-9-]+$/;
const CHECK_ID = /^[a-z0-9-]+\/[a-z0-9-]+$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isStrings = (v: unknown): boolean =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');
const validRegex = (s: unknown): boolean => {
  try {
    new RegExp(s as string);
    return typeof s === 'string';
  } catch {
    return false;
  }
};

/** Why `p` is not a valid apiVersion 1 plugin, or null. */
function invalid(p: unknown): string | null {
  if (!isObject(p)) return 'the default export is not a plugin object';
  if (p['apiVersion'] !== 1) {
    return `apiVersion ${String(p['apiVersion'])} is not supported (this ctxtruth supports apiVersion 1)`;
  }
  const name = p['name'];
  if (typeof name !== 'string' || !NAME.test(name)) return 'name must match /^[a-z0-9-]+$/';
  if (!Array.isArray(p['checks'])) return '`checks` must be an array';
  const regions = p['ignoreRegions'];
  if (
    regions !== undefined &&
    !(
      Array.isArray(regions) &&
      regions.every((r) => isObject(r) && validRegex(r['begin']) && validRegex(r['end']))
    )
  ) {
    return '`ignoreRegions` must be { begin, end } regular expression sources';
  }
  for (const c of p['checks'] as unknown[]) {
    if (!isObject(c)) return 'every check must be an object';
    const id = c['id'];
    if (typeof id !== 'string' || !CHECK_ID.test(id) || !id.startsWith(`${name}/`)) {
      return `check id \`${String(id)}\` must be \`${name}/<check>\` (lowercase letters, digits and dashes)`;
    }
    if (typeof c['verify'] !== 'function') return `${id}: verify must be a function`;
    if (c['description'] !== undefined && typeof c['description'] !== 'string') {
      return `${id}: description must be a string`;
    }
    const sev = c['defaultSeverity'];
    if (sev !== undefined && sev !== 'error' && sev !== 'warning') {
      return `${id}: defaultSeverity must be 'error' or 'warning'`;
    }
    if (c['environment'] !== undefined && typeof c['environment'] !== 'boolean') {
      return `${id}: environment must be a boolean`;
    }
    const m = c['match'];
    if (!isObject(m)) return `${id}: match must be an object`;
    for (const key of ['inlineCode', 'links'] as const) {
      const re = m[key];
      if (re === undefined) continue;
      if (!(re instanceof RegExp)) return `${id}: match.${key} must be a RegExp`;
      if (re.global || re.sticky) return `${id}: match.${key} must not use the g or y flag`;
    }
    for (const key of ['fences', 'commands'] as const) {
      if (m[key] !== undefined && !isStrings(m[key])) {
        return `${id}: match.${key} must be an array of strings`;
      }
    }
  }
  return null;
}

/** Absolute file of a plugin spec: a path relative to the config file, or a package name. */
function locate(spec: string, root: string, configDir: string): string {
  if (spec.startsWith('.') || isAbsolute(spec)) return resolve(configDir, spec);
  return createRequire(join(root, 'noop.js')).resolve(spec);
}

/**
 * Imports and validates the configured plugins, in config order. Any failure is a ConfigError
 * naming the plugin.
 */
export async function loadPlugins(
  config: Config,
  root: string,
  configPath: string | null,
): Promise<LoadedPlugin[]> {
  const configDir = configPath === null ? root : dirname(configPath);
  const out: LoadedPlugin[] = [];
  const ids = new Set<string>();
  for (const entry of config.plugins) {
    const [spec, options] = typeof entry === 'string' ? [entry, undefined] : entry;
    const fail = (reason: string, cause?: unknown): ConfigError =>
      new ConfigError(`Plugin ${spec}: ${reason}`, { cause });
    let plugin: unknown;
    try {
      const file = locate(spec, root, configDir);
      const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
      plugin = typeof mod.default === 'function' ? await mod.default(options) : mod.default;
    } catch (err) {
      throw fail(`failed to load: ${err instanceof Error ? err.message : String(err)}`, err);
    }
    const why = invalid(plugin);
    if (why !== null) throw fail(why);
    const p = plugin as CtxtruthPlugin;
    for (const c of p.checks) {
      if (ids.has(c.id)) throw fail(`duplicate check id \`${c.id}\``);
      ids.add(c.id);
    }
    out.push({ plugin: p, options });
  }
  return out;
}
