export type Marker = 'ignore' | 'disable' | 'enable';

const MARKER = /^<!--\s*ctxtruth-(ignore|disable|enable)\s*-->$/;

/** Recognises `<!-- ctxtruth-ignore|disable|enable -->` (case-sensitive). */
export function markerOf(html: string): Marker | null {
  const m = MARKER.exec(html.trim());
  return m ? (m[1] as Marker) : null;
}

export interface Toggle {
  marker: 'disable' | 'enable';
  line: number;
}

/** Pairs disable/enable comments into [from, to] line ranges; an unclosed disable runs to EOF. */
export function disabledRanges(toggles: readonly Toggle[]): [number, number][] {
  const ranges: [number, number][] = [];
  let open: number | null = null;
  for (const t of toggles) {
    if (t.marker === 'disable' && open === null) open = t.line;
    else if (t.marker === 'enable' && open !== null) {
      ranges.push([open, t.line]);
      open = null;
    }
  }
  if (open !== null) ranges.push([open, Infinity]);
  return ranges;
}

export function isDisabled(line: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([from, to]) => line > from && line < to);
}
