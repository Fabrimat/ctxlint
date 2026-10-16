import type { LlmTotals } from '../types.js';
import { costUsd, type PricingTable } from './pricing.js';
import type { LlmProvider, LlmRequest, LlmResponse, LlmUsage } from './provider.js';

/** Deliberately conservative for code and JSON. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 2.5);

export interface Reservation {
  model: string;
  /** False when the model has no known price (unlimited budgets only). */
  priced: boolean;
  /** Worst-case cost held against the budget; 0 when the price is unknown and the budget unlimited. */
  held: number;
}

/**
 * Spend ceiling. `reserve` holds the worst case synchronously before a call, so concurrent calls
 * can never overshoot: `spent + reserved + worst > max` is skipped.
 */
export class Budget {
  private spent = 0;
  private reserved = 0;
  private unpriced = false;
  private estimated = false;
  private calls = 0;
  private failedCalls = 0;
  private skipped = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private latencyMs = 0;
  private readonly models = new Set<string>();

  /** `maxUsd` null means unlimited. */
  constructor(
    private readonly maxUsd: number | null,
    private readonly pricing: PricingTable,
  ) {}

  /** Null (and counted as skipped): over budget, or no known price under a finite budget. */
  reserve(model: string, inputTokens: number, maxTokens: number): Reservation | null {
    const worst = costUsd(this.pricing, model, {
      inputTokens,
      outputTokens: maxTokens,
      cacheReadTokens: 0,
    });
    if (
      this.maxUsd !== null &&
      (worst === null || this.spent + this.reserved + worst > this.maxUsd)
    ) {
      this.skipped++;
      return null;
    }
    this.reserved += worst ?? 0;
    return { model, priced: worst !== null, held: worst ?? 0 };
  }

  /**
   * Replaces the reservation by the actual cost. A sent call with no usage (timeout, invalid
   * output) may still have been billed, so it is charged at the reserved worst case; only a call
   * that never reached the API (`sent` false) is released.
   */
  settle(r: Reservation, usage: LlmUsage | null, sent = true): void {
    this.reserved -= r.held;
    if (usage === null) {
      if (!sent) return;
      this.estimated = true;
      if (r.priced) this.spent += r.held;
      else this.unpriced = true;
      return;
    }
    const cost = costUsd(this.pricing, r.model, usage);
    if (cost === null) this.unpriced = true;
    else this.spent += cost;
  }

  /** Counts a sent call and its tokens. */
  record(res: LlmResponse<unknown>): void {
    this.calls++;
    if (!res.ok) this.failedCalls++;
    this.latencyMs += res.latencyMs;
    this.models.add(res.model);
    if (res.usage) {
      this.inputTokens += res.usage.inputTokens;
      this.outputTokens += res.usage.outputTokens;
      this.cacheReadTokens += res.usage.cacheReadTokens;
    }
  }

  /** Counts a section or call that was not run for a reason other than the budget. */
  skip(): void {
    this.skipped++;
  }

  totals(): LlmTotals {
    return {
      calls: this.calls,
      failedCalls: this.failedCalls,
      skipped: this.skipped,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      costUsd: this.unpriced ? null : this.spent,
      costEstimated: this.estimated,
      latencyMs: this.latencyMs,
      budgetUsd: this.maxUsd,
      models: [...this.models].sort(),
    };
  }
}

/** reserve, call, settle; a skipped call fails with `budget` without calling the provider. */
export async function callWithBudget<T>(
  budget: Budget,
  provider: LlmProvider,
  req: LlmRequest<T>,
): Promise<LlmResponse<T>> {
  const reservation = budget.reserve(
    req.model,
    estimateTokens(req.system) + estimateTokens(req.prompt),
    req.maxTokens,
  );
  if (reservation === null) {
    return {
      ok: false,
      reason: 'budget',
      detail: 'the call would exceed the cost budget',
      usage: null,
      sent: false,
      model: req.model,
      latencyMs: 0,
    };
  }
  const res = await provider.complete(req);
  budget.settle(reservation, res.usage, res.ok || res.sent !== false);
  // A call that never reached the API (no key, no SDK) is skipped, not a call.
  if (!res.ok && res.sent === false) budget.skip();
  else budget.record(res);
  return res;
}
