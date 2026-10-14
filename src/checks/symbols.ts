import { buildSymbolIndex, type SymbolDecl, type SymbolIndex } from '../index/symbols.js';
import { closest } from '../util/distance.js';
import type { Check, CheckResult, Claim, Severity } from '../types.js';
import { fail, pass, unknown } from './result.js';

const GLOBALS = new Set(
  (
    'console process JSON Math Object Array Promise Date String Number Boolean Symbol BigInt Map Set ' +
    'WeakMap WeakSet WeakRef Error TypeError RangeError SyntaxError ReferenceError EvalError URIError ' +
    'AggregateError RegExp Buffer globalThis window document navigator location fetch Request Response ' +
    'Headers URL URLSearchParams AbortController AbortSignal setTimeout setInterval setImmediate ' +
    'clearTimeout clearInterval structuredClone queueMicrotask require module exports Reflect Proxy ' +
    'Intl TextEncoder TextDecoder crypto performance describe it test expect vi jest beforeEach ' +
    'afterEach beforeAll afterAll Function ArrayBuffer Uint8Array Float64Array DataView Atomics ' +
    'FormData Blob File Event EventTarget WebSocket Worker localStorage sessionStorage alert ' +
    'parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI ' +
    'atob btoa Iterator'
  ).split(' '),
);
/** Members every function / object has, whatever the declaration says. */
const UNIVERSAL = new Set(['prototype', 'constructor', 'name', 'length', 'toString', 'valueOf']);

/** Framework entry points and web APIs a repo uses without declaring. */
const FRAMEWORK = new Set(
  (
    'getServerSideProps getStaticProps getStaticPaths generateStaticParams generateMetadata ' +
    'addEventListener removeEventListener querySelector querySelectorAll toJSON'
  ).split(' '),
);
const HOOK = /^use[A-Z]/;
const AUGMENT = new Set(['interface', 'type', 'namespace']);

/**
 * One closeness rule for names and members: case-insensitive equal, a unique prefix pair
 * (`formatDate` / `formatDateTime`), or a small edit distance (names of 5+ chars). Never the
 * same name. A prefix match needs the suffix to start a new camel hump, or to be 3+ chars with
 * the shorter name covering 3/4 of the longer one.
 */
function confident(name: string, candidates: Iterable<string>): string | undefined {
  const all = [...candidates].filter((c) => c !== name);
  const lower = name.toLowerCase();
  const same = all.find((c) => c.toLowerCase() === lower);
  if (same !== undefined) return same;
  const prefixed = all.filter((c) => {
    const [short, long] = name.length <= c.length ? [name, c] : [c, name];
    if (short.length < 4 || !long.toLowerCase().startsWith(short.toLowerCase())) return false;
    const suffix = long.slice(short.length);
    return /^[A-Z]/.test(suffix) || (suffix.length >= 3 && short.length * 4 >= long.length * 3);
  });
  const [only] = prefixed;
  if (prefixed.length === 1 && only !== undefined) return only;
  return name.length < 5 ? undefined : closest(name, all, Math.floor(name.length * 0.25));
}

type MemberLookup = { found: boolean; unresolved?: 'inherited' | 'unindexed'; known: Set<string> };

/** Looks `member` up on the declarations of `root` and, transitively, on their `extends` bases. */
function lookupMember(index: SymbolIndex, decls: SymbolDecl[], member: string): MemberLookup {
  const known = new Set<string>();
  let external = false;
  let unindexed = false;
  const seen = new Set<SymbolDecl>();
  const queue = [...decls];
  for (let d = queue.shift(); d; d = queue.shift()) {
    if (seen.has(d)) continue;
    seen.add(d);
    if (!d.members) unindexed = true;
    else if (d.members.has(member)) return { found: true, known };
    else for (const m of d.members) known.add(m);
    for (const base of d.heritage ?? []) {
      const found = index.decls.get(base);
      if (found) queue.push(...found);
      else external = true;
    }
  }
  if (external) return { found: false, unresolved: 'inherited', known };
  if (unindexed) return { found: false, unresolved: 'unindexed', known };
  return { found: false, known };
}

const files = (decls: SymbolDecl[]): string[] => [...new Set(decls.map((d) => d.file))];

function verify(claim: Claim, index: SymbolIndex, severity: Severity): CheckResult {
  const [root = '', member] = claim.value.split('.');
  const decls = index.decls.get(root);
  if (decls) {
    if (member === undefined || UNIVERSAL.has(member)) return pass(claim, 'symbols', files(decls));
    const r = lookupMember(index, decls, member);
    if (r.found) return pass(claim, 'symbols', files(decls));
    // A local `interface Response {}` / `declare global` augments a built-in: not ours to judge.
    if (GLOBALS.has(root) && decls.every((d) => AUGMENT.has(d.kind))) {
      return unknown(claim, 'symbols', 'global');
    }
    if (r.unresolved === 'inherited')
      return unknown(claim, 'symbols', 'inherited member', files(decls));
    if (r.unresolved === 'unindexed')
      return unknown(claim, 'symbols', 'members not indexed', files(decls));
    const near = confident(member, r.known);
    return fail(
      claim,
      'symbols',
      severity,
      `\`${root}\` has no member \`${member}\`${near ? ` (did you mean \`${near}\`?)` : ''}`,
      files(decls),
      near ? `${root}.${near}` : undefined,
    );
  }
  if (GLOBALS.has(root)) return unknown(claim, 'symbols', 'global');
  if (FRAMEWORK.has(root) || HOOK.test(root)) {
    return unknown(claim, 'symbols', 'framework or web API');
  }
  const from = index.external.get(root);
  if (from !== undefined) return unknown(claim, 'symbols', `external (from \`${from}\`)`);
  const where = index.loose.get(root);
  if (where !== undefined) {
    return member === undefined
      ? pass(claim, 'symbols', [where])
      : unknown(claim, 'symbols', 'members not indexed', [where]);
  }
  const near = confident(root, index.decls.keys());
  // Weak calls/chains (`path.join()`, `res.send()`) are usually variables or imports: never a root failure.
  const generic =
    claim.meta?.shape === 'weak' && (member !== undefined || claim.meta.call === 'true');
  if (near === undefined || generic || index.skipped > 0) {
    return unknown(claim, 'symbols', 'not found in the codebase');
  }
  const [decl] = index.decls.get(near) ?? [];
  return fail(
    claim,
    'symbols',
    severity,
    `Symbol \`${root}\` is not defined in the codebase (did you mean \`${near}\`?)`,
    decl ? [decl.file] : [],
    [near, ...claim.value.split('.').slice(1)].join('.'),
  );
}

export const symbolsCheck: Check = {
  id: 'symbols',
  kinds: ['symbol'],
  async run(claims, ctx) {
    if (claims.length === 0) return [];
    const index = await buildSymbolIndex(ctx.index.root, ctx.index.files.files);
    if (index.decls.size === 0) {
      return claims.map((c) => unknown(c, 'symbols', 'no TypeScript/JavaScript sources'));
    }
    return claims.map((claim) => verify(claim, index, ctx.severity));
  },
};
