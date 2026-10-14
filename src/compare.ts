import type { ChangedFiles } from './git/diff.js';
import { fingerprint, type CheckId, type CheckResult, type Comparison } from './types.js';

type Counts = Omit<Comparison, 'base' | 'baseSha'>;

/** Checks whose base results depend on installed packages, which the base checkout lacks. */
const ENVIRONMENT_CHECKS: ReadonlySet<CheckId> = new Set(['commands', 'versions']);

/** A base result with its doc path mapped through the renames since the base. */

export function renamed(r: CheckResult, renames: Map<string, string>): CheckResult {
  const to = renames.get(r.claim.file);
  return to === undefined ? r : { ...r, claim: { ...r.claim, file: to } };
}

function groupByKey(results: readonly CheckResult[]): Map<string, CheckResult[]> {
  const out = new Map<string, CheckResult[]>();
  for (const r of results) {
    const k = fingerprint(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

const docOrder = (a: CheckResult, b: CheckResult): number =>
  a.claim.line - b.claim.line || a.claim.col - b.claim.col;

/**
 * `--changed-only`: keep results whose doc changed or whose resolved files (at head or, for the
 * same claim, at the base) changed. A speed filter that trades recall: a claim can go stale
 * through files it does not resolve to (e.g. a deleted file a path claim never resolved).
 */
export function changedOnly(
  head: CheckResult[],
  base: readonly CheckResult[],
  diff: ChangedFiles,
): CheckResult[] {
  const baseFiles = new Map<string, string[]>();
  for (const r of base) {
    const k = fingerprint(r);
    baseFiles.set(k, [...(baseFiles.get(k) ?? []), ...r.resolvedFiles]);
  }
  return head.filter(
    (r) =>
      diff.changed.has(r.claim.file) ||
      [...r.resolvedFiles, ...(baseFiles.get(fingerprint(r)) ?? [])].some((f) =>
        diff.changed.has(f),
      ),
  );
}

/**
 * `--new-only`: sets `baseline` on every failing head result (and `introducedBy` on new ones) by
 * matching claims with the base run, and counts the comparison. Matching is per fingerprint and
 * counted, in document order: N failures at the base cover the first N failures at head.
 */
export function classify(
  head: readonly CheckResult[],
  base: readonly CheckResult[],
  diff: ChangedFiles,
): Counts {
  const counts: Counts = { introduced: 0, existing: 0, fixed: 0, notComparable: 0 };
  const baseByKey = groupByKey(base);
  for (const [key, results] of groupByKey(head)) {
    const was = baseByKey.get(key) ?? [];
    let fails = was.filter((r) => r.status === 'fail').length;
    let passes = was.filter((r) => r.status === 'pass').length;
    let unknowns = was.filter((r) => r.status === 'unknown').length;
    for (const r of results.filter((x) => x.status === 'fail').sort(docOrder)) {
      if (fails > 0) {
        fails--;
        r.baseline = 'existing';
        counts.existing++;
      } else if (passes > 0) {
        passes--;
        r.baseline = 'new';
        counts.introduced++;
        // `code` only when the doc file itself is untouched: a doc edit can change how an
        // identical claim resolves (moved doc, workspace filter), so it is attributed to the docs.
        if (r.finding) r.finding.introducedBy = diff.changed.has(r.claim.file) ? 'docs' : 'code';
      } else if (unknowns > 0) {
        unknowns--;
        r.baseline = 'not-comparable';
        counts.notComparable++;
      } else {
        r.baseline = 'new';
        counts.introduced++;
        if (r.finding) r.finding.introducedBy = 'docs';
      }
    }
    // Base failures left over are fixed when the claim is still there and passes; a removed claim
    // is not a fix. Commands and versions are skipped: the base checkout has no node_modules, so
    // their base failures can come from the environment rather than the code.
    const id = results[0]?.checkId;
    if (id !== undefined && ENVIRONMENT_CHECKS.has(id)) continue;
    counts.fixed += Math.min(fails, results.filter((x) => x.status === 'pass').length);
  }
  return counts;
}
