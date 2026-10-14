import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { valid } from 'semver';

export interface Installed {
  version: string;
  /** Repo-relative file the version was read from. */
  source: string;
}

/** File-read cache; create one per check run so long-lived callers never see stale files. */
export type ReadCache = Map<string, Promise<string | undefined>>;

function readText(reads: ReadCache, path: string): Promise<string | undefined> {
  let hit = reads.get(path);
  if (!hit) {
    hit = readFile(path, 'utf8').then(
      (t) => t,
      () => undefined,
    );
    reads.set(path, hit);
  }
  return hit;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

/** Strips pnpm peer suffixes (`1.2.3(react@18.2.0)`, `1.2.3_react@18`); undefined unless semver. */
function cleanVersion(v: string | undefined): string | undefined {
  const bare = v?.replace(/\(.*$/, '').replace(/_.*$/, '').trim();
  return bare && valid(bare) ? bare : undefined;
}

function fromPackageLock(text: string, pkgDir: string, name: string): string | undefined {
  const packages = rec(rec(json(text))?.packages);
  const keys = [...(pkgDir ? [`${pkgDir}/node_modules/${name}`] : []), `node_modules/${name}`];
  for (const k of keys) {
    const v = cleanVersion(str(rec(packages?.[k])?.version));
    if (v) return v;
  }
  return undefined;
}

/* ---- pnpm-lock.yaml: minimal indentation-based reader ---- */

interface Node {
  /** Text after `key:` on the same line (v5 `name: 1.2.3` entries). */
  inline: string;
  body: string[];
}

const indentOf = (l: string): number => l.length - l.trimStart().length;
const unquote = (s: string): string => s.replace(/^(['"])(.*)\1$/, '$2').trim();

/** Direct child `key` of a block of lines (children share the block's first indent). */
function child(lines: string[], key: string): Node | undefined {
  const base = lines[0] === undefined ? 0 : indentOf(lines[0]);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (indentOf(line) !== base) continue;
    const m = /^\s*(?:'([^']+)'|"([^"]+)"|([^\s'":][^:]*)):(?:\s+(.*))?$/.exec(line.trimEnd());
    if ((m?.[1] ?? m?.[2] ?? m?.[3]) !== key) continue;
    let end = i + 1;
    while (end < lines.length && indentOf(lines[end] as string) > base) end++;
    return {
      inline: unquote((m?.[4] ?? '').replace(/\s+#.*$/, '')),
      body: lines.slice(i + 1, end),
    };
  }
  return undefined;
}

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

function fromPnpmLock(text: string, pkgDir: string, name: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  const importers = child(lines, 'importers')?.body;
  // v5 lockfiles keep the root importer's sections at the top level.
  const roots = importers ? [child(importers, pkgDir || '.')?.body] : [lines];
  for (const body of roots) {
    for (const section of DEP_SECTIONS) {
      const entry = body && child(child(body, section)?.body ?? [], name);
      if (!entry) continue;
      const v = cleanVersion(entry.inline || child(entry.body, 'version')?.inline);
      if (v) return v;
    }
  }
  return undefined;
}

/* ---- yarn.lock (v1 and berry) ---- */

function descriptorRange(d: string): { name: string; range: string } | undefined {
  const bare = unquote(d.trim());
  const cut = bare.lastIndexOf('@');
  if (cut <= 0) return undefined;
  return { name: bare.slice(0, cut), range: bare.slice(cut + 1).replace(/^npm:/, '') };
}

function fromYarnLock(text: string, name: string, declared?: string): string | undefined {
  const versions = new Set<string>();
  let hit = false;
  for (const line of text.split(/\r?\n/)) {
    if (line && !line.startsWith(' ') && !line.startsWith('#') && line.endsWith(':')) {
      // berry quotes the whole header ("a@1, a@2":), v1 quotes each descriptor ("a@1", "a@2":).
      const head = line.slice(0, -1).trim();
      const ds = (/^(['"])[^'"]*\1$/.test(head) ? unquote(head) : head)
        .split(',')
        .map(descriptorRange);
      hit = ds.some(
        (d) =>
          d?.name === name &&
          !d.range.startsWith('workspace:') &&
          (declared === undefined || d.range === declared),
      );
      continue;
    }
    const m = hit ? /^ {2}version:?\s+"?([^"\s]+)"?\s*$/.exec(line) : null;
    const v = cleanVersion(m?.[1]);
    if (v) {
      versions.add(v);
      hit = false;
    }
  }
  // ponytail: several resolved versions and no way to tell which one this package uses: give up.
  return versions.size === 1 ? [...versions][0] : undefined;
}

/**
 * Version of `name` as installed for the package at `pkgDir`: its node_modules, the hoisted root
 * node_modules, then the root lockfile. `declared` narrows yarn.lock entries to the declared range.
 */
export async function installedVersion(
  root: string,
  pkgDir: string,
  name: string,
  declared?: string,
  reads: ReadCache = new Map(),
): Promise<Installed | undefined> {
  const base = root.replaceAll('\\', '/');
  const modules = [...(pkgDir ? [`${pkgDir}/node_modules`] : []), 'node_modules'];
  for (const m of modules) {
    const source = `${m}/${name}/package.json`;
    const v = cleanVersion(
      str(rec(json((await readText(reads, posix.join(base, source))) ?? ''))?.version),
    );
    if (v) return { version: v, source };
  }
  const readers: [string, (t: string) => string | undefined][] = [
    ['package-lock.json', (t) => fromPackageLock(t, pkgDir, name)],
    ['pnpm-lock.yaml', (t) => fromPnpmLock(t, pkgDir, name)],
    ['yarn.lock', (t) => fromYarnLock(t, name, declared)],
  ];
  for (const [source, read] of readers) {
    const text = await readText(reads, posix.join(base, source));
    const version = text === undefined ? undefined : read(text);
    if (version) return { version, source };
  }
  return undefined;
}
