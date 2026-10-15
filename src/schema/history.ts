import { z } from 'zod';
import type { Same } from './pin.js';
import type { Episode, HistoryResult } from '../history.js';

const commitRef = z.strictObject({
  sha: z.string(),
  date: z.string().describe('Author date, ISO 8601.'),
  subject: z.string(),
});

export const historyEpisodeSchema = z
  .strictObject({
    v: z.literal(1).describe('Episodes use `v`, not `version`, for historical reasons.'),
    repo: z.string(),
    check: z
      .string()
      .describe('Built-in: paths, scripts, symbols, snippets, versions. Or `<plugin>/<check>`.'),
    kind: z.string().describe('Claim kind. More kinds may be added.'),
    file: z.string(),
    value: z.string(),
    section: z.array(z.string()),
    message: z.string(),
    suggestion: z.string().optional(),
    openedAt: commitRef,
    cause: z.enum(['code', 'docs', 'unknown']).describe('`unknown`: already failing at the start.'),
    closedAt: commitRef.optional(),
    resolution: z.enum(['code', 'docs']).optional(),
    commitsOpen: z.number().int(),
    daysOpen: z.number().describe('Until `closedAt`, else until the last walked commit.'),
    censored: z.boolean().describe('Already failing when the walk started.'),
  })
  .meta({
    title: 'ctxtruth history episode',
    description: 'One line of `ctxtruth history --format jsonl`.',
  });

export const historySchema = z
  .strictObject({
    version: z.literal(1),
    repo: z.string(),
    commits: z.number().int(),
    episodes: z.array(historyEpisodeSchema),
    summary: z.strictObject({
      episodes: z.number().int(),
      open: z.number().int(),
      openPct: z.number().describe('Share of episodes still open, 0-100.'),
      causes: z.strictObject({
        code: z.number().int(),
        docs: z.number().int(),
        unknown: z.number().int(),
      }),
      medianDaysClosed: z.number().nullable(),
      topFiles: z.array(z.strictObject({ file: z.string(), episodes: z.number().int() })),
    }),
  })
  .meta({
    title: 'ctxtruth history',
    description: 'Output of `ctxtruth history --format json`.',
  });

type EpisodeWire = z.infer<typeof historyEpisodeSchema>;
export const _episodePin: Same<EpisodeWire, Episode> = true;
type Wire = z.infer<typeof historySchema>;
export const _historyPin: Same<Wire, HistoryResult & { version: 1 }> = true;
