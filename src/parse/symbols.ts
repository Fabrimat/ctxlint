import type { PathParts } from './paths.js';

const RESERVED = new Set(
  (
    'true false null undefined this super void typeof new return function class const let var if else ' +
    'for while do switch case break continue import export default async await yield throw try catch ' +
    'finally in of delete instanceof string number boolean object any unknown never symbol bigint NaN Infinity'
  ).split(' '),
);
/** Final segments that make `Node.js` / `config.json` a file or product name, not a member. */
const FILE_EXT =
  /^(?:js|ts|jsx|tsx|mjs|cjs|mts|cts|json|jsonc|md|mdx|yml|yaml|toml|css|scss|html|txt|lock|env|sh|py|rs|go)$/i;
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const CAMEL = /^[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+$/;
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;

const HUMP = /[A-Z][a-z0-9]|[A-Z]+(?![a-z])/g;

/** Number of words in a camelCase / PascalCase name (`createUser` = 2, `toJSON` = 2, `React` = 1). */
function humps(name: string): number {
  const caps = name.match(HUMP)?.length ?? 0;
  if (CAMEL.test(name)) return 1 + caps;
  return PASCAL.test(name) && /[a-z]/.test(name) ? caps : 0;
}

/** Index just past the `)` that closes the `(` at `open`, or -1 when unbalanced. */
function closeParen(text: string, open: number): number {
  const stack: string[] = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  for (let i = open; i < text.length; i++) {
    const ch = text.charAt(i);
    const want = pairs[ch];
    if (want !== undefined) stack.push(want);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Symbol claim from inline code (`createUser()`, `UserService.find`); null when not symbol-shaped.
 * ponytail: arguments are only bracket-balanced, never parsed; quotes inside them are not tracked.
 */
export function inlineSymbol(code: string): PathParts | null {
  let text = code.trim();
  const isNew = /^new\s+/.test(text);
  if (isNew) text = text.replace(/^new\s+/, '');
  const open = text.indexOf('(');
  const call = open >= 0;
  if (call && closeParen(text, open) !== text.length) return null;
  if (isNew && !call) return null;
  const head = call ? text.slice(0, open) : text;
  const segments = head.split(/[.#]/);
  const [root = '', ...rest] = segments;
  if (!segments.every((s) => IDENT.test(s)) || RESERVED.has(root) || root.length < 2) return null;
  if (rest.length > 0) {
    const last = rest[rest.length - 1] ?? '';
    // `e.g`, `i.e`: abbreviations have short non-final segments.
    if (
      last.length <= 2 &&
      segments.slice(0, -1).some((s) => s.length <= 2 && s === s.toLowerCase())
    )
      return null;
    if (FILE_EXT.test(last)) return null;
    // ponytail: all-lowercase chains without a call (`user.name`, `run.exe`) are skipped; add when variables matter.
    if (!call && !/[A-Z]/.test(head)) return null;
  } else if (!call && (head.length < 4 || humps(head) < 2)) {
    return null;
  }
  const meta: Record<string, string> = {};
  if (call) meta.call = 'true';
  // Bare names and roots without two humps (`res.send()`, `Foo.bar`) are too generic to fail on their own.
  if ((rest.length === 0 && !call) || humps(root) < 2) meta.shape = 'weak';
  return { value: segments.join('.'), meta };
}
