/** Damerau-Levenshtein distance (optimal string alignment variant). */
export function distance(a: string, b: string): number {
  const cols = b.length + 1;
  const d = new Array<number>((a.length + 1) * cols).fill(0);
  const at = (i: number, j: number) => d[i * cols + j] ?? 0;
  for (let i = 0; i <= a.length; i++) d[i * cols] = i;
  for (let j = 0; j <= b.length; j++) d[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, at(i - 2, j - 2) + 1);
      }
      d[i * cols + j] = v;
    }
  }
  return at(a.length, b.length);
}

/** Nearest candidate within `maxDistance` (ties: first wins); never returns an identical string. */
export function closest(
  value: string,
  candidates: readonly string[],
  maxDistance: number,
): string | undefined {
  let best: string | undefined;
  let bestDistance = maxDistance + 1;
  for (const c of candidates) {
    if (c === value) continue;
    const dist = distance(value, c);
    if (dist < bestDistance) {
      best = c;
      bestDistance = dist;
    }
  }
  return best;
}
