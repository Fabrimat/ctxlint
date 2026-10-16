import { z } from 'zod';

const level = z.enum(['error', 'warning', 'off']);

const BUILTIN_RULES = [
  'paths',
  'scripts',
  'commands',
  'symbols',
  'snippets',
  'versions',
  'semantic',
];
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

const price = z.strictObject({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0).optional(),
});

/** Model-judged checks (`--llm`). Keys never live in the config: the SDKs read them from the environment. */
const llmSchema = z.strictObject({
  provider: z.enum(['anthropic', 'openai']).default('anthropic'),
  /** Per task; the Anthropic defaults apply when unset, OpenAI has none. */
  models: z
    .strictObject({ classify: z.string().optional(), fix: z.string().optional() })
    .prefault({}),
  /** Spend ceiling in USD, or `unlimited`. */
  maxCost: z.union([z.number().min(0), z.literal('unlimited')]).default(1),
  scope: z.enum(['changed', 'all']).default('changed'),
  maxFiles: z.number().int().min(1).default(6),
  maxFileBytes: z.number().int().min(1).default(100_000),
  maxSectionBytes: z.number().int().min(1).default(8_000),
  timeoutMs: z.number().int().min(1).default(60_000),
  concurrency: z.number().int().min(1).default(4),
  /** USD per 1M tokens, by model id; merged over the built-in prices. */
  pricing: z.record(z.string(), price).default({}),
});

/** Agent instruction files: checked wherever they live, documentation sites included. */
export const AGENT_TARGETS: readonly string[] = [
  'AGENTS.md',
  '**/AGENTS.md',
  'CLAUDE.md',
  '**/CLAUDE.md',
  '.cursor/rules/**/*.md',
  '.cursor/rules/**/*.mdc',
  '.github/copilot-instructions.md',
];

/** Used when `targets` is unset, which also leaves documentation sites out. */
export const DEFAULT_TARGETS: readonly string[] = [...AGENT_TARGETS, 'README.md', 'docs/**/*.md'];

export const configSchema = z.strictObject({
  /** Unset: `DEFAULT_TARGETS`, without the pages of documentation sites. */
  targets: z.array(z.string()).optional(),
  ignore: z.array(z.string()).default([]),
  rules: z
    .object({
      paths: level.default('error'),
      scripts: level.default('error'),
      commands: level.default('warning'),
      symbols: level.default('warning'),
      snippets: level.default('error'),
      versions: level.default('warning'),
      semantic: level.default('warning'),
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
  llm: llmSchema.prefault({}),
});

export type UserConfig = z.input<typeof configSchema>;
export type Config = z.output<typeof configSchema>;
export type LlmConfig = Config['llm'];

export const defaultConfig: Config = configSchema.parse({});

/** Identity helper that gives config files type checking and completion. */
export function defineConfig(c: UserConfig): UserConfig {
  return c;
}
