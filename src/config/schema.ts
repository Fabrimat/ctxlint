import { z } from 'zod';

const level = z.enum(['error', 'warning', 'off']);

export const configSchema = z.strictObject({
  targets: z
    .array(z.string())
    .default([
      'AGENTS.md',
      '**/AGENTS.md',
      'CLAUDE.md',
      '**/CLAUDE.md',
      '.cursor/rules/**/*.md',
      '.cursor/rules/**/*.mdc',
      '.github/copilot-instructions.md',
      'README.md',
      'docs/**/*.md',
    ]),
  ignore: z.array(z.string()).default([]),
  rules: z
    .strictObject({
      paths: level.default('error'),
      scripts: level.default('error'),
      commands: level.default('warning'),
      symbols: level.default('warning'),
      snippets: level.default('error'),
      versions: level.default('warning'),
    })
    .prefault({}),
  /** Extract path claims from plain prose (noisy, so opt-in). */
  prose: z.boolean().default(false),
  failOn: z.enum(['error', 'warning', 'none']).default('error'),
});

export type UserConfig = z.input<typeof configSchema>;
export type Config = z.output<typeof configSchema>;

export const defaultConfig: Config = configSchema.parse({});

/** Identity helper that gives config files type checking and completion. */
export function defineConfig(c: UserConfig): UserConfig {
  return c;
}
