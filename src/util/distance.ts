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

/**
 * A typo-sized rename of `a` into `b`: both 6+ chars, and one edit, or two that change the length
 * and sit together (`ModelToTable` -> `ModelTable`). Two substitutions make another word
 * (`TaskResult` -> `WalkResult`, `EncodeContext` -> `DecodeContext`).
 */
export function isRename(a: string, b: string): boolean {
  if (a === b || a.length < 6 || b.length < 6) return false;
  const d = distance(a, b);
  if (d === 1) return true;
  if (d !== 2 || a.length === b.length) return false;
  let pre = 0;
  while (pre < Math.min(a.length, b.length) && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < Math.min(a.length, b.length) - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  return pre + suf >= Math.max(a.length, b.length) - 2;
}
