import type { LlmProvider, LlmRequest, LlmResponse } from './provider.js';

type Responder = (req: LlmRequest<unknown>) => LlmResponse<unknown> | Promise<LlmResponse<unknown>>;

/** Deterministic provider for tests: `responder` decides each answer; every request is recorded. */
export class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly requests: LlmRequest<unknown>[] = [];

  constructor(private readonly responder: Responder) {}

  async complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    this.requests.push(req);
    const started = performance.now();
    try {
      return (await this.responder(req)) as LlmResponse<T>;
    } catch (err) {
      return {
        ok: false,
        reason: 'error',
        detail: err instanceof Error ? err.message : String(err),
        usage: null,
        model: req.model,
        latencyMs: Math.round(performance.now() - started),
      };
    }
  }
}
