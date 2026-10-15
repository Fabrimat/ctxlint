import { describe, expect, it } from 'vitest';
import { EpisodeTracker, summarize, type CommitRef, type SlimResult } from '../src/history.js';

const commit = (n: number): CommitRef => ({
  sha: `sha${n}`,
  date: `2025-01-${String(n).padStart(2, '0')}T00:00:00Z`,
  subject: `c${n}`,
});
const res = (
  value: string,
  status: SlimResult['status'],
  over: Partial<SlimResult> = {},
): SlimResult => ({
  fingerprint: `paths\0README.md\0path\0${value}`,
  status,
  checkId: 'paths',
  kind: 'path',
  file: 'README.md',
  line: 1,
  value,
  section: [],
  ...(status === 'fail' && { message: `${value} missing` }),
  ...over,
});
const none = new Set<string>();
const docs = new Set(['README.md']);

function run(steps: [Set<string>, SlimResult[]][]) {
  const t = new EpisodeTracker('r');
  steps.forEach(([changed, results], i) => t.push(commit(i + 1), changed, results));
  return t.finish();
}

describe('EpisodeTracker', () => {
  it('opens by code and closes by docs, with commits and days', () => {
    const [e, ...rest] = run([
      [none, [res('a', 'pass')]],
      [none, [res('a', 'fail')]],
      [none, [res('a', 'fail')]],
      [docs, []],
    ]);
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      cause: 'code',
      resolution: 'docs',
      commitsOpen: 2,
      daysOpen: 2,
      censored: false,
      openedAt: { sha: 'sha2' },
      closedAt: { sha: 'sha4' },
    });
  });

  it('opens by docs and closes by code, open ones run to the last commit', () => {
    const eps = run([
      [none, []],
      [docs, [res('a', 'fail'), res('b', 'fail')]],
      [none, [res('a', 'pass'), res('b', 'fail')]],
      [none, [res('a', 'pass'), res('b', 'fail')]],
    ]);
    expect(eps.find((e) => e.value === 'a')).toMatchObject({
      cause: 'docs',
      resolution: 'code',
      daysOpen: 1,
    });
    expect(eps.find((e) => e.value === 'b')).toMatchObject({
      cause: 'docs',
      commitsOpen: 2,
      daysOpen: 2,
    });
    expect(eps.find((e) => e.value === 'b')?.closedAt).toBeUndefined();
  });

  it('unknown neither opens nor closes', () => {
    const eps = run([
      [none, [res('a', 'pass')]],
      [none, [res('a', 'unknown')]],
      [none, [res('a', 'fail')]],
      [none, [res('a', 'unknown')]],
      [none, [res('a', 'pass')]],
    ]);
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ openedAt: { sha: 'sha3' }, closedAt: { sha: 'sha5' } });
  });

  it('flags a failure at the first commit as censored', () => {
    const [e] = run([[none, [res('a', 'fail')]]]);
    expect(e).toMatchObject({ cause: 'unknown', censored: true, daysOpen: 0 });
  });

  it('counts matching: two identical claims, one breaks', () => {
    const eps = run([
      [none, [res('a', 'pass', { line: 1 }), res('a', 'pass', { line: 5 })]],
      [none, [res('a', 'pass', { line: 1 }), res('a', 'fail', { line: 5 })]],
    ]);
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ cause: 'code' });
  });

  it('summarizes', () => {
    const eps = run([
      [none, [res('a', 'pass')]],
      [none, [res('a', 'fail')]],
      [docs, [res('a', 'pass'), res('b', 'fail')]],
    ]);
    expect(summarize(eps)).toMatchObject({
      episodes: 2,
      open: 1,
      openPct: 50,
      causes: { code: 1, docs: 1, unknown: 0 },
      medianDaysClosed: 1,
      topFiles: [{ file: 'README.md', episodes: 2 }],
    });
  });
});
