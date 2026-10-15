import { describe, expect, it } from 'vitest';
import { multiBisect, type Evaluator } from '../src/blame.js';

/** Fake evaluator: id fails from `failAt[id]` on (never when absent). */
function fake(failAt: Record<number, number>) {
  const calls: number[] = [];
  const evaluator: Evaluator = async (index, ids) => {
    calls.push(index);
    return new Map(ids.map((id) => [id, index >= (failAt[id] ?? Infinity) ? 'fail' : 'ok']));
  };
  return { evaluator, calls };
}

describe('multiBisect', () => {
  it('finds each first failing index from different starts', async () => {
    const { evaluator } = fake({ 0: 3, 1: 10, 2: 7 });
    const out = await multiBisect(
      [
        { id: 0, lo: 0 },
        { id: 1, lo: 5 },
        { id: 2, lo: 7 },
      ],
      15,
      evaluator,
    );
    expect(Object.fromEntries(out)).toEqual({ 0: 3, 1: 10, 2: 7 });
  });

  it('shares probes between findings with the same range', async () => {
    const failAt = { 0: 9, 1: 9, 2: 9, 3: 9 };
    const shared = fake(failAt);
    const items = [0, 1, 2, 3].map((id) => ({ id, lo: 0 }));
    await multiBisect(items, 63, shared.evaluator);
    let independent = 0;
    for (const item of items) {
      const solo = fake(failAt);
      await multiBisect([item], 63, solo.evaluator);
      independent += solo.calls.length;
    }
    expect(shared.calls.length).toBeLessThan(independent);
    expect(shared.calls.length).toBeLessThanOrEqual(7);
  });

  it('returns lo when the claim already fails there', async () => {
    const { evaluator } = fake({ 0: 4 });
    expect((await multiBisect([{ id: 0, lo: 4 }], 9, evaluator)).get(0)).toBe(4);
  });

  it('treats unknown as not failing', async () => {
    const evaluator: Evaluator = async (index, ids) =>
      new Map(ids.map((id) => [id, index >= 6 ? 'fail' : index >= 2 ? 'unknown' : 'ok']));
    expect((await multiBisect([{ id: 0, lo: 0 }], 9, evaluator)).get(0)).toBe(6);
    const allUnknown: Evaluator = async (_i, ids) => new Map(ids.map((id) => [id, 'unknown']));
    expect((await multiBisect([{ id: 0, lo: 0 }], 9, allUnknown)).get(0)).toBeNull();
  });

  it('returns null when the claim passes at the last commit', async () => {
    const { evaluator, calls } = fake({});
    expect((await multiBisect([{ id: 0, lo: 0 }], 9, evaluator)).get(0)).toBeNull();
    expect(calls).toEqual([9]);
  });
});
