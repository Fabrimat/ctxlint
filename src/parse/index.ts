import type { Code, InlineCode, Nodes, Text } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { PluginCheck } from '../plugin/types.js';
import type { Claim, ClaimKind, ClaimSource } from '../types.js';
import {
  disabledRanges,
  isDisabled,
  markerOf,
  regionDelta,
  regionRanges,
  type IgnoreRegion,
  type Toggle,
} from './markers.js';
import { inlinePath, linkPath, proseTokens, type PathParts } from './paths.js';
import { leadingBinary, logicalLines, parseShellLine, type Piece } from './shell.js';
import { inlineSymbol } from './symbols.js';
import { inlineVersion } from './versions.js';

export interface ParseOptions {
  /** Also extract paths mentioned in plain prose (noisier; off by default). */
  prose?: boolean;
  /**
   * Plugin checks in config order. Their matchers take precedence over built-in extraction, and
   * the first check that matches takes the claim (as `custom`, with `meta.check`).
   */
  matchers?: readonly Pick<PluginCheck, 'id' | 'match'>[];
  /** Claims between a `begin` and an `end` HTML comment (nesting counted) are dropped. */
  ignoreRegions?: IgnoreRegion[];
}

interface Pos {
  line: number;
  col: number;
}

const FENCE_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'shellsession']);
const CONSOLE_LANGS = new Set(['console', 'shellsession']);
const SNIPPET_LANGS = new Set(['ts', 'typescript', 'tsx', 'mts', 'cts']);
const PACKAGE_MANAGER_COMMAND = /^(?:npm|pnpm|yarn|bun|npx)(?=\s|$)/;
// ponytail: word test on the claim's line or paragraph; misses a "generated" said a paragraph away.
const GENERATED =
  /\b(?:(?:auto-?)?generated|generates?|created by|written by|output of|build output)\b/i;
const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Empties a leading YAML frontmatter block but keeps its line breaks, so line numbers hold. */
export function blankFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, (block) => block.replace(/[^\r\n]/g, ''));
}

export function textOf(node: Nodes): string {
  if ('value' in node) return node.value;
  return 'children' in node ? node.children.map(textOf).join('') : '';
}

export function parseMarkdown(text: string, file: string, opts: ParseOptions = {}): Claim[] {
  const src = blankFrontmatter(text);
  const tree = fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const lines = src.split(/\r?\n/);
  const lineStarts = [0];
  for (const m of src.matchAll(/\n/g)) lineStarts.push(m.index + 1);

  const headings: { depth: number; text: string }[] = [];
  const toggles: Toggle[] = [];
  const regionEvents: { delta: 1 | -1; line: number }[] = [];
  const claims: Claim[] = [];

  // ponytail: linear scan per lookup; use binary search if documents reach tens of thousands of lines.
  const posAt = (offset: number): Pos => {
    let i = 0;
    while (i + 1 < lineStarts.length && (lineStarts[i + 1] as number) <= offset) i++;
    return { line: i + 1, col: offset - (lineStarts[i] as number) + 1 };
  };

  /** Source text of the paragraph being visited. */
  let item = '';

  const add = (
    kind: ClaimKind,
    value: string,
    pos: Pos,
    source: ClaimSource,
    meta?: Record<string, string>,
  ): void => {
    // A file the docs say is generated or created may legitimately be missing from the checkout.
    if (kind === 'path' && (GENERATED.test(lines[pos.line - 1] ?? '') || GENERATED.test(item))) {
      meta = { ...meta, generated: 'true' };
    }
    claims.push({
      kind,
      value,
      file,
      line: pos.line,
      col: pos.col,
      section: headings.map((h) => h.text),
      source,
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
    });
  };

  const addPath = (parts: PathParts, pos: Pos, source: ClaimSource): void =>
    add('path', parts.value, pos, source, parts.meta);

  const matchers = opts.matchers ?? [];
  const adopted = new Map<string, string>();
  for (const m of matchers) {
    for (const bin of m.match.commands ?? []) if (!adopted.has(bin)) adopted.set(bin, m.id);
  }

  function inlineCode(node: InlineCode): void {
    const start = node.position?.start.offset;
    if (start === undefined) return;
    const fence = /^`+/.exec(src.slice(start))?.[0].length ?? 1;
    const code = node.value.trim();
    const lead = node.value.length - node.value.trimStart().length;
    const raw = src.slice(start + fence, node.position?.end.offset);
    const base = start + fence + Math.max(raw.indexOf(node.value), 0) + lead;
    const first = adopted.size > 0 ? leadingBinary(code) : undefined;
    const bin = first !== undefined && adopted.has(first) ? first : undefined;
    for (const m of matchers) {
      if (m.match.inlineCode?.test(code)) {
        return add('custom', code, posAt(base), 'inline-code', {
          check: m.id,
          matched: 'inline-code',
        });
      }
      if (bin !== undefined && m.match.commands?.includes(bin)) break;
    }
    if (bin !== undefined || PACKAGE_MANAGER_COMMAND.test(code)) {
      for (const c of parseShellLine(code, adopted)) {
        add(c.kind, c.value, posAt(base + c.index), 'inline-code', c.meta);
      }
      return;
    }
    const parts = inlinePath(code);
    if (parts) return addPath(parts, posAt(base), 'inline-code');
    const version = inlineVersion(code);
    if (version) return add('version', version.value, posAt(base), 'inline-code', version.meta);
    const symbol = inlineSymbol(code);
    if (symbol) add('symbol', symbol.value, posAt(base), 'inline-code', symbol.meta);
  }

  /** Position of a fence's first content line. */
  function blockPos(node: Code, first: number): Pos {
    const raw = lines[first] ?? '';
    const [head = ''] = node.value.split(/\r?\n/);
    const indent = raw.endsWith(head) ? raw.length - head.length : 0;
    return { line: first + 1, col: indent + 1 };
  }

  function snippet(node: Code, lang: string, first: number): void {
    add('snippet', node.value, blockPos(node, first), 'fence', {
      lang,
      ...(node.meta ? { info: node.meta } : {}),
    });
  }

  function fence(node: Code): void {
    const lang = node.lang?.toLowerCase();
    const first = node.position?.start.line;
    if (!lang || first === undefined) return;
    const owner = matchers.find((m) => m.match.fences?.some((f) => f.toLowerCase() === lang));
    if (owner) {
      return add('custom', node.value, blockPos(node, first), 'fence', {
        check: owner.id,
        matched: 'fence',
        lang,
      });
    }
    if (SNIPPET_LANGS.has(lang)) return snippet(node, lang, first);
    if (!FENCE_LANGS.has(lang)) return;
    const pieces: Piece[] = node.value.split(/\r?\n/).map((text, i) => {
      const raw = lines[first + i] ?? '';
      const indent = raw.endsWith(text) ? raw.length - text.length : 0;
      return { text, line: first + 1 + i, col: indent + 1 };
    });
    const shell = {}; // a `cd` holds for the rest of the fence
    for (const logical of logicalLines(pieces, CONSOLE_LANGS.has(lang))) {
      for (const c of parseShellLine(logical.text, adopted, shell)) {
        add(c.kind, c.value, logical.locate(c.index), 'fence', c.meta);
      }
    }
  }

  function link(url: string, node: Nodes): void {
    const start = node.position?.start;
    if (!start) return;
    const pos = { line: start.line, col: start.column };
    const owner = matchers.find((m) => m.match.links?.test(url));
    if (owner) return add('custom', url, pos, 'link', { check: owner.id, matched: 'link' });
    const parts = linkPath(url);
    if (parts) addPath(parts, pos, 'link');
  }

  function prose(node: Text): void {
    const start = node.position?.start.offset;
    if (start === undefined) return;
    const raw = src.slice(start, node.position?.end.offset);
    for (const t of proseTokens(raw)) addPath(t, posAt(start + t.index), 'prose');
  }

  let linkDepth = 0;

  function visit(node: Nodes, muted: boolean): void {
    switch (node.type) {
      case 'heading':
        while ((headings.at(-1)?.depth ?? 0) >= node.depth) headings.pop();
        headings.push({ depth: node.depth, text: textOf(node) });
        break;
      case 'html': {
        const marker = markerOf(node.value);
        const line = node.position?.start.line;
        if ((marker === 'disable' || marker === 'enable') && line !== undefined) {
          toggles.push({ marker, line });
        }
        const delta = regionDelta(node.value, opts.ignoreRegions ?? []);
        if (delta !== 0 && line !== undefined) regionEvents.push({ delta, line });
        return;
      }
      case 'inlineCode':
        if (!muted) inlineCode(node);
        return;
      case 'code':
        if (!muted) fence(node);
        return;
      case 'definition':
      case 'image':
        if (!muted) link(node.url, node);
        return;
      case 'link':
        if (!muted) link(node.url, node);
        break;
      case 'text':
        if (!muted && opts.prose && linkDepth === 0) prose(node);
        return;
    }
    if (!('children' in node)) return;
    let skip = false;
    const outer = item;
    if (node.type === 'paragraph') {
      item = src.slice(node.position?.start.offset, node.position?.end.offset);
    }
    if (node.type === 'link') linkDepth++;
    for (const child of node.children) {
      visit(child, muted || skip);
      skip = child.type === 'html' && markerOf(child.value) === 'ignore';
    }
    if (node.type === 'link') linkDepth--;
    item = outer;
  }

  visit(tree, false);
  const ranges = [...disabledRanges(toggles), ...regionRanges(regionEvents)];
  return claims.filter((c) => !isDisabled(c.line, ranges));
}
