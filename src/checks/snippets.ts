import { posix } from 'node:path';
import type { Declaration, Diagnostic, Node, Program, SourceFile } from 'typescript';
import { compilerOptions, findTsconfig, mappedPackages, virtualHost } from '../index/program.js';
import type { TS } from '../index/program.js';
import type { Check, CheckContext, CheckResult, Claim, FileIndex } from '../types.js';
import { docDir, fail, pass, unknown } from './result.js';

/** Diagnostics that mean a snippet disagrees with the code; everything else is doc noise. */
const DRIFT_CODES = new Set([2305, 2724, 2614, 2339, 2551, 2554, 2555, 2345, 2353, 2561]);
const MISSING_MODULE = new Set([2307, 2792]);
const MISSING_EXPORT = new Set([2305, 2724]);
const CODE_EXT = /^(\.[cm]?[jt]sx?)?$/;
/** Module-level drift: a missing module or export. */
const MODULE_CODES = new Set([...MISSING_MODULE, ...MISSING_EXPORT, 2614]);
/** Member, argument and object-literal drift: judged against the declaration it hits. */
const OWNED = new Set([2339, 2551, 2554, 2555, 2345, 2353, 2561]);
/** `Cannot find name`, with or without a suggestion. */
const UNRESOLVED = new Set([2304, 2552, 2580, 2582]);

const OPT_OUT = /\b(ignore|nocheck|ctxtruth-ignore)\b/;
// ponytail: textual elision test (`...` before a closer/EOL, `/* ... */`, `// ...`); a real AST
// check would also spare `foo(...)` written as a literal call to a function named `...`.
const ELISION = /\.\.\.\s*([)\]}]|$)|\/[*/]\s*\.\.\.|…/m;

const EXT: Record<string, string> = { tsx: 'tsx', mts: 'mts', cts: 'cts' };

interface Prepared {
  claim: Claim;
  path: string;
  text: string;
}

function skipReason(claim: Claim): string | undefined {
  if (OPT_OUT.test(claim.meta?.info ?? '')) return 'opted out';
  if (claim.meta?.counterexample === 'true') return 'shown as a counterexample';
  return ELISION.test(claim.value) ? 'contains elision' : undefined;
}

function isWorkspaceName(spec: string, names: string[]): boolean {
  return names.some((n) => spec === n || spec.startsWith(`${n}/`));
}

/** The module a diagnostic names: `Cannot find module 'x'`, `'"x"' has no exported member`. */
function specOf(ts: TS, d: Diagnostic): string | undefined {
  const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
  const m = /Cannot find module '([^']+)'|'"([^"]+)"' has no exported member/.exec(text);
  return m?.[1] ?? m?.[2];
}

const RELATIVE = /^\.\.?\//;

function keep(ts: TS, d: Diagnostic, names: string[]): boolean {
  if (DRIFT_CODES.has(d.code)) return true;
  if (!MISSING_MODULE.has(d.code)) return false;
  const spec = specOf(ts, d);
  if (spec === undefined) return false;
  // Relative assets (`./app.css`) are bundler business, not code drift.
  if (RELATIVE.test(spec)) return CODE_EXT.test(posix.extname(spec));
  return isWorkspaceName(spec, names);
}

/**
 * The diagnostics that are drift, or why the snippet cannot be judged. `names` are the mapped
 * workspace specifiers, `workspace` every workspace package name.
 */
function drift(
  ts: TS,
  all: Diagnostic[],
  imports: string[],
  names: string[],
  workspace: string[],
  where: { dir: string; files: FileIndex; owned: (d: Diagnostic) => boolean },
): Diagnostic[] | string {
  const { dir: base, files, owned } = where;
  // `./module.js`, `./path/to/module`: illustrative unless its directory exists (`./src/gone.ts`).
  // Relative assets (`./app.css`) are bundler business.
  const relative = all.some((d) => {
    const spec = specOf(ts, d) ?? '';
    if (!MISSING_MODULE.has(d.code) || !RELATIVE.test(spec)) return false;
    const dir = posix.normalize(posix.join(base, posix.dirname(spec)));
    const named = posix
      .dirname(spec)
      .split('/')
      .some((s) => s !== '.' && s !== '..');
    const real = named && files.hasDir(dir === '.' ? '' : dir);
    return CODE_EXT.test(posix.extname(spec)) && !real;
  });
  if (relative) return 'imports an illustrative relative module';
  const kept = all.filter((d) => keep(ts, d, names));
  // A wrong member or argument is drift only on a declaration of the repo's own code: the
  // snippet's own illustrative declarations, the DOM and other libraries are not ours to judge.
  let repo = kept.filter((d) => !OWNED.has(d.code) || owned(d));
  if (kept.length > 0 && repo.length === 0)
    return 'disagrees only with code outside the repository';
  // Undeclared names (`Agent`, `store`) make the types around them guesses.
  if (all.some((d) => UNRESOLVED.has(d.code))) {
    const sure = repo.filter((d) => MODULE_CODES.has(d.code));
    if (sure.length === 0 && repo.length > 0) return 'uses names the snippet does not declare';
    repo = sure;
  }
  if (!imports.some((s) => isWorkspaceName(s, workspace))) return repo;
  // Workspace packages map to their sources, so declaration merging (chai's `expect().to`) and
  // build-time types are missing: only a missing export of a mapped module is sure.
  const sure = repo.filter(
    (d) => MISSING_EXPORT.has(d.code) && names.includes(specOf(ts, d) ?? ''),
  );
  return sure.length === 0 && repo.length > 0
    ? 'imports a workspace package; its types may be incomplete'
    : sure;
}

/** The deepest node of `sf` that contains `pos`. */
function nodeAt(sf: SourceFile, pos: number): Node {
  let node: Node = sf;
  for (;;) {
    const child = node.getChildren(sf).find((c) => c.getStart(sf) <= pos && pos < c.getEnd());
    if (child === undefined) return node;
    node = child;
  }
}

/** The declarations a member, call or object-literal diagnostic is checked against. */
function targetDecls(ts: TS, program: Program, sf: SourceFile, d: Diagnostic): Declaration[] {
  const checker = program.getTypeChecker();
  const at = nodeAt(sf, d.start ?? 0);
  const up = (test: (n: Node) => boolean): Node | undefined => {
    for (let n: Node | undefined = at; n !== undefined; n = n.parent) if (test(n)) return n;
    return undefined;
  };
  const ofType = (n: Node): Declaration[] => {
    const type = checker.getTypeAtLocation(n);
    return [...((type.getSymbol() ?? type.aliasSymbol)?.declarations ?? [])];
  };
  if (d.code === 2339 || d.code === 2551) {
    const access = up(ts.isPropertyAccessExpression);
    return access !== undefined && ts.isPropertyAccessExpression(access)
      ? ofType(access.expression)
      : [];
  }
  if (d.code === 2353 || d.code === 2561) {
    const literal = up(ts.isObjectLiteralExpression);
    if (literal === undefined || !ts.isObjectLiteralExpression(literal)) return [];
    const type = checker.getContextualType(literal);
    return [...((type?.getSymbol() ?? type?.aliasSymbol)?.declarations ?? [])];
  }
  const call = up((n) => ts.isCallExpression(n) || ts.isNewExpression(n));
  if (call === undefined || !(ts.isCallExpression(call) || ts.isNewExpression(call))) return [];
  const decl = checker.getResolvedSignature(call)?.getDeclaration();
  return decl === undefined ? [] : [decl];
}

/** Repo files (outside node_modules) the snippet's imports resolve to. */
function resolvedFiles(
  ts: TS,
  p: Prepared,
  options: Parameters<TS['resolveModuleName']>[2],
  host: Parameters<TS['resolveModuleName']>[3],
  root: string,
): string[] {
  const out = new Set<string>();
  for (const { fileName } of ts.preProcessFile(p.text).importedFiles) {
    const file = ts.resolveModuleName(fileName, p.path, options, host).resolvedModule
      ?.resolvedFileName;
    if (file === undefined || file.includes('/node_modules/')) continue;
    const rel = posix.relative(root, file);
    if (!rel.startsWith('../') && rel !== '') out.add(rel);
  }
  return [...out];
}

function verdict(
  claim: Claim,
  ts: TS,
  diags: Diagnostic[],
  sfLine: (d: Diagnostic) => { line: number; character: number },
  files: string[],
  ctx: CheckContext,
): CheckResult {
  const [first] = diags;
  if (first === undefined) return pass(claim, 'snippets', files);
  const message = ts.flattenDiagnosticMessageText(first.messageText, ' ');
  const more = diags.length > 1 ? ` (+${diags.length - 1} more)` : '';
  const hint = /Did you mean '([^']+)'/.exec(message)?.[1];
  const res = fail(
    claim,
    'snippets',
    ctx.severity,
    `Snippet does not type-check: ${message} (TS${first.code})${more}`,
    files,
    hint,
  );
  const pos = sfLine(first);
  if (res.finding) {
    res.finding.line = claim.line + pos.line;
    res.finding.col = claim.col + pos.character;
  }
  return res;
}

export const snippetsCheck: Check = {
  id: 'snippets',
  kinds: ['snippet'],
  async run(claims, ctx) {
    if (claims.length === 0) return [];
    const ts = (await import('typescript')).default;
    const root = ctx.index.root.replaceAll('\\', '/');
    const names = mappedPackages(ts, ctx.index);
    const workspace = ctx.index.packages.all.flatMap((p) => (p.name ? [p.name] : []));
    const results = new Map<Claim, CheckResult>();
    const groups = new Map<string, Prepared[]>();

    claims.forEach((claim, i) => {
      const reason = skipReason(claim);
      if (reason !== undefined) return void results.set(claim, unknown(claim, 'snippets', reason));
      const ext = EXT[claim.meta?.lang ?? ''] ?? 'ts';
      const path = posix.join(
        root,
        docDir(claim.file),
        `__ctxtruth_snippet_${i}_${claim.line}.${ext}`,
      );
      // Appended (not prepended) so line numbers hold; makes every snippet its own module.
      const prepared = { claim, path, text: `${claim.value}\nexport {};\n` };
      const key = findTsconfig(ctx.index, docDir(claim.file)) ?? '';
      groups.set(key, [...(groups.get(key) ?? []), prepared]);
    });

    for (const [key, items] of groups) {
      const options = compilerOptions(ts, ctx.index, key === '' ? undefined : key);
      const virtual = new Map(items.map((p) => [p.path, p.text]));
      const host = virtualHost(ts, options, ctx.index, virtual);
      const program = ts.createProgram(
        items.map((p) => p.path),
        options,
        host,
      );
      for (const p of items) {
        const sf = program.getSourceFile(p.path);
        if (sf === undefined || program.getSyntacticDiagnostics(sf).length > 0) {
          results.set(p.claim, unknown(p.claim, 'snippets', 'not valid TypeScript'));
          continue;
        }
        const all = program.getSemanticDiagnostics(sf).filter((d) => d.start !== undefined);
        const imports = ts.preProcessFile(p.text).importedFiles.map((f) => f.fileName);
        const diags = drift(ts, all, imports, names, workspace, {
          dir: docDir(p.claim.file),
          files: ctx.index.files,
          owned: (d) => {
            const decls = targetDecls(ts, program, sf, d);
            return (
              decls.length > 0 &&
              decls.every((decl) => {
                const file = decl.getSourceFile();
                const name = file.fileName.replaceAll('\\', '/');
                return (
                  !program.isSourceFileDefaultLibrary(file) &&
                  !name.includes('/node_modules/') &&
                  !virtual.has(name) &&
                  name.toLowerCase().startsWith(`${root.toLowerCase()}/`)
                );
              })
            );
          },
        });
        if (typeof diags === 'string') {
          results.set(p.claim, unknown(p.claim, 'snippets', diags));
          continue;
        }
        diags.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
        const files = resolvedFiles(ts, p, options, host, root);
        results.set(
          p.claim,
          verdict(
            p.claim,
            ts,
            diags,
            (d) => sf.getLineAndCharacterOfPosition(d.start ?? 0),
            files,
            ctx,
          ),
        );
      }
    }
    return claims.map((c) => results.get(c) ?? unknown(c, 'snippets', 'not checked'));
  },
};
