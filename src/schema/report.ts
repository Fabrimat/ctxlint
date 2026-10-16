import { z } from 'zod';
import type { Same } from './pin.js';
import type { Report } from '../types.js';

const checkId = z
  .string()
  .describe(
    'Built-in: paths, scripts, commands, symbols, snippets, versions, semantic. Plugin checks are namespaced `<plugin>/<check>`.',
  );

export const claimSchema = z.strictObject({
  kind: z
    .string()
    .describe(
      'Built-in: path, script, command, symbol, snippet, version, section, custom. More kinds may be added.',
    ),
  value: z.string().describe('Normalised claim text.'),
  file: z.string().describe('Repo-relative POSIX path of the Markdown file.'),
  line: z.number().int().describe('1-based.'),
  col: z.number().int().describe('1-based.'),
  section: z.array(z.string()).describe('Heading path of the enclosing section.'),
  source: z.enum(['inline-code', 'link', 'fence', 'prose']),
  meta: z.record(z.string(), z.string()).optional().describe('Kind-specific extra data.'),
});

export const findingSchema = z.strictObject({
  file: z.string(),
  line: z.number().int(),
  col: z.number().int(),
  checkId,
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  suggestion: z.string().optional().describe('Concrete replacement text, when obvious.'),
  introducedBy: z
    .enum(['docs', 'code'])
    .optional()
    .describe('Only when compared with a base ref: what made the claim false.'),
  model: z.string().optional().describe('The model that judged the claim (model-judged findings).'),
  proposedFix: z
    .strictObject({
      startLine: z.number().int().describe('1-based.'),
      endLine: z.number().int().describe('1-based, inclusive.'),
      replacement: z.string(),
    })
    .optional()
    .describe('A proposed rewrite of those lines (`--fix`).'),
});

const resultSchema = z.strictObject({
  claim: claimSchema,
  checkId,
  status: z.enum(['pass', 'fail', 'unknown']),
  reason: z.string().optional().describe('Present when status is `unknown`.'),
  finding: findingSchema.optional().describe('Present when status is `fail`.'),
  resolvedFiles: z.array(z.string()).describe('Repo-relative code files the claim depends on.'),
  baseline: z
    .enum(['new', 'existing', 'not-comparable'])
    .optional()
    .describe('Only on failing results with `--new-only`.'),
});

export const reportSchema = z
  .strictObject({
    version: z.literal(1),
    tool: z.strictObject({ name: z.string(), version: z.string() }),
    files: z.array(
      z.strictObject({
        file: z.string(),
        freshness: z
          .number()
          .nullable()
          .describe('pass / (pass + fail); null if nothing verifiable.'),
        results: z.array(resultSchema),
      }),
    ),
    findings: z.array(findingSchema).describe('Reported findings, sorted by file, line, col.'),
    comparison: z
      .strictObject({
        base: z.string().describe('The base ref as given.'),
        baseSha: z.string().describe('The merge base commit.'),
        introduced: z.number().int(),
        existing: z.number().int(),
        fixed: z.number().int(),
        notComparable: z.number().int(),
      })
      .optional()
      .describe('Present when compared with a base ref.'),
    llm: z
      .strictObject({
        calls: z.number().int(),
        failedCalls: z.number().int(),
        skipped: z.number().int().describe('Sections or calls not run: budget, no key, too large.'),
        inputTokens: z.number().int(),
        outputTokens: z.number().int(),
        cacheReadTokens: z.number().int(),
        costUsd: z.number().nullable().describe('Null when a model has no known price.'),
        costEstimated: z
          .boolean()
          .describe(
            'True when part of the cost is a worst-case estimate (a call reported no usage).',
          ),
        latencyMs: z.number(),
        budgetUsd: z.number().nullable().describe('Null when unlimited.'),
        models: z.array(z.string()),
      })
      .optional()
      .describe('Present when the run used `--llm`.'),
    skipped: z
      .array(
        z.strictObject({
          dir: z.string().describe('Repo-relative POSIX dir.'),
          reason: z.string().describe('E.g. `VitePress site`.'),
          files: z.number().int().describe('Doc files not checked.'),
        }),
      )
      .optional()
      .describe(
        'Dirs the default targets left unchecked (documentation sites); present when any were.',
      ),
    summary: z.strictObject({
      files: z.number().int(),
      claims: z.number().int(),
      pass: z.number().int(),
      fail: z.number().int(),
      unknown: z.number().int(),
      errors: z.number().int(),
      warnings: z.number().int(),
      freshness: z.number().nullable(),
      durationMs: z.number(),
    }),
  })
  .meta({
    title: 'ctxtruth check report',
    description: 'Output of `ctxtruth check --format json`.',
  });

// Drift between this schema and the Report interface fails `pnpm typecheck`.
type Wire = z.infer<typeof reportSchema>;
export const _pin: Same<Wire, Report> = true;
