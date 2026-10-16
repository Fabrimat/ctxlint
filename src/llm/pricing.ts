import type { LlmConfig } from '../config/index.js';

/** USD per 1M tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

/** `long` applies when the request's input exceeds `LONG_INPUT_TOKENS`. */
export type PricingTable = Record<string, Price & { long?: Price }>;

export const LONG_INPUT_TOKENS = 100_000;

export const DEFAULT_PRICING: PricingTable = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    long: { input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
};

/** The defaults with the user's prices on top; an unset `cacheRead` costs the same as input. */
export function buildPricing(user: LlmConfig['pricing']): PricingTable {
  const table: PricingTable = { ...DEFAULT_PRICING };
  for (const [model, p] of Object.entries(user)) {
    table[model] = { input: p.input, output: p.output, cacheRead: p.cacheRead ?? p.input };
  }
  return table;
}

/** Cost in USD of `tokens` on `model`; null for a model with no known price. */
export function costUsd(
  pricing: PricingTable,
  model: string,
  tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
): number | null {
  if (!Object.hasOwn(pricing, model)) return null;
  const entry = pricing[model] as PricingTable[string];
  const long = tokens.inputTokens + tokens.cacheReadTokens > LONG_INPUT_TOKENS;
  const p = (long ? entry.long : undefined) ?? entry;
  return (
    (tokens.inputTokens * p.input +
      tokens.outputTokens * p.output +
      tokens.cacheReadTokens * p.cacheRead) /
    1_000_000
  );
}
