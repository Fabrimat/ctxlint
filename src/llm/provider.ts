import type { z } from 'zod';
import type { LlmConfig } from '../config/index.js';

export interface LlmRequest<T> {
  task: 'classify' | 'fix';
  model: string;
  system: string;
  prompt: string;
  /** Shared by both providers: no `.optional()` anywhere (OpenAI strict mode), use `.nullable()`. */
  schema: z.ZodType<T>;
  maxTokens: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export type LlmFailure = 'refused' | 'invalid' | 'error' | 'timeout' | 'no-key' | 'budget';

export type LlmResponse<T> =
  | { ok: true; value: T; usage: LlmUsage; model: string; latencyMs: number }
  | {
      ok: false;
      reason: LlmFailure;
      detail: string;
      usage: LlmUsage | null;
      /** False only when the request provably never reached the API; absent means it was sent. */
      sent?: boolean;
      model: string;
      latencyMs: number;
    };

export interface LlmProvider {
  readonly name: 'anthropic' | 'openai' | 'fake';
  /** Never throws: every error becomes `ok: false`. */
  complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>>;
}

const DEFAULT_MODELS = { classify: 'claude-haiku-5-5', fix: 'claude-opus-5-5' } as const;

/** The configured model for a task; null when there is none (OpenAI has no defaults). */
/** API errors the provider does not bill (rejected before generation): their reservation is released. */
export function unbilled(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return (
    typeof status === 'number' &&
    (status === 400 || status === 401 || status === 403 || status === 429 || status >= 500)
  );
}

export function modelFor(llm: LlmConfig, task: LlmRequest<unknown>['task']): string | null {
  return llm.models[task] ?? (llm.provider === 'anthropic' ? DEFAULT_MODELS[task] : null);
}

/** A provider that fails every call the same way (missing key or SDK). */
export function failing(
  name: LlmProvider['name'],
  reason: LlmFailure,
  detail: string,
): LlmProvider {
  return {
    name,
    complete: (req) =>
      Promise.resolve({
        ok: false,
        reason,
        detail,
        usage: null,
        sent: false,
        model: req.model,
        latencyMs: 0,
      }),
  };
}

/**
 * The provider for `llm.provider`. The SDKs are optional dependencies, imported only here and
 * only when asked for; a missing SDK or key makes every call fail with a clear reason.
 */
export async function createProvider(llm: LlmConfig, env: NodeJS.ProcessEnv): Promise<LlmProvider> {
  if (llm.provider === 'openai') {
    const apiKey = env['OPENAI_API_KEY'];
    if (!apiKey) return failing('openai', 'no-key', 'OPENAI_API_KEY is not set');
    try {
      const [sdk, helpers] = await Promise.all([import('openai'), import('openai/helpers/zod')]);
      const { OpenAiProvider } = await import('./openai.js');
      return new OpenAiProvider(
        new sdk.default({ apiKey, timeout: llm.timeoutMs, maxRetries: 0 }),
        helpers.zodTextFormat,
        sdk,
      );
    } catch (err) {
      return failing('openai', 'error', sdkFailure('openai', err));
    }
  }
  try {
    const [sdk, helpers] = await Promise.all([
      import('@anthropic-ai/sdk'),
      import('@anthropic-ai/sdk/helpers/zod'),
    ]);
    const { AnthropicProvider } = await import('./anthropic.js');
    const apiKey = env['ANTHROPIC_API_KEY'] || null;
    const authToken = env['ANTHROPIC_AUTH_TOKEN'] || null;
    const client = new sdk.default({ apiKey, authToken, timeout: llm.timeoutMs, maxRetries: 0 });
    const keyed = apiKey !== null || authToken !== null;
    return new AnthropicProvider(client, helpers.zodOutputFormat, sdk, keyed);
  } catch (err) {
    return failing('anthropic', 'error', sdkFailure('@anthropic-ai/sdk', err));
  }
}

function sdkFailure(pkg: string, err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    return `install ${pkg} to use --llm`;
  }
  return `could not start the ${pkg} client: ${err instanceof Error ? err.message : String(err)}`;
}
