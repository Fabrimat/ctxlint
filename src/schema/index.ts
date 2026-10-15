import { z } from 'zod';
import { blameSchema } from './blame.js';
import { historyEpisodeSchema, historySchema } from './history.js';
import { reportSchema } from './report.js';

export { blameSchema, historyEpisodeSchema, historySchema, reportSchema };

const BASE = 'https://github.com/Fabrimat/ctxtruth/schema';

/** Published file name -> schema. */
const published = {
  'report-v1.json': reportSchema,
  'blame-v1.json': blameSchema,
  'history-episode-v1.json': historyEpisodeSchema,
  'history-v1.json': historySchema,
};

/** Consumers must ignore unknown fields, so the published schemas do not forbid them. */
function relax(node: unknown): void {
  if (Array.isArray(node)) node.forEach(relax);
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.additionalProperties === false) delete o.additionalProperties;
    Object.values(o).forEach(relax);
  }
}

/** File name -> JSON text of the published JSON Schema. Used by `pnpm schema` and its test. */
export function generateSchemas(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(published).map(([file, s]) => {
      const json = z.toJSONSchema(s, { target: 'draft-2020-12', io: 'output' }) as Record<
        string,
        unknown
      >;
      relax(json);
      const { $schema, title, description, ...rest } = json;
      return [
        file,
        `${JSON.stringify({ $schema, $id: `${BASE}/${file}`, title, description, ...rest }, null, 2)}\n`,
      ];
    }),
  );
}
