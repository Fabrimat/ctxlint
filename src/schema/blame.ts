import { z } from 'zod';
import type { Same } from './pin.js';
import type { BlameReport } from '../blame.js';
import { findingSchema } from './report.js';

const commit = z.strictObject({
  sha: z.string(),
  date: z.string().describe('Author date, ISO 8601.'),
  author: z.string(),
  subject: z.string(),
});

const finding = z.strictObject({
  finding: findingSchema,
  value: z.string().describe('The claim text.'),
  written: commit.nullable().describe('Commit that wrote the doc line; null if uncommitted.'),
  cause: z.enum(['broken-by', 'stale-when-written', 'uncommitted', 'undetermined']),
  commit: commit
    .optional()
    .describe('`broken-by`: the commit that broke the claim. `stale-when-written`: the writer.'),
  commitsAgo: z.number().int().optional(),
  confirmedBefore: z
    .boolean()
    .optional()
    .describe('`broken-by`: false when the claim was only unknown before `commit`.'),
  changes: z
    .array(
      z.strictObject({
        status: z.enum(['renamed', 'deleted']),
        from: z.string(),
        to: z.string().optional().describe('New path of a rename.'),
      }),
    )
    .optional()
    .describe('Files the claim relied on that `commit` renamed or deleted.'),
});

export const blameSchema = z
  .strictObject({
    version: z.literal(1),
    findings: z.array(finding),
    probes: z.number().int().describe('Commits evaluated.'),
    durationMs: z.number(),
  })
  .meta({
    title: 'ctxtruth blame report',
    description: 'Output of `ctxtruth blame --format json`.',
  });

type Wire = z.infer<typeof blameSchema>;
export const _pin: Same<Wire, BlameReport> = true;
