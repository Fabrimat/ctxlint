import { afterEach, describe, expect, it } from 'vitest';
import { buildSymbolIndex } from '../../src/index/symbols.js';
import { makeTmpRepo } from '../helpers/tmp.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function index(files: Record<string, string>) {
  const repo = makeTmpRepo(files);
  cleanups.push(repo.cleanup);
  return buildSymbolIndex(repo.dir, Object.keys(files));
}
type Idx = Awaited<ReturnType<typeof index>>;
const one = (idx: Idx, name: string) => idx.decls.get(name)?.[0];
const members = (idx: Idx, name: string) => [...(one(idx, name)?.members ?? [])];

describe('symbol index: declarations', () => {
  it('collects every top-level declaration kind with file and line', async () => {
    const idx = await index({
      'src/a.ts': [
        'export function fn() {}',
        'class Local {}',
        'export interface Shape {}',
        'export type Alias = string;',
        'export enum Color { Red }',
        'export const value = 1;',
        'let other: number;',
        'export namespace Ns { export function inner() {} }',
        'export default function main() {}',
      ].join('\n'),
      'src/b.ts': 'export default class Widget {}',
    });
    const kinds = Object.fromEntries([...idx.decls].map(([n, [d]]) => [n, d?.kind]));
    expect(kinds).toEqual({
      fn: 'function',
      Local: 'class',
      Shape: 'interface',
      Alias: 'type',
      Color: 'enum',
      value: 'variable',
      other: 'variable',
      Ns: 'namespace',
      main: 'function',
      Widget: 'class',
    });
    expect(one(idx, 'Color')).toMatchObject({ file: 'src/a.ts', line: 5 });
    expect(one(idx, 'Widget')).toMatchObject({ file: 'src/b.ts', line: 1 });
  });

  it('records export aliases, sharing members of a local target', async () => {
    const idx = await index({
      'a.ts': 'class Impl { run() {} }\nexport { Impl as Public, missing as Other };',
      'b.ts': "export { x as y } from './x';\nexport * as ns from './ns';",
    });
    expect(members(idx, 'Public')).toEqual(['run']);
    expect(one(idx, 'Public')?.kind).toBe('class');
    expect(one(idx, 'Other')).toMatchObject({ kind: 'alias' });
    expect(one(idx, 'Other')?.members).toBeUndefined();
    expect(one(idx, 'y')?.kind).toBe('alias');
    expect(one(idx, 'ns')?.kind).toBe('alias');
  });

  it('indexes .d.ts, tsx and JavaScript files, skips others and large files', async () => {
    const idx = await index({
      'types.d.ts': 'export declare function declared(): void;',
      'ui.tsx': 'export const View = () => <div />;',
      'lib.mjs': 'export function esm() {}',
      'lib.cjs': 'function cjs() {}',
      'comp.jsx': 'export const Comp = () => <b />;',
      'notes.md': 'function nope() {}',
      'big.ts': 'export const huge = "' + 'x'.repeat(1024 * 1024) + '";',
    });
    expect([...idx.decls.keys()].sort()).toEqual(['Comp', 'View', 'cjs', 'declared', 'esm']);
  });
});

describe('symbol index: members', () => {
  it('collects class members incl. static, accessors and parameter properties', async () => {
    const idx = await index({
      'a.ts': [
        'class A extends Base {',
        '  field = 1;',
        '  static make() {}',
        '  method() {}',
        '  get size() { return 1; }',
        '  set size(v) {}',
        '  #secret = 1;',
        '  [computed]() {}',
        '  constructor(public name: string, private readonly id: number, plain: string) { super(); }',
        '}',
      ].join('\n'),
    });
    expect(members(idx, 'A').sort()).toEqual(['field', 'id', 'make', 'method', 'name', 'size']);
    expect(one(idx, 'A')?.heritage).toEqual(['Base']);
  });

  it('collects interface, enum, namespace and type literal members, with heritage', async () => {
    const idx = await index({
      'a.ts': [
        'interface I extends X, ns.Y { a: 1; b(): void }',
        'enum E { One, Two = 2 }',
        'namespace N { export const c = 1; export function d() {} namespace Deep {} }',
        'type T = { p: string; q(): void };',
        'type U = string | number;',
      ].join('\n'),
    });
    expect(members(idx, 'I')).toEqual(['a', 'b']);
    expect(one(idx, 'I')?.heritage).toEqual(['X', 'Y']);
    expect(members(idx, 'E')).toEqual(['One', 'Two']);
    expect(members(idx, 'N').sort()).toEqual(['Deep', 'c', 'd']);
    expect(members(idx, 'T')).toEqual(['p', 'q']);
    expect(one(idx, 'U')?.members).toBeUndefined();
  });

  it('collects object literal members; spreads and non-literals leave them unindexed', async () => {
    const idx = await index({
      'a.ts': [
        "const api = { get() {}, post: () => 1, shorthand, 'quoted-key': 1 } as const;",
        'const spread = { ...api, extra: 1 };',
        'const arrow = () => 1;',
        'class Mixed extends mixin(Base) {}',
      ].join('\n'),
    });
    expect(members(idx, 'api').sort()).toEqual(['get', 'post', 'quoted-key', 'shorthand']);
    expect(one(idx, 'spread')?.members).toBeUndefined();
    expect(one(idx, 'arrow')?.members).toBeUndefined();
    expect(one(idx, 'Mixed')?.heritage).toEqual(['?']);
  });

  it('understands CommonJS exports and member assignments in JS files', async () => {
    const idx = await index({
      'a.js': [
        'exports.one = function () {};',
        'module.exports.two = 2;',
        'module.exports = { three, four() {} };',
        'function Old() {}',
        'const obj = { a: 1 };',
        'obj.b = 2;',
        'Old.prototype.run = function () {};',
      ].join('\n'),
    });
    for (const n of ['one', 'two', 'three', 'four']) expect(one(idx, n)?.kind).toBe('variable');
    expect(members(idx, 'obj').sort()).toEqual(['a', 'b']);
    expect(one(idx, 'Old')?.members).toBeUndefined();
  });

  it('records nested declarations and members in the loose map', async () => {
    const idx = await index({
      'a.ts': 'function outer() { function inner() {} }\nclass K { method() {} }',
    });
    expect(idx.loose.get('inner')).toBe('a.ts');
    expect(idx.loose.get('method')).toBe('a.ts');
    expect(idx.decls.has('inner')).toBe(false);
  });
});

describe('symbol index: external bindings', () => {
  it('maps non-relative import and require bindings to their module', async () => {
    const idx = await index({
      'a.ts': [
        "import def from 'pkg-a';",
        "import { named, orig as renamed } from 'pkg-b';",
        "import * as ns from 'pkg-c';",
        "import rel from './rel';",
        "import eq = require('pkg-d');",
        "const dflt = require('pkg-e');",
        "const { x, y: z } = require('pkg-f');",
        "const local = require('./local');",
      ].join('\n'),
    });
    expect(Object.fromEntries(idx.external)).toEqual({
      def: 'pkg-a',
      named: 'pkg-b',
      renamed: 'pkg-b',
      ns: 'pkg-c',
      eq: 'pkg-d',
      dflt: 'pkg-e',
      x: 'pkg-f',
      z: 'pkg-f',
    });
    expect(idx.decls.has('def')).toBe(false);
    expect(idx.decls.has('local')).toBe(true);
  });
});
