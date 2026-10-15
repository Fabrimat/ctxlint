import { describe, expect, it, vi } from 'vitest';
import { adapt } from '../../src/plugin/adapter.js';
import type { PluginCheck, PluginClaim, PluginContext } from '../../src/plugin/types.js';
import type { Claim, RepoIndex } from '../../src/types.js';
import { makeClaim, makeCtx, makeIndex } from '../helpers/repo.js';

const claims: Claim[] = [
  makeClaim({ kind: 'custom', value: 'id:a', meta: { check: 'p/c', matched: 'inline-code' } }),
  makeClaim({ kind: 'custom', value: 'p go --x', meta: { check: 'p/c', matched: 'command' } }),
];

function run(verify: PluginCheck['verify'], over: Partial<PluginCheck> = {}, index?: RepoIndex) {
  const check: PluginCheck = { id: 'p/c', match: { inlineCode: /^id:(\w)$/ }, verify, ...over };
  return adapt('p', check, { opt: 1 }).run(claims, makeCtx(index ?? makeIndex(), 'warning'));
}

describe('plugin adapter', () => {
  it('passes plugin claims and context, and maps verdicts', async () => {
    let seen: { claims: readonly PluginClaim[]; ctx: PluginContext } | undefined;
    const results = await run((cs, ctx) => {
      seen = { claims: cs, ctx };
      return [
        { status: 'fail', message: 'nope', suggestion: 'id:b' },
        { status: 'pass', resolvedFiles: ['x.json'] },
      ];
    });
    expect(seen?.claims[0]).toMatchObject({ matched: 'inline-code', groups: ['a'] });
    expect(seen?.claims[1]).toMatchObject({ matched: 'command', argv: ['p', 'go', '--x'] });
    expect(seen?.ctx).toMatchObject({ pastCommit: false, options: { opt: 1 } });
    expect(results[0]?.finding).toMatchObject({
      checkId: 'p/c',
      severity: 'warning',
      message: 'nope',
      suggestion: 'id:b',
    });
    expect(results[1]).toMatchObject({ status: 'pass', resolvedFiles: ['x.json'] });
  });

  it.each([
    ['a throw', () => Promise.reject(new Error('boom')), /plugin p: verify failed: boom/],
    ['a length mismatch', () => [{ status: 'pass' as const }], /plugin p: verify returned 1/],
    ['a non-array', () => 'garbage' as never, /plugin p: verify returned string/],
  ])('turns %s into unknown for every claim', async (_, verify, reason) => {
    const results = await run(verify);
    expect(results.map((r) => r.status)).toEqual(['unknown', 'unknown']);
    expect(results[0]?.reason).toMatch(reason);
  });

  it('turns an invalid verdict into unknown for that claim only', async () => {
    const results = await run(() => [{ status: 'fail' } as never, { status: 'pass' }]);
    expect(results.map((r) => r.status)).toEqual(['unknown', 'pass']);
    expect(results[0]?.reason).toBe('plugin p: invalid verdict');
  });

  it('does not call an environment check at a past commit', async () => {
    const verify = vi.fn(() => []);
    const past = { ...makeIndex(), depsRoot: '/head' };
    const results = await run(verify, { environment: true }, past);
    expect(verify).not.toHaveBeenCalled();
    expect(results.map((r) => r.reason)).toEqual([
      'depends on the environment, not the checkout',
      'depends on the environment, not the checkout',
    ]);
  });

  it('refuses readFile outside the checkout', async () => {
    const results = await run(async (_, ctx) => {
      await ctx.readFile('../secret');
      return [];
    });
    expect(results[0]?.reason).toMatch(/outside the checkout/);
  });
});
