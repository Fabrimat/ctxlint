import { z } from 'zod';

const level = z.enum(['error', 'warning', 'off']);

const BUILTIN_RULES = ['paths', 'scripts', 'commands', 'symbols', 'snippets', 'versions'];
/** Plugin rule keys are namespaced: `<plugin>/<check>`. */
const PLUGIN_RULE = /^[a-z0-9-]+\/[a-z0-9-]+$/;

const regexSource = z.string().refine(
  (s) => {
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'not a valid regular expression' },
);

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
    .object({
      paths: level.default('error'),
      scripts: level.default('error'),
      commands: level.default('warning'),
      symbols: level.default('warning'),
      snippets: level.default('error'),
      versions: level.default('warning'),
    })
    .catchall(level)
    .superRefine((rules, ctx) => {
      for (const key of Object.keys(rules)) {
        if (!BUILTIN_RULES.includes(key) && !PLUGIN_RULE.test(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `unknown rule \`${key}\` (built-ins: ${BUILTIN_RULES.join(', ')}; plugin rules are \`<plugin>/<check>\`)`,
          });
        }
      }
    })
    .prefault({}),
  /** Plugin modules: a package name or a path relative to the config file, optionally with options. */
  plugins: z.array(z.union([z.string(), z.tuple([z.string(), z.unknown()])])).default([]),
  /**
   * HTML comment pairs whose content is not checked, e.g. generated sections:
   * `{ "begin": "^<!-- gen:begin", "end": "^<!-- gen:end" }` (regular expression sources).
   */
  ignoreRegions: z.array(z.strictObject({ begin: regexSource, end: regexSource })).default([]),
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
