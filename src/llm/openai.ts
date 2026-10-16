import type * as Sdk from 'openai';
import type { zodTextFormat } from 'openai/helpers/zod';
import { ZodError } from 'zod';
import type { LlmFailure, LlmProvider, LlmRequest, LlmResponse, LlmUsage } from './provider.js';
import { unbilled } from './provider.js';

type Format = ReturnType<typeof zodTextFormat>;

export interface OpenAiParams {
  model: string;
  instructions: string;
  input: string;
  max_output_tokens: number;
  store: false;
  text: { format: Format };
}

/** The slice of the SDK result the adapter reads. */
export interface OpenAiResponse {
  model: string;
  output_parsed: unknown;
  status?: string;
  output: { type: string; content?: { type: string }[] }[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details: { cached_tokens: number };
  };
}

/** The slice of the SDK client the adapter calls; tests pass a fabricated one. */
export interface OpenAiClient {
  responses: { parse(params: OpenAiParams): Promise<OpenAiResponse> };
}

export type OpenAiSdk = Pick<
  typeof Sdk,
  'APIConnectionTimeoutError' | 'AuthenticationError' | 'APIError'
>;

/** No sampling parameters: the schema constrains the output. */
export function openAiParams<T>(req: LlmRequest<T>, format: Format): OpenAiParams {
  return {
    model: req.model,
    instructions: req.system,
    input: req.prompt,
    max_output_tokens: req.maxTokens,
    store: false,
    text: { format },
  };
}

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';

  constructor(
    private readonly client: OpenAiClient,
    private readonly textFormat: typeof zodTextFormat,
    private readonly sdk: OpenAiSdk,
  ) {}

  async complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    const started = performance.now();
    const latencyMs = (): number => Math.round(performance.now() - started);
    const fail = (
      reason: LlmFailure,
      detail: string,
      usage: LlmUsage | null = null,
      model = req.model,
      sent = true,
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
      const params = openAiParams(req, this.textFormat(req.schema, 'ctxtruth'));
      const res = await this.client.responses.parse(params);
      // `input_tokens` includes the cached ones; report them apart so each is priced once.
      const cached = res.usage?.input_tokens_details.cached_tokens ?? 0;
      const usage: LlmUsage | null = res.usage
        ? {
            inputTokens: res.usage.input_tokens - cached,
            outputTokens: res.usage.output_tokens,
            cacheReadTokens: cached,
          }
        : null;
      const refused = res.output.some(
        (item) => item.type === 'message' && item.content?.some((c) => c.type === 'refusal'),
      );
      if (refused) return fail('refused', 'the model declined to answer', usage, res.model);
      if (res.output_parsed === null || res.output_parsed === undefined) {
        const why = res.status === 'incomplete' ? 'output cut off at max tokens' : 'no output';
        return fail('invalid', why, usage, res.model);
      }
      if (usage === null) return fail('error', 'the response carried no usage', null, res.model);
      return {
        ok: true,
        value: res.output_parsed as T,
        usage,
        model: res.model,
        latencyMs: latencyMs(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const { sdk } = this;
      if (err instanceof sdk.APIConnectionTimeoutError) return fail('timeout', message);
      if (err instanceof sdk.AuthenticationError) {
        return fail('error', 'OPENAI_API_KEY was rejected', null, req.model, false);
      }
      if (err instanceof sdk.APIError)
        return fail('error', message, null, req.model, !unbilled(err));
      if (err instanceof ZodError || err instanceof SyntaxError) return fail('invalid', message);
      return fail('error', message);
    }
  }
}
