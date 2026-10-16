import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Budget, callWithBudget, estimateTokens, type Reservation } from '../../src/llm/budget.js';
import { FakeProvider } from '../../src/llm/fake.js';
import { buildPricing, costUsd, DEFAULT_PRICING } from '../../src/llm/pricing.js';
import type { LlmRequest, LlmResponse } from '../../src/llm/provider.js';

const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 };
const ok = (u = usage): LlmResponse<unknown> => ({
  ok: true,
  value: {},
  usage: u,
  model: 'claude-sonnet-5-5',
  latencyMs: 5,
});
const req = (over: Partial<LlmRequest<unknown>> = {}): LlmRequest<unknown> => ({
  task: 'classify',
  model: 'claude-sonnet-5-5',
  system: 's',
  prompt: 'p'.repeat(2500),
  schema: z.object({}),
  maxTokens: 1000,
  ...over,
});

describe('pricing', () => {
  it('prices the built-in models per million tokens', () => {
    expect(costUsd(DEFAULT_PRICING, 'claude-opus-5-5', usage)).toBeCloseTo(
      (1000 * 4 + 500 * 20) / 1e6,
    );
    expect(
      costUsd(DEFAULT_PRICING, 'claude-fable-5-1', { ...usage, cacheReadTokens: 1_000_000 }),
    ).toBeCloseTo((1000 * 10 + 500 * 50) / 1e6 + 0.25);
  });

  it('uses the Haiku long-input tier above 100K input tokens', () => {
    const low = { inputTokens: 100_000, outputTokens: 1_000_000, cacheReadTokens: 0 };
    const high = { ...low, inputTokens: 100_001 };
    expect(costUsd(DEFAULT_PRICING, 'claude-haiku-5-5', low)).toBeCloseTo(0.01 + 0.5);
    expect(costUsd(DEFAULT_PRICING, 'claude-haiku-5-5', high)).toBeCloseTo(0.050001 + 2.5);
  });

  it('has no OpenAI defaults, and users add their own', () => {
    expect(costUsd(DEFAULT_PRICING, 'gpt-5.5', usage)).toBeNull();
    const table = buildPricing({ 'gpt-5.5': { input: 1, output: 2 } });
    expect(costUsd(table, 'gpt-5.5', usage)).toBeCloseTo((1000 + 1000) / 1e6);
    expect(table['claude-opus-5-5']).toBeDefined();
  });
});

describe('estimateTokens', () => {
  it('is chars / 2.5 rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('abcdef')).toBe(3);
  });
});

describe('Budget', () => {
  it('reserves the worst case and settles to the actual cost', () => {
    const b = new Budget(1, DEFAULT_PRICING);
    const r = b.reserve('claude-sonnet-5-5', 1000, 1000);
    expect(r).not.toBeNull();
    b.settle(r as Reservation, usage);
    expect(b.totals().costUsd).toBeCloseTo((1000 * 2 + 500 * 10) / 1e6);
    expect(b.totals().budgetUsd).toBe(1);
  });

  it('skips a call that would not fit, counting it', () => {
    const b = new Budget(0.001, DEFAULT_PRICING);
    expect(b.reserve('claude-opus-5-5', 100_000, 10_000)).toBeNull();
    expect(b.totals().skipped).toBe(1);
  });

  it('releases the reservation of a failed call', () => {
    const b = new Budget(0.02, DEFAULT_PRICING);
    const r = b.reserve('claude-sonnet-5-5', 1000, 1000);
    b.settle(r as Reservation, null, false);
    expect(b.totals().costUsd).toBe(0);
    expect(b.reserve('claude-sonnet-5-5', 1000, 1000)).not.toBeNull();
  });

  it('skips an unknown price under a finite budget but not an unlimited one', () => {
    expect(new Budget(1, DEFAULT_PRICING).reserve('gpt-x', 10, 10)).toBeNull();
    const unlimited = new Budget(null, DEFAULT_PRICING);
    const r = unlimited.reserve('gpt-x', 10, 10);
    expect(r).not.toBeNull();
    unlimited.settle(r as Reservation, usage);
    expect(unlimited.totals().costUsd).toBeNull();
    expect(unlimited.totals().budgetUsd).toBeNull();
  });

  it('counts other skips', () => {
    const b = new Budget(null, DEFAULT_PRICING);
    b.skip();
    expect(b.totals().skipped).toBe(1);
  });

  it('prices the Haiku tier from the estimated input', () => {
    const b = new Budget(1, DEFAULT_PRICING);
    b.settle(b.reserve('claude-haiku-5-5', 200_000, 0) as Reservation, {
      ...usage,
      inputTokens: 200_000,
    });
    expect(b.totals().costUsd).toBeCloseTo((200_000 * 0.5 + 500 * 2.5) / 1e6);
  });
});

describe('callWithBudget', () => {
  it('does not call the provider when over budget', async () => {
    const provider = new FakeProvider(() => ok());
    const res = await callWithBudget(new Budget(0, DEFAULT_PRICING), provider, req());
    expect(res).toMatchObject({ ok: false, reason: 'budget', usage: null });
    expect(provider.requests).toHaveLength(0);
  });

  it('records calls, tokens and failures', async () => {
    const budget = new Budget(1, DEFAULT_PRICING);
    let n = 0;
    const provider = new FakeProvider(() =>
      n++ === 0
        ? ok()
        : {
            ok: false,
            reason: 'refused',
            detail: 'x',
            usage,
            model: 'claude-sonnet-5-5',
            latencyMs: 3,
          },
    );
    await callWithBudget(budget, provider, req());
    await callWithBudget(budget, provider, req());
    expect(budget.totals()).toMatchObject({
      calls: 2,
      failedCalls: 1,
      inputTokens: 2000,
      outputTokens: 1000,
      latencyMs: 8,
      models: ['claude-sonnet-5-5'],
    });
  });

  it('never exceeds the budget under 20 concurrent calls', async () => {
    // Each call reserves ~ (1001 in * 2 + 1000 out * 10) / 1e6 = $0.012 and costs less.
    const max = 0.1;
    const budget = new Budget(max, DEFAULT_PRICING);
    const provider = new FakeProvider(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return ok({ inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 });
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => callWithBudget(budget, provider, req())),
    );
    const t = budget.totals();
    expect(t.costUsd).toBeLessThanOrEqual(max);
    expect(results.filter((r) => r.ok).length).toBe(provider.requests.length);
    expect(provider.requests.length).toBeLessThan(20);
    expect(t.skipped).toBe(20 - provider.requests.length);
  });
});

describe('FakeProvider', () => {
  it('answers from the responder and records requests', async () => {
    const provider = new FakeProvider((r) => ({ ...ok(), model: r.model }));
    const res = await provider.complete(req({ model: 'm' }));
    expect(res).toMatchObject({ ok: true, model: 'm' });
    expect(provider.name).toBe('fake');
    expect(provider.requests).toHaveLength(1);
  });

  it('turns a throwing responder into a failure', async () => {
    const provider = new FakeProvider(() => {
      throw new Error('boom');
    });
    expect(await provider.complete(req())).toMatchObject({
      ok: false,
      reason: 'error',
      detail: 'boom',
    });
  });
});

describe('budget leak', () => {
  const invalid = (sent?: boolean): LlmResponse<unknown> => ({
    ok: false,
    reason: sent === false ? 'no-key' : 'invalid',
    detail: 'x',
    usage: null,
    ...(sent === false && { sent }),
    model: 'claude-sonnet-5-5',
    latencyMs: 1,
  });

  it('charges a sent call without usage at the worst case and flags the estimate', async () => {
    const budget = new Budget(1, DEFAULT_PRICING);
    await callWithBudget(budget, new FakeProvider(() => invalid()), req());
    const t = budget.totals();
    expect(t.costEstimated).toBe(true);
    // 1001 estimated input tokens at $2/M plus 1000 output tokens at $10/M
    expect(t.costUsd).toBeCloseTo((1001 * 2 + 1000 * 10) / 1e6);
  });

  it('releases a call that never reached the API', async () => {
    const budget = new Budget(1, DEFAULT_PRICING);
    await callWithBudget(budget, new FakeProvider(() => invalid(false)), req());
    expect(budget.totals()).toMatchObject({ costUsd: 0, costEstimated: false });
  });

  it('counts a call that never reached the API as skipped, not as a call', async () => {
    const budget = new Budget(1, DEFAULT_PRICING);
    await callWithBudget(budget, new FakeProvider(() => invalid(false)), req());
    expect(budget.totals()).toMatchObject({ calls: 0, failedCalls: 0, skipped: 1 });
  });

  it('never exceeds the budget under 20 concurrent invalid calls', async () => {
    const max = 0.1;
    const budget = new Budget(max, DEFAULT_PRICING);
    const provider = new FakeProvider(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return invalid();
    });
    await Promise.all(Array.from({ length: 20 }, () => callWithBudget(budget, provider, req())));
    expect(budget.totals().costUsd).toBeLessThanOrEqual(max);
    expect(provider.requests.length).toBeLessThan(20);
  });
});
