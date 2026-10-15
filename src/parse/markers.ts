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

export interface IgnoreRegion {
  begin: RegExp;
  end: RegExp;
}

/** +1 when the HTML matches a region's `begin`, -1 when it matches an `end`, else 0. */
export function regionDelta(html: string, regions: readonly IgnoreRegion[]): 1 | -1 | 0 {
  const v = html.trim();
  if (regions.some((r) => r.begin.test(v))) return 1;
  return regions.some((r) => r.end.test(v)) ? -1 : 0;
}

/** Turns begin/end lines (in document order) into [from, to] ranges via a floored depth counter. */
export function regionRanges(
  events: readonly { delta: 1 | -1; line: number }[],
): [number, number][] {
  const ranges: [number, number][] = [];
  let depth = 0;
  let from = 0;
  for (const e of events) {
    if (e.delta === 1) {
      if (depth++ === 0) from = e.line;
    } else if (depth > 0 && --depth === 0) ranges.push([from, e.line]);
  }
  if (depth > 0) ranges.push([from, Infinity]);
  return ranges;
}
