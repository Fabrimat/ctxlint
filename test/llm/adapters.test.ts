import * as anthropicSdk from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as openaiSdk from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultConfig } from '../../src/config/index.js';
import {
  anthropicParams,
  AnthropicProvider,
  type AnthropicClient,
  type AnthropicMessage,
} from '../../src/llm/anthropic.js';
import { openAiParams, OpenAiProvider, type OpenAiResponse } from '../../src/llm/openai.js';
import { createProvider, modelFor, type LlmRequest } from '../../src/llm/provider.js';

const schema = z.object({ verdict: z.string(), fix: z.string().nullable() });
const req = (over: Partial<LlmRequest<z.infer<typeof schema>>> = {}) => ({
  task: 'classify' as const,
  model: 'claude-haiku-5-5',
  system: 'sys',
  prompt: 'prompt',
  schema,
  maxTokens: 500,
  ...over,
});

describe('anthropicParams', () => {
  const format = zodOutputFormat(schema);

  it('asks for structured output at low effort for classify, with no sampling or thinking', () => {
    const p = anthropicParams(req(), format);
    expect(p).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 500,
      system: 'sys',
      messages: [{ role: 'user', content: 'prompt' }],
      output_config: { format, effort: 'low' },
    });
    expect(p).not.toHaveProperty('temperature');
    expect(p).not.toHaveProperty('thinking');
  });

  it('uses medium effort and server-side fallbacks for fix on the current models', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']) {
      const p = anthropicParams(req({ task: 'fix', model }), format);
      expect(p.output_config.effort).toBe('medium');
      expect(p.betas).toEqual(['server-side-fallback-2026-07-01']);
      expect(p.fallbacks).toBe('default');
    }
  });

  it('sends no fallbacks for classify, or for fix on another model', () => {
    expect(anthropicParams(req({ model: 'claude-opus-5-5' }), format).fallbacks).toBeUndefined();
    const p = anthropicParams(req({ task: 'fix', model: 'claude-haiku-5-5' }), format);
    expect(p.betas).toBeUndefined();
    expect(p.fallbacks).toBeUndefined();
  });

  it('requires every property of a nullable-only schema', () => {
    expect((format.schema as { required?: string[] }).required).toEqual(['verdict', 'fix']);
  });
});

function anthropic(parse: () => Promise<AnthropicMessage>, keyed = true) {
  const calls: { beta: boolean }[] = [];
  const client: AnthropicClient = {
    messages: {
      parse: () => {
        calls.push({ beta: false });
        return parse();
      },
    },
    beta: {
      messages: {
        parse: () => {
          calls.push({ beta: true });
          return parse();
        },
      },
    },
  };
  return { provider: new AnthropicProvider(client, zodOutputFormat, anthropicSdk, keyed), calls };
}

const message = (over: Partial<AnthropicMessage> = {}): AnthropicMessage => ({
  model: 'claude-haiku-5-5',
  stop_reason: 'end_turn',
  parsed_output: { verdict: 'ok', fix: null },
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 },
  ...over,
});

describe('AnthropicProvider', () => {
  it('maps a parsed response and its usage', async () => {
    const { provider, calls } = anthropic(async () => message());
    const res = await provider.complete(req());
    expect(res).toMatchObject({
      ok: true,
      value: { verdict: 'ok', fix: null },
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 },
      model: 'claude-haiku-5-5',
    });
    expect(calls[0]?.beta).toBe(false);
  });

  it('treats a null cache read as zero and uses the beta surface for fallbacks', async () => {
    const { provider, calls } = anthropic(async () =>
      message({ usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: null } }),
    );
    const res = await provider.complete(req({ task: 'fix', model: 'claude-opus-5-5' }));
    expect(res).toMatchObject({ ok: true, usage: { cacheReadTokens: 0 } });
    expect(calls[0]?.beta).toBe(true);
  });

  it('maps a refusal, keeping the usage', async () => {
    const { provider } = anthropic(async () =>
      message({ stop_reason: 'refusal', parsed_output: null }),
    );
    expect(await provider.complete(req())).toMatchObject({
      ok: false,
      reason: 'refused',
      usage: { inputTokens: 100 },
    });
  });

  it('maps a null parsed output to invalid', async () => {
    const { provider } = anthropic(async () => message({ parsed_output: null }));
    expect(await provider.complete(req())).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('maps a schema failure reported by the SDK to invalid', async () => {
    const { provider } = anthropic(async () => {
      throw new anthropicSdk.AnthropicError('Failed to parse structured output: bad');
    });
    expect(await provider.complete(req())).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('maps a timeout', async () => {
    const { provider } = anthropic(async () => {
      throw new anthropicSdk.APIConnectionTimeoutError();
    });
    expect(await provider.complete(req())).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('maps an authentication error to no-key only without a key', async () => {
    const reject = async (): Promise<AnthropicMessage> => {
      throw new anthropicSdk.AuthenticationError(401, undefined, 'bad key', new Headers());
    };
    expect(await anthropic(reject, false).provider.complete(req())).toMatchObject({
      ok: false,
      reason: 'no-key',
    });
    expect(await anthropic(reject, true).provider.complete(req())).toMatchObject({
      ok: false,
      reason: 'error',
    });
  });

  it('marks unbilled API errors (429, 5xx) as not sent, and others as sent', async () => {
    const thrown = (err: unknown) =>
      anthropic(async () => {
        throw err;
      }).provider.complete(req());
    const limited = new anthropicSdk.RateLimitError(429, undefined, 'slow', new Headers());
    expect(await thrown(limited)).toMatchObject({ reason: 'error', sent: false });
    const overloaded = new anthropicSdk.InternalServerError(529, undefined, 'busy', new Headers());
    expect(await thrown(overloaded)).toMatchObject({ reason: 'error', sent: false });
    expect(await thrown(new anthropicSdk.APIConnectionTimeoutError())).toMatchObject({
      reason: 'timeout',
      sent: true,
    });
  });

  it('maps the missing-credentials error of the SDK to no-key without a key', async () => {
    const { provider } = anthropic(async () => {
      throw new Error('Could not resolve authentication method.');
    }, false);
    expect(await provider.complete(req())).toMatchObject({ ok: false, reason: 'no-key' });
  });

  it('never throws', async () => {
    const { provider } = anthropic(async () => {
      throw 'weird';
    });
    expect(await provider.complete(req())).toMatchObject({
      ok: false,
      reason: 'error',
      detail: 'weird',
    });
  });
});

describe('openAiParams', () => {
  it('sends a strict structured text format and no sampling parameters', () => {
    const format = zodTextFormat(schema, 'x');
    const p = openAiParams(req({ model: 'gpt-x' }), format);
    expect(p).toEqual({
      model: 'gpt-x',
      instructions: 'sys',
      input: 'prompt',
      max_output_tokens: 500,
      store: false,
      text: { format },
    });
    expect(format).toMatchObject({ type: 'json_schema', strict: true });
    expect(p).not.toHaveProperty('temperature');
  });
});

function openai(parse: () => Promise<OpenAiResponse>) {
  return new OpenAiProvider({ responses: { parse } }, zodTextFormat, openaiSdk);
}

const response = (over: Partial<OpenAiResponse> = {}): OpenAiResponse => ({
  model: 'gpt-x',
  output_parsed: { verdict: 'ok', fix: null },
  output: [{ type: 'message', content: [{ type: 'output_text' }] }],
  usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } },
  ...over,
});

describe('OpenAiProvider', () => {
  it('maps a parsed response, reporting cached tokens apart from input', async () => {
    expect(await openai(async () => response()).complete(req({ model: 'gpt-x' }))).toMatchObject({
      ok: true,
      value: { verdict: 'ok', fix: null },
      usage: { inputTokens: 60, outputTokens: 20, cacheReadTokens: 40 },
    });
  });

  it('maps a refusal', async () => {
    const res = await openai(async () =>
      response({
        output_parsed: null,
        output: [{ type: 'message', content: [{ type: 'refusal' }] }],
      }),
    ).complete(req());
    expect(res).toMatchObject({ ok: false, reason: 'refused', usage: { inputTokens: 60 } });
  });

  it('maps missing output and a schema failure to invalid', async () => {
    expect(
      await openai(async () => response({ output_parsed: null })).complete(req()),
    ).toMatchObject({ ok: false, reason: 'invalid' });
    const bad = await openai(async () => {
      schema.parse({});
      return response();
    }).complete(req());
    expect(bad).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('maps a timeout, a rejected key and other API errors', async () => {
    const fail = (err: unknown) =>
      openai(async () => {
        throw err;
      }).complete(req());
    expect(await fail(new openaiSdk.APIConnectionTimeoutError())).toMatchObject({
      reason: 'timeout',
    });
    expect(
      await fail(new openaiSdk.AuthenticationError(401, undefined, 'no', new Headers())),
    ).toMatchObject({ reason: 'error', detail: 'OPENAI_API_KEY was rejected' });
    expect(
      await fail(new openaiSdk.RateLimitError(429, undefined, 'slow', new Headers())),
    ).toMatchObject({ reason: 'error', sent: false });
  });
});

describe('createProvider and modelFor', () => {
  const llm = (over: object) => ({ ...defaultConfig.llm, ...over });

  it('reports a missing OpenAI key without a network call', async () => {
    const p = await createProvider(llm({ provider: 'openai' }), {});
    expect(p.name).toBe('openai');
    expect(await p.complete(req())).toMatchObject({ ok: false, reason: 'no-key' });
  });

  it('builds the real providers from the installed SDKs', async () => {
    expect((await createProvider(llm({}), { ANTHROPIC_API_KEY: 'k' })).name).toBe('anthropic');
    expect((await createProvider(llm({ provider: 'openai' }), { OPENAI_API_KEY: 'k' })).name).toBe(
      'openai',
    );
  });

  it('defaults models for Anthropic only', () => {
    expect(modelFor(defaultConfig.llm, 'classify')).toBe('claude-haiku-5-5');
    expect(modelFor(defaultConfig.llm, 'fix')).toBe('claude-opus-5-5');
    expect(modelFor(llm({ provider: 'openai' }), 'fix')).toBeNull();
    expect(modelFor(llm({ provider: 'openai', models: { fix: 'gpt-x' } }), 'fix')).toBe('gpt-x');
  });
});
