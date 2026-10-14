import { validRange } from 'semver';
import type { PathParts } from './paths.js';

const NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
// ponytail: runtimes and package managers are engines, not repo dependencies; no `engines` check yet.
const ENGINES = new Set(['node', 'npm', 'pnpm', 'yarn', 'bun', 'deno']);

/** Splits `name@range`; null unless it is a valid package name plus a semver range (not a dist-tag). */
export function packageSpec(text: string): { pkg: string; range: string } | null {
  const cut = text.lastIndexOf('@');
  if (cut <= 0) return null;
  const pkg = text.slice(0, cut);
  const range = text.slice(cut + 1);
  if (!NAME.test(pkg) || ENGINES.has(pkg) || /\s/.test(range) || !/\d/.test(range)) return null;
  return validRange(range) === null ? null : { pkg, range };
}

/** Version claim from inline code (`zod@3.22`); null when not a package@version reference. */
export function inlineVersion(code: string): PathParts | null {
  const spec = packageSpec(code);
  return spec ? { value: code, meta: { pkg: spec.pkg, range: spec.range } } : null;
}
