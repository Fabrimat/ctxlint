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

function readJson(ts: TS, path: string): Record<string, unknown> {
  try {
    return JSON.parse(ts.sys.readFile(path) ?? '{}') as Record<string, unknown>;
  } catch {
    return {}; // unreadable package.json: fall back to conventional entries
  }
}

/** Existing source files for declared targets: built outputs are mapped back to `src/`. */
function sources(index: RepoIndex, dir: string, declared: string[]): string[] {
  const root = index.root.replaceAll('\\', '/');
  const rels = declared.map((p) => p.replace(/^\.\//, ''));
  // Every source before any declared file: a `.d.ts` shim may re-export an unbuilt `dist/`.
  const all = [
    ...rels.flatMap((rel) => {
      const src = rel
        .replace(/^(dist|build|lib|out)\//, 'src/')
        .replace(/\.d\.[cm]?ts$|\.[cm]?js$/, '.ts');
      return [src, src.replace(/\.ts$/, '.tsx')];
    }),
    ...rels,
  ];
  return [...new Set(all)]
    .map((p) => posix.join(dir, p))
    .filter((p) => index.files.hasFile(p))
    .map((p) => posix.join(root, p));
}

/**
 * `paths` entries for every named workspace package (root package included): the entry, each
 * plain `exports` subpath (`pkg/config`), then a `pkg/*` fallback.
 */
function workspacePaths(ts: TS, index: RepoIndex): Record<string, string[]> {
  const root = index.root.replaceAll('\\', '/');
  const out: Record<string, string[]> = {};
  for (const pkg of index.packages.all) {
    if (!pkg.name) continue;
    const json = readJson(ts, posix.join(root, pkg.dir, 'package.json'));
    const exp = json.exports;
    const map =
      typeof exp === 'object' && exp !== null && !Array.isArray(exp) && '.' in exp
        ? (exp as Record<string, unknown>)
        : { '.': exp };
    const main = [json.types, map['.'], json.module, json.main].flatMap(targets);
    const found = sources(index, pkg.dir, [...main, 'src/index.ts', 'src/index.tsx', 'index.ts']);
    if (found.length > 0) out[pkg.name] = found;
    for (const [key, value] of Object.entries(map)) {
      if (!key.startsWith('./') || key.includes('*') || key.endsWith('.json')) continue;
      const sub = sources(index, pkg.dir, targets(value));
      if (sub.length > 0) out[`${pkg.name}/${key.slice(2)}`] = sub;
    }
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
