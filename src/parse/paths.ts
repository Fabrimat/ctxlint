export interface PathParts {
  value: string;
  meta?: Record<string, string>;
}

const EXT =
  'ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|md|mdx|mdc|yml|yaml|toml|css|scss|html|sh|ps1|txt|lock';
const BARE_FILE = new RegExp(String.raw`^[\w.-]+\.(?:${EXT})$`, 'i');
const ENDS_WITH_EXT = new RegExp(String.raw`\.(?:${EXT})$`, 'i');
/** `.json`, `.d.ts`, `.test.ts`: a file extension, not a file (`.eslintrc.json` still is one). */
const EXTENSION_ONLY = new RegExp(String.raw`^\.(?:(?:d|test|spec|min)\.)?(?:${EXT})$`, 'i');
const SEGMENT = /^[A-Za-z0-9._@+-]+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const VERSION = /^[v^~]?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?$/i;
const PLACEHOLDERS = ['path/to/', 'your-', 'my-', 'xxx', 'foo/bar', 'example', 'http'];
const LINE_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)$/;
const TRAILING_PUNCT = /[.,;:)]+$/;

function stripSuffixes(raw: string): string {
  let s = raw;
  for (let prev = ''; prev !== s;) {
    prev = s;
    s = s.replace(TRAILING_PUNCT, '').replace(LINE_SUFFIX, '');
  }
  return s;
}

/** Applies the root-anchor (`/x`) and directory (`x/`) conventions. */
function finish(path: string): PathParts | null {
  const meta: Record<string, string> = {};
  let value = path;
  if (value.startsWith('/')) {
    value = value.slice(1);
    meta['anchor'] = 'root';
  }
  if (value.endsWith('/')) {
    value = value.slice(0, -1);
    meta['dir'] = 'true';
  }
  if (value === '' || value === '.') return null;
  return Object.keys(meta).length > 0 ? { value, meta } : { value };
}

/** Path claim from inline code or a shell token; null unless it is confidently path-shaped. */
export function inlinePath(raw: string): PathParts | null {
  if (/\s/.test(raw)) return null;
  const s = stripSuffixes(raw);
  if (/^[@\-~$]|^\/\//.test(s) || SCHEME.test(s) || /[*?[\]{}<>]/.test(s)) return null;
  if (VERSION.test(s) || EXTENSION_ONLY.test(s)) return null;
  const lower = s.toLowerCase();
  if (PLACEHOLDERS.some((p) => lower.includes(p))) return null;
  if (!s.includes('/') && !BARE_FILE.test(s)) return null;
  const segments = s.replace(/^\//, '').replace(/\/$/, '').split('/');
  if (segments.some((g) => !SEGMENT.test(g) || /^\d+$/.test(g))) return null;
  // `e.g./i.e.`-style abbreviations: a non-final segment ending in a dot.
  if (segments.slice(0, -1).some((g) => g.endsWith('.') && g !== '..' && g !== '.')) return null;
  const parts = finish(s);
  if (!parts) return null;
  // Strong: known extension, trailing slash or explicit ./ ../. Anything else (`origin/main`,
  // `lodash/fp`) is weak: the check decides using the repo; root-anchored weak paths are dropped.
  const strong =
    s.endsWith('/') || /^\.\.?\//.test(s) || ENDS_WITH_EXT.test(segments.at(-1) as string);
  if (strong) return parts;
  if (s.startsWith('/')) return null;
  return { value: parts.value, meta: { ...parts.meta, shape: 'weak' } };
}

/** Path claim from a link/image/definition destination; null for absolute URLs and fragments. */
export function linkPath(url: string): PathParts | null {
  if (SCHEME.test(url) || url.startsWith('#') || url.startsWith('//')) return null;
  const bare = url.replace(/[#?][\s\S]*$/, '');
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // malformed escape: keep the raw text
  }
  return finish(decoded);
}

const PROSE_TOKEN = /[^\s()[\]<>"'`,;]+/g;

/** Prose path claims: tokens containing `/` that end in a known extension. */
export function proseTokens(raw: string): (PathParts & { index: number })[] {
  const out: (PathParts & { index: number })[] = [];
  for (const m of raw.matchAll(PROSE_TOKEN)) {
    const parts = inlinePath(m[0]);
    if (!parts || parts.meta?.['dir'] || !parts.value.includes('/')) continue;
    if (ENDS_WITH_EXT.test(parts.value)) out.push({ ...parts, index: m.index });
  }
  return out;
}
