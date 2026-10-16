import type * as Sdk from '@anthropic-ai/sdk';
import type { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ZodError } from 'zod';
import type { LlmFailure, LlmProvider, LlmRequest, LlmResponse, LlmUsage } from './provider.js';
import { unbilled } from './provider.js';

type Format = ReturnType<typeof zodOutputFormat>;

export interface AnthropicParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user'; content: string }[];
  output_config: { format: Format; effort: 'low' | 'medium' };
  /** Fix on the models below only: server-side refusal fallback (beta surface). */
  betas?: string[];
  fallbacks?: 'default';
}

/** The slice of the SDK result the adapter reads. */
export interface AnthropicMessage {
  model: string;
  stop_reason: string | null;
  parsed_output: unknown;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number | null };
}

interface Parser {
  parse(params: AnthropicParams): Promise<AnthropicMessage>;
}

/** The slice of the SDK client the adapter calls; tests pass a fabricated one. */
export interface AnthropicClient {
  messages: Parser;
  beta: { messages: Parser };
}

export type AnthropicSdk = Pick<
  typeof Sdk,
  'APIConnectionTimeoutError' | 'AuthenticationError' | 'APIError'
>;

const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The request as sent. No `temperature` (rejected by current models) and no `thinking` (adaptive). */
export function anthropicParams<T>(req: LlmRequest<T>, format: Format): AnthropicParams {
  const params: AnthropicParams = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: 'user', content: req.prompt }],
    output_config: { format, effort: req.task === 'fix' ? 'medium' : 'low' },
  };
  if (req.task === 'fix' && FALLBACK_MODELS.has(req.model)) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }
  return params;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  /** `keyed`: ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set. */
  constructor(
    private readonly client: AnthropicClient,
    private readonly outputFormat: typeof zodOutputFormat,
    private readonly sdk: AnthropicSdk,
    private readonly keyed: boolean,
  ) {}

  async complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    const started = performance.now();
    const latencyMs = (): number => Math.round(performance.now() - started);
    const fail = (
      reason: LlmFailure,
      detail: string,
      usage: LlmUsage | null = null,
      model = req.model,
      sent = reason !== 'no-key',
    ): LlmResponse<T> => ({
      ok: false,
      reason,
      detail,
      usage,
      sent,
      model,
      latencyMs: latencyMs(),
    });
    try {
      const params = anthropicParams(req, this.outputFormat(req.schema));
      const api = params.betas === undefined ? this.client.messages : this.client.beta.messages;
      const msg = await api.parse(params);
      const usage: LlmUsage = {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      };
      if (msg.stop_reason === 'refusal') {
        return fail('refused', 'the model declined to answer', usage, msg.model);
      }
      if (msg.parsed_output === null || msg.parsed_output === undefined) {
        const why = msg.stop_reason === 'max_tokens' ? 'output cut off at max tokens' : 'no output';
        return fail('invalid', why, usage, msg.model);
      }
      return {
        ok: true,
        value: msg.parsed_output as T,
        usage,
        model: msg.model,
        latencyMs: latencyMs(),
      };
    } catch (err) {
      const [reason, detail] = this.classify(err);
      return fail(reason, detail, null, req.model, reason !== 'no-key' && !unbilled(err));
    }
  }

  private classify(err: unknown): [LlmFailure, string] {
    const message = err instanceof Error ? err.message : String(err);
    const { sdk } = this;
    if (err instanceof sdk.APIConnectionTimeoutError) return ['timeout', message];
    if (
      !this.keyed &&
      (err instanceof sdk.AuthenticationError || /resolve authentication/.test(message))
    ) {
      return ['no-key', 'set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN)'];
    }
    if (err instanceof sdk.APIError) return ['error', message];
    // The SDK reports an output that fails the schema as a plain AnthropicError.
    if (err instanceof ZodError || /Failed to parse structured output/.test(message)) {
      return ['invalid', message];
    }
    return ['error', message];
  }
}
