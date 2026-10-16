import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const caseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.string().min(1),
  adversarial: z.boolean(),
  label: z.enum(['drift', 'consistent']),
  section: z.strictObject({
    file: z.string().min(1),
    path: z.array(z.string()).min(1),
    body: z.string().min(1),
  }),
  files: z
    .array(z.strictObject({ path: z.string().min(1), content: z.string(), changed: z.boolean() }))
    .min(1),
  diff: z.string().nullable(),
  note: z.string().min(1),
});

export type EvalCase = z.infer<typeof caseSchema>;

export const CASES_DIR = join(import.meta.dirname, 'semantic', 'cases');

/** `*` matches any run of characters; matched against the case id. */
export function matchesGlob(id: string, glob: string): boolean {
  const re = glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${re.join('.*')}$`).test(id);
}

/** Every case in `dir`, sorted by id; a malformed file throws with its name. */
export function loadCases(dir = CASES_DIR, glob?: string): EvalCase[] {
  const cases = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const parsed = caseSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (!parsed.success) throw new Error(`${f}: ${z.prettifyError(parsed.error)}`);
      return parsed.data;
    });
  return glob ? cases.filter((c) => matchesGlob(c.id, glob)) : cases;
}
