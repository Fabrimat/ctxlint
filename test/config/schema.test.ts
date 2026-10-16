import { describe, expect, it } from 'vitest';
import {
  configSchema,
  DEFAULT_TARGETS,
  defaultConfig,
  defineConfig,
} from '../../src/config/index.js';

describe('configSchema', () => {
  it('applies defaults to an empty object', () => {
    expect(configSchema.parse({})).toEqual({
      ignore: [],
      rules: {
        paths: 'error',
        scripts: 'error',
        commands: 'warning',
        symbols: 'warning',
        snippets: 'error',
        versions: 'warning',
        semantic: 'warning',
      },
      plugins: [],
      ignoreRegions: [],
      prose: false,
      failOn: 'error',
      llm: {
        provider: 'anthropic',
        models: {},
        maxCost: 1,
        scope: 'changed',
        maxFiles: 6,
        maxFileBytes: 100_000,
        maxSectionBytes: 8_000,
        timeoutMs: 60_000,
        concurrency: 4,
        pricing: {},
      },
    });
    expect(defaultConfig).toEqual(configSchema.parse({}));
  });

  it('leaves targets unset, so the defaults apply and skip documentation sites', () => {
    expect(defaultConfig.targets).toBeUndefined();
    expect(DEFAULT_TARGETS).toEqual([
      'AGENTS.md',
      '**/AGENTS.md',
      'CLAUDE.md',
      '**/CLAUDE.md',
      '.cursor/rules/**/*.md',
      '.cursor/rules/**/*.mdc',
      '.github/copilot-instructions.md',
      'README.md',
      'docs/**/*.md',
    ]);
  });

  it('merges partial rule overrides with defaults', () => {
    const { rules } = configSchema.parse({ rules: { commands: 'off', paths: 'warning' } });
    expect(rules).toEqual({
      paths: 'warning',
      scripts: 'error',
      commands: 'off',
      symbols: 'warning',
      snippets: 'error',
      versions: 'warning',
      semantic: 'warning',
    });
  });

  it('rejects unknown top-level and rule keys', () => {
    expect(configSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(configSchema.safeParse({ rules: { nope: 'error' } }).success).toBe(false);
  });

  it('rejects invalid values', () => {
    expect(configSchema.safeParse({ failOn: 'sometimes' }).success).toBe(false);
    expect(configSchema.safeParse({ rules: { paths: 'fatal' } }).success).toBe(false);
  });

  it('defineConfig is the identity', () => {
    const c = { prose: true };
    expect(defineConfig(c)).toBe(c);
  });
});

describe('llm config', () => {
  it('rejects an apiKey: keys come from the environment', () => {
    expect(configSchema.safeParse({ llm: { apiKey: 'sk-x' } }).success).toBe(false);
  });

  it('accepts unlimited and rejects an invalid maxCost', () => {
    expect(configSchema.parse({ llm: { maxCost: 'unlimited' } }).llm.maxCost).toBe('unlimited');
    expect(configSchema.parse({ llm: { maxCost: 0.25 } }).llm.maxCost).toBe(0.25);
    for (const maxCost of [-1, 'lots', null]) {
      expect(configSchema.safeParse({ llm: { maxCost } }).success).toBe(false);
    }
  });

  it('validates provider, scope, models and pricing', () => {
    expect(configSchema.safeParse({ llm: { provider: 'gemini' } }).success).toBe(false);
    expect(configSchema.safeParse({ llm: { scope: 'some' } }).success).toBe(false);
    expect(configSchema.safeParse({ llm: { models: { other: 'x' } } }).success).toBe(false);
    const { llm } = configSchema.parse({
      llm: {
        provider: 'openai',
        models: { fix: 'gpt-x' },
        pricing: { 'gpt-x': { input: 1, output: 2 } },
      },
    });
    expect(llm.pricing['gpt-x']).toEqual({ input: 1, output: 2 });
    expect(configSchema.safeParse({ llm: { pricing: { m: { input: 1 } } } }).success).toBe(false);
  });
});

describe('plugin config', () => {
  it('accepts namespaced plugin rules and rejects unknown keys', () => {
    expect(configSchema.parse({ rules: { 'bedrock/ids': 'error' } }).rules['bedrock/ids']).toBe(
      'error',
    );
    expect(configSchema.safeParse({ rules: { path: 'off' } }).success).toBe(false);
  });

  it('accepts plugins with options and validates ignoreRegions regexes', () => {
    expect(configSchema.parse({ plugins: ['a', ['./b.js', { x: 1 }]] }).plugins).toHaveLength(2);
    expect(configSchema.safeParse({ ignoreRegions: [{ begin: '(', end: 'x' }] }).success).toBe(
      false,
    );
  });
});
