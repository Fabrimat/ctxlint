import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type ts from 'typescript';

type TS = typeof ts;

export type DeclKind =
  'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'namespace' | 'alias';

export interface SymbolDecl {
  name: string;
  kind: DeclKind;
  /** Repo-relative POSIX path. */
  file: string;
  line: number;
  /** Declared members; undefined when they are not indexed (functions, spreads, aliases...). */
  members?: Set<string>;
  /** Names after `extends` (`?` when the base is not a plain name). */
  heritage?: string[];
}

export interface SymbolIndex {
  /** Top-level declarations by name, exported or not. */
  decls: Map<string, SymbolDecl[]>;
  /** Names bound by non-relative imports / requires, mapped to the module specifier. */
  external: Map<string, string>;
  /** Any other named declaration or member anywhere (nested functions, methods): name -> first file. */
  loose: Map<string, string>;
  /** Source files that could not be indexed (too large or unreadable). */
  skipped: number;
}

const SCRIPT_KINDS = {
  '.ts': 'TS',
  '.mts': 'TS',
  '.cts': 'TS',
  '.tsx': 'TSX',
  '.js': 'JS',
  '.mjs': 'JS',
  '.cjs': 'JS',
  '.jsx': 'JSX',
} as const;
const MAX_BYTES = 1024 * 1024;

/** Name of a property-like node when it is a plain identifier or literal. */
function nameOf(t: TS, n: ts.Node | undefined): string | undefined {
  if (n && (t.isIdentifier(n) || t.isStringLiteralLike(n) || t.isNumericLiteral(n))) return n.text;
  return undefined;
}

function heritageOf(t: TS, node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration): string[] {
  const out: string[] = [];
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== t.SyntaxKind.ExtendsKeyword) continue;
    for (const { expression } of clause.types) {
      if (t.isIdentifier(expression)) out.push(expression.text);
      else if (t.isPropertyAccessExpression(expression)) out.push(expression.name.text);
      else out.push('?');
    }
  }
  return out;
}

/** Adds `this.name = ...` assignments found anywhere under `node`. */
function thisAssigned(t: TS, node: ts.Node, out: Set<string>): void {
  if (
    t.isBinaryExpression(node) &&
    node.operatorToken.kind === t.SyntaxKind.EqualsToken &&
    t.isPropertyAccessExpression(node.left) &&
    node.left.expression.kind === t.SyntaxKind.ThisKeyword
  ) {
    out.add(node.left.name.text);
  }
  t.forEachChild(node, (c) => thisAssigned(t, c, out));
}

function membersOf(t: TS, elements: readonly ts.Node[]): Set<string> {
  const out = new Set<string>();
  for (const el of elements) {
    if (t.isConstructorDeclaration(el)) {
      for (const p of el.parameters) {
        const n = nameOf(t, p.name);
        if (n !== undefined && t.isParameterPropertyDeclaration(p, el)) out.add(n);
      }
    }
    const n = nameOf(t, (el as { name?: ts.Node }).name);
    if (n !== undefined) out.add(n);
  }
  return out;
}

/** Members of an object literal; undefined when a spread makes the list incomplete. */
function literalMembers(t: TS, node: ts.ObjectLiteralExpression): Set<string> | undefined {
  if (node.properties.some((p) => t.isSpreadAssignment(p))) return undefined;
  return membersOf(t, node.properties);
}

function unwrap(t: TS, e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    t.isParenthesizedExpression(cur) ||
    t.isAsExpression(cur) ||
    t.isSatisfiesExpression(cur) ||
    t.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** Module specifier of a `require('pkg')` call. */
function requireOf(t: TS, e: ts.Expression | undefined): string | undefined {
  if (!e || !t.isCallExpression(e) || !t.isIdentifier(e.expression)) return undefined;
  const [arg] = e.arguments;
  if (e.expression.text !== 'require' || !arg || !t.isStringLiteralLike(arg)) return undefined;
  return arg.text;
}

const isExternal = (spec: string): boolean => !spec.startsWith('.');

class FileCollector {
  constructor(
    private readonly t: TS,
    private readonly sf: ts.SourceFile,
    private readonly file: string,
    private readonly out: SymbolIndex,
  ) {}

  private line(n: ts.Node): number {
    return this.sf.getLineAndCharacterOfPosition(n.getStart(this.sf)).line + 1;
  }

  private add(name: string, kind: DeclKind, node: ts.Node, extra: Partial<SymbolDecl> = {}): void {
    const decl: SymbolDecl = { ...extra, name, kind, file: this.file, line: this.line(node) };
    const list = this.out.decls.get(name);
    if (list) list.push(decl);
    else this.out.decls.set(name, [decl]);
  }

  private bind(name: string, spec: string): void {
    if (isExternal(spec) && !this.out.external.has(name)) this.out.external.set(name, spec);
  }

  /** Declarations of the top-level statement list. */
  statements(list: readonly ts.Statement[]): void {
    const t = this.t;
    for (const s of list) {
      if (t.isFunctionDeclaration(s) && s.name) this.add(s.name.text, 'function', s);
      else if (t.isClassDeclaration(s) && s.name) {
        const members = membersOf(t, s.members);
        for (const m of s.members) thisAssigned(t, m, members);
        this.add(s.name.text, 'class', s, {
          members,
          heritage: heritageOf(t, s),
        });
      } else if (t.isInterfaceDeclaration(s)) {
        this.add(s.name.text, 'interface', s, {
          members: membersOf(t, s.members),
          heritage: heritageOf(t, s),
        });
      } else if (t.isTypeAliasDeclaration(s)) {
        const members = t.isTypeLiteralNode(s.type) ? membersOf(t, s.type.members) : undefined;
        this.add(s.name.text, 'type', s, members ? { members } : {});
      } else if (t.isEnumDeclaration(s)) {
        this.add(s.name.text, 'enum', s, { members: membersOf(t, s.members) });
      } else if (t.isModuleDeclaration(s) && t.isIdentifier(s.name)) this.namespace(s);
      else if (t.isVariableStatement(s)) this.variables(s.declarationList);
      else if (t.isImportDeclaration(s)) this.importDecl(s);
      else if (t.isImportEqualsDeclaration(s)) this.importEquals(s);
      else if (t.isExpressionStatement(s)) this.assignment(s.expression);
    }
  }

  private namespace(s: ts.ModuleDeclaration): void {
    const t = this.t;
    const members = new Set<string>();
    const { body } = s;
    if (body && t.isModuleBlock(body)) {
      const nested: SymbolIndex = {
        decls: new Map(),
        external: new Map(),
        loose: new Map(),
        skipped: 0,
      };
      new FileCollector(t, this.sf, this.file, nested).statements(body.statements);
      for (const n of nested.decls.keys()) members.add(n);
    } else if (body && t.isModuleDeclaration(body) && t.isIdentifier(body.name)) {
      members.add(body.name.text);
    }
    this.add((s.name as ts.Identifier).text, 'namespace', s, { members });
  }

  private variables(list: ts.VariableDeclarationList): void {
    const t = this.t;
    for (const d of list.declarations) {
      const spec = requireOf(t, d.initializer);
      if (spec !== undefined && isExternal(spec)) {
        if (t.isIdentifier(d.name)) this.bind(d.name.text, spec);
        else if (t.isObjectBindingPattern(d.name)) {
          for (const el of d.name.elements) {
            if (t.isIdentifier(el.name)) this.bind(el.name.text, spec);
          }
        }
        continue;
      }
      if (!t.isIdentifier(d.name)) continue;
      const init = d.initializer && unwrap(t, d.initializer);
      const members =
        init && t.isObjectLiteralExpression(init) ? literalMembers(t, init) : undefined;
      this.add(d.name.text, 'variable', d, members ? { members } : {});
    }
  }

  private importDecl(s: ts.ImportDeclaration): void {
    const t = this.t;
    const clause = s.importClause;
    if (!clause || !t.isStringLiteralLike(s.moduleSpecifier)) return;
    const spec = s.moduleSpecifier.text;
    if (clause.name) this.bind(clause.name.text, spec);
    const nb = clause.namedBindings;
    if (nb && t.isNamespaceImport(nb)) this.bind(nb.name.text, spec);
    else if (nb) for (const el of nb.elements) this.bind(el.name.text, spec);
  }

  private importEquals(s: ts.ImportEqualsDeclaration): void {
    const ref = s.moduleReference;
    if (this.t.isExternalModuleReference(ref) && this.t.isStringLiteralLike(ref.expression)) {
      this.bind(s.name.text, ref.expression.text);
    }
  }

  /** CommonJS `exports.x = ...` / `module.exports = { x }`: JS repos have no other declaration. */
  private assignment(e: ts.Expression): void {
    const t = this.t;
    if (!t.isBinaryExpression(e) || e.operatorToken.kind !== t.SyntaxKind.EqualsToken) return;
    const { left } = e;
    if (!t.isPropertyAccessExpression(left)) return;
    const base = left.expression;
    const isModule = (n: ts.Expression) => t.isIdentifier(n) && n.text === 'module';
    if (isModule(base) && left.name.text === 'exports') {
      const right = unwrap(t, e.right);
      if (!t.isObjectLiteralExpression(right)) return;
      for (const name of membersOf(t, right.properties)) this.add(name, 'variable', right);
    } else if (
      (t.isIdentifier(base) && base.text === 'exports') ||
      (t.isPropertyAccessExpression(base) &&
        isModule(base.expression) &&
        base.name.text === 'exports')
    ) {
      this.add(left.name.text, 'variable', left);
    } else this.augment(base, left.name.text);
  }

  /** `Foo.bar = ...` / `Foo.prototype.bar = ...`: extends the members of a known object or class. */
  private augment(base: ts.Expression, member: string): void {
    const t = this.t;
    const target =
      t.isPropertyAccessExpression(base) && base.name.text === 'prototype' ? base.expression : base;
    if (!t.isIdentifier(target)) return;
    for (const d of this.out.decls.get(target.text) ?? []) {
      if (d.file === this.file) d.members?.add(member);
    }
  }

  /** `export { a as b }` and re-exports; a local alias shares the members of its target. */
  aliases(): void {
    const t = this.t;
    for (const s of this.sf.statements) {
      if (!t.isExportDeclaration(s) || !s.exportClause) continue;
      const clause = s.exportClause;
      if (t.isNamespaceExport(clause)) {
        this.add(clause.name.text, 'alias', clause);
        continue;
      }
      for (const el of clause.elements) {
        const local = el.propertyName?.text ?? el.name.text;
        const target = s.moduleSpecifier
          ? undefined
          : this.out.decls.get(local)?.find((d) => d.file === this.file);
        if (target && !el.propertyName) continue;
        const { kind = 'alias', members, heritage } = target ?? {};
        this.add(el.name.text, kind, el, {
          ...(members ? { members } : {}),
          ...(heritage ? { heritage } : {}),
        });
      }
    }
  }

  /** `Object.assign(X, ...)` and friends: X gains members we cannot see, so stop indexing them. */
  private mutated(call: ts.CallExpression): void {
    const t = this.t;
    const fn = call.expression;
    if (
      !t.isPropertyAccessExpression(fn) ||
      !t.isIdentifier(fn.expression) ||
      fn.expression.text !== 'Object' ||
      !/^(assign|defineProperty|defineProperties)$/.test(fn.name.text)
    ) {
      return;
    }
    let target = call.arguments[0];
    if (target && t.isPropertyAccessExpression(target) && target.name.text === 'prototype') {
      target = target.expression;
    }
    if (!target || !t.isIdentifier(target)) return;
    for (const d of this.out.decls.get(target.text) ?? []) {
      if (d.file === this.file) delete d.members;
    }
  }

  /** Every named declaration or member in the file, for "is this name defined anywhere". */
  loose(node: ts.Node): void {
    const t = this.t;
    const name = nameOf(t, (node as { name?: ts.Node }).name);
    if (
      name !== undefined &&
      !this.out.loose.has(name) &&
      (t.isFunctionDeclaration(node) ||
        t.isClassDeclaration(node) ||
        t.isMethodDeclaration(node) ||
        t.isPropertyDeclaration(node) ||
        t.isVariableDeclaration(node) ||
        t.isPropertyAssignment(node) ||
        t.isShorthandPropertyAssignment(node) ||
        t.isMethodSignature(node) ||
        t.isPropertySignature(node) ||
        t.isGetAccessorDeclaration(node) ||
        t.isSetAccessorDeclaration(node) ||
        t.isEnumMember(node))
    ) {
      this.out.loose.set(name, this.file);
    }
    if (t.isCallExpression(node)) this.mutated(node);
    t.forEachChild(node, (c) => this.loose(c));
  }
}

function scriptKind(t: TS, ext: keyof typeof SCRIPT_KINDS): ts.ScriptKind {
  return t.ScriptKind[SCRIPT_KINDS[ext]];
}

const isCode = (file: string): boolean => extname(file) in SCRIPT_KINDS;

/**
 * Syntactic symbol index of every JS/TS file: no Program and no type checker, so it stays fast.
 * ponytail: names are matched by text, not resolved; same-named declarations share one lookup.
 */
export async function buildSymbolIndex(
  root: string,
  files: readonly string[],
): Promise<SymbolIndex> {
  const t = (await import('typescript')).default;
  const out: SymbolIndex = { decls: new Map(), external: new Map(), loose: new Map(), skipped: 0 };
  const code = files.filter(isCode);
  for (let i = 0; i < code.length; i += 64) {
    const batch = await Promise.all(
      code.slice(i, i + 64).map(async (file) => {
        try {
          const abs = join(root, file);
          if ((await stat(abs)).size > MAX_BYTES) return { file, text: undefined };
          return { file, text: await readFile(abs, 'utf8') };
        } catch {
          return { file, text: undefined };
        }
      }),
    );
    for (const item of batch) {
      if (item.text === undefined) {
        out.skipped++;
        continue;
      }
      const ext = extname(item.file) as keyof typeof SCRIPT_KINDS;
      const kind = scriptKind(t, ext);
      const sf = t.createSourceFile(item.file, item.text, t.ScriptTarget.Latest, false, kind);
      const c = new FileCollector(t, sf, item.file, out);
      c.statements(sf.statements);
      c.aliases();
      c.loose(sf);
    }
  }
  return out;
}
