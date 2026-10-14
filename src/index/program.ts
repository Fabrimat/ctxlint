import { posix } from 'node:path';
import type { CompilerHost, CompilerOptions } from 'typescript';
import type { RepoIndex } from '../types.js';

export type TS = typeof import('typescript');

const HOST_IO = [
  'fileExists',
  'readFile',
  'directoryExists',
  'realpath',
  'getDirectories',
  'readDirectory',
] as const;

/**
 * For a base worktree (`index.depsRoot` set), serve every path under the root that goes through a
 * `node_modules` segment from the same relative path under `depsRoot`: the worktree has no
 * installed dependencies. Mutates and returns `host`.
 */
export function redirectDeps<T extends object>(host: T, index: RepoIndex): T {
  if (index.depsRoot === undefined) return host;
  const from = `${index.root.replaceAll('\\', '/')}/`;
  const to = `${index.depsRoot.replaceAll('\\', '/')}/`;
  const map = (p: string): string => {
    const f = p.replaceAll('\\', '/');
    // ponytail: case-insensitive prefix test for Windows drive letters; the root is a fresh temp dir.
    if (!f.toLowerCase().startsWith(from.toLowerCase())) return p;
    const rel = f.slice(from.length);
    return rel.split('/').includes('node_modules') ? to + rel : p;
  };
  const h = host as Record<string, unknown>;
  for (const k of HOST_IO) {
    const fn = h[k];
    if (typeof fn !== 'function') continue;
    const orig = fn as (p: string, ...rest: unknown[]) => unknown;
    h[k] = (p: string, ...rest: unknown[]) => orig.call(host, map(p), ...rest);
  }
  return host;
}

/** Nearest repo-relative `tsconfig.json` walking up from the doc's directory; undefined if none. */
export function findTsconfig(index: RepoIndex, docDir: string): string | undefined {
  for (let dir = docDir; ; dir = posix.dirname(dir) === '.' ? '' : posix.dirname(dir)) {
    const candidate = posix.join(dir, 'tsconfig.json');
    if (index.files.hasFile(candidate)) return candidate;
    if (dir === '') return undefined;
  }
}

function targets(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(targets);
  if (typeof v === 'object' && v !== null) return Object.values(v).flatMap(targets);
  return [];
}

/** Source entry files of a workspace package: built outputs are mapped back to `src/`. */
function entries(ts: TS, index: RepoIndex, dir: string): string[] {
  const root = index.root.replaceAll('\\', '/');
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(
      ts.sys.readFile(posix.join(root, dir, 'package.json')) ?? '{}',
    ) as typeof json;
  } catch {
    // unreadable package.json: fall back to conventional entries
  }
  const exp = json.exports;
  const dot =
    typeof exp === 'object' && exp !== null && !Array.isArray(exp) && '.' in exp ? exp['.'] : exp;
  const declared = [json.types, dot, json.module, json.main].flatMap(targets).flatMap((p) => {
    const rel = p.replace(/^\.\//, '');
    const src = rel
      .replace(/^(dist|build|lib|out)\//, 'src/')
      .replace(/\.d\.[cm]?ts$|\.[cm]?js$/, '.ts');
    return [src, src.replace(/\.ts$/, '.tsx'), rel];
  });
  const all = [...declared, 'src/index.ts', 'src/index.tsx', 'index.ts'];
  return [...new Set(all)]
    .map((p) => posix.join(dir, p))
    .filter((p) => index.files.hasFile(p))
    .map((p) => posix.join(root, p));
}

/** `paths` entries for every named workspace package (root package included). */
function workspacePaths(ts: TS, index: RepoIndex): Record<string, string[]> {
  const root = index.root.replaceAll('\\', '/');
  const out: Record<string, string[]> = {};
  for (const pkg of index.packages.all) {
    if (!pkg.name) continue;
    const found = entries(ts, index, pkg.dir);
    if (found.length > 0) out[pkg.name] = found;
    out[`${pkg.name}/*`] = [posix.join(root, pkg.dir, 'src/*'), posix.join(root, pkg.dir, '*')];
  }
  return out;
}

/** Names of workspace packages whose entry we could map (a missing one there is real drift). */
export function mappedPackages(ts: TS, index: RepoIndex): string[] {
  return Object.keys(workspacePaths(ts, index)).filter((k) => !k.endsWith('/*'));
}

/** Compiler options for one tsconfig (or defaults), tuned for checking loose doc snippets. */
export function compilerOptions(
  ts: TS,
  index: RepoIndex,
  tsconfig: string | undefined,
): CompilerOptions {
  const root = index.root.replaceAll('\\', '/');
  let base: CompilerOptions | undefined;
  if (tsconfig !== undefined) {
    const host = redirectDeps(
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
      index,
    );
    base = ts.getParsedCommandLineOfConfigFile(posix.join(root, tsconfig), {}, host)?.options;
  }
  const options: CompilerOptions = base ?? {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    types: [],
  };
  const paths = { ...options.paths };
  for (const [name, list] of Object.entries(workspacePaths(ts, index))) paths[name] ??= list;
  return {
    ...options,
    paths,
    ...(options.baseUrl === undefined ? { pathsBasePath: root } : {}),
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
    noUnusedLocals: false,
    noUnusedParameters: false,
  };
}

/** Compiler host that serves `virtual` files (absolute POSIX path -> text) from memory. */
export function virtualHost(
  ts: TS,
  options: CompilerOptions,
  index: RepoIndex,
  virtual: Map<string, string>,
): CompilerHost {
  const root = index.root.replaceAll('\\', '/');
  const host = redirectDeps(ts.createCompilerHost(options), index);
  const { getSourceFile, fileExists, readFile } = host;
  const key = (f: string) => f.replaceAll('\\', '/');
  host.getCurrentDirectory = () => root;
  host.fileExists = (f) => virtual.has(key(f)) || fileExists(f);
  host.readFile = (f) => virtual.get(key(f)) ?? readFile(f);
  host.getSourceFile = (f, langOrOptions, onError, shouldCreate) => {
    const text = virtual.get(key(f));
    return text === undefined
      ? getSourceFile(f, langOrOptions, onError, shouldCreate)
      : ts.createSourceFile(f, text, langOrOptions);
  };
  return host;
}
