import type { Nodes } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { blankFrontmatter, textOf } from './index.js';

/** A heading and its own body, up to the next heading of any depth; lines are 1-based, inclusive. */
export interface Section {
  /** Heading path, e.g. `["Setup", "Scripts"]`; `[]` for the preamble before the first heading. */
  path: string[];
  startLine: number;
  endLine: number;
}

/** The sections of a Markdown document in order; the preamble only when it has lines. */
export function sectionsOf(markdown: string): Section[] {
  const src = blankFrontmatter(markdown);
  const tree = fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const lineCount = src.split(/\r?\n/).length - (/\n$/.test(src) || src === '' ? 1 : 0);

  const headings: { depth: number; text: string; line: number }[] = [];
  const visit = (node: Nodes): void => {
    if (node.type === 'heading' && node.position) {
      headings.push({ depth: node.depth, text: textOf(node), line: node.position.start.line });
      return;
    }
    if ('children' in node) for (const child of node.children) visit(child);
  };
  visit(tree);

  const out: Section[] = [];
  const first = headings[0]?.line ?? lineCount + 1;
  if (first > 1) out.push({ path: [], startLine: 1, endLine: first - 1 });
  const stack: { depth: number; text: string }[] = [];
  headings.forEach((h, i) => {
    while ((stack.at(-1)?.depth ?? 0) >= h.depth) stack.pop();
    stack.push(h);
    const next = headings[i + 1]?.line ?? lineCount + 1;
    out.push({ path: stack.map((s) => s.text), startLine: h.line, endLine: next - 1 });
  });
  return out;
}
