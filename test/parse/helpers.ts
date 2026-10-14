import type { Claim } from '../../src/types.js';

export const FILE = 'AGENTS.md';

/** Full claim with the defaults most tests share. */
export function claim(o: Pick<Claim, 'kind' | 'value' | 'line' | 'col'> & Partial<Claim>): Claim {
  return { file: FILE, section: [], source: 'inline-code', ...o };
}

/** Wraps lines in a fenced block of the given language. */
export function fenced(lang: string, ...body: string[]): string {
  return ['```' + lang, ...body, '```'].join('\n');
}
