import { describe, expect, it } from 'vitest';
import { configSchema, defaultConfig, defineConfig } from '../../src/config/index.js';

describe('configSchema', () => {
  it('applies defaults to an empty object', () => {
    expect(configSchema.parse({})).toEqual({
      targets: [
        'AGENTS.md',
        '**/AGENTS.md',
        'CLAUDE.md',
        '**/CLAUDE.md',
        '.cursor/rules/**/*.md',
        '.cursor/rules/**/*.mdc',
        '.github/copilot-instructions.md',
        'README.md',
        'docs/**/*.md',
      ],
      ignore: [],
      rules: {
        paths: 'error',
        scripts: 'error',
        commands: 'warning',
        symbols: 'warning',
        snippets: 'error',
        versions: 'warning',
      },
      prose: false,
      failOn: 'error',
    });
    expect(defaultConfig).toEqual(configSchema.parse({}));
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
