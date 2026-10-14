import { readFile, readdir } from 'node:fs/promises';
import { posix } from 'node:path';
import type { FileIndex, PackageIndex, PackageInfo } from '../types.js';
import { globToRegExp } from './glob.js';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

type Json = Record<string, unknown>;
interface WorkspacePattern {
  neg: boolean;
  glob: string;
}

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(v)) {
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

async function readJson(path: string): Promise<Json | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isRecord(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

async function readBins(root: string, dir: string): Promise<string[]> {
  try {
    const names = await readdir(posix.join(root, dir, 'node_modules/.bin'));
    return [...new Set(names.map((n) => n.replace(/\.(cmd|ps1|exe)$/i, '')))];
  } catch {
    return [];
  }
}

/** Binaries the package itself ships via its `bin` field. */
function declaredBins(json: Json): string[] {
  if (typeof json.bin === 'string') {
    return typeof json.name === 'string' ? [json.name.replace(/^@[^/]+\//, '')] : [];
  }
  return isRecord(json.bin) ? Object.keys(json.bin) : [];
}

async function toPackage(root: string, dir: string, json: Json): Promise<PackageInfo> {
  const deps: Record<string, string> = {};
  for (const f of DEP_FIELDS) Object.assign(deps, stringRecord(json[f]));
  return {
    dir,
    ...(typeof json.name === 'string' ? { name: json.name } : {}),
    scripts: stringRecord(json.scripts),
    deps,
    bins: [...new Set([...(await readBins(root, dir)), ...declaredBins(json)])],
  };
}

/** Minimal `packages:` list reader. ponytail: no flow-style (`packages: [a, b]`) lists or anchors. */
function parsePnpmWorkspace(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s+)#.*$/, '').trimEnd();
    if (/^packages\s*:$/.test(line)) inPackages = true;
    else if (/^[^\s-]/.test(line)) inPackages = false;
    else if (inPackages) {
      const m = /^\s*-\s*(?:'([^']*)'|"([^"]*)"|(\S.*))$/.exec(line);
      const item = m?.[1] ?? m?.[2] ?? m?.[3];
      if (item) out.push(item.trim());
    }
  }
  return out;
}

async function workspacePatterns(root: string, rootJson: Json | undefined) {
  const ws = rootJson?.workspaces;
  const raw = stringArray(isRecord(ws) ? ws.packages : ws);
  try {
    raw.push(
      ...parsePnpmWorkspace(await readFile(posix.join(root, 'pnpm-workspace.yaml'), 'utf8')),
    );
  } catch {
    // no pnpm-workspace.yaml
  }
  return raw.map((p): WorkspacePattern => {
    const neg = p.startsWith('!');
    return { neg, glob: (neg ? p.slice(1) : p).replace(/^\.\//, '').replace(/\/+$/, '') };
  });
}

function expandWorkspaces(patterns: WorkspacePattern[], files: FileIndex): string[] {
  const excluded = patterns.filter((p) => p.neg).map((p) => globToRegExp(p.glob));
  const dirs: string[] = [];
  for (const { glob } of patterns.filter((p) => !p.neg)) {
    const re = globToRegExp(`${glob}/package.json`);
    for (const f of files.files) {
      const dir = posix.dirname(f);
      if (dir !== '.' && re.test(f) && !dirs.includes(dir) && !excluded.some((x) => x.test(dir)))
        dirs.push(dir);
    }
  }
  return dirs;
}

export async function buildPackageIndex(rootPath: string, files: FileIndex): Promise<PackageIndex> {
  const root = rootPath.replaceAll('\\', '/');
  const rootJson = await readJson(posix.join(root, 'package.json'));
  const rootPkg = await toPackage(root, '', rootJson ?? {});
  const members: PackageInfo[] = [];
  for (const dir of expandWorkspaces(await workspacePatterns(root, rootJson), files)) {
    const json = await readJson(posix.join(root, dir, 'package.json'));
    if (json) members.push(await toPackage(root, dir, json));
  }
  return { root: rootPkg, all: [rootPkg, ...members] };
}
