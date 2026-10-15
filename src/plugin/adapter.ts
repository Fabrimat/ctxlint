import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { fail, pass, unknown } from '../checks/result.js';
import { shellWords } from '../parse/shell.js';
import type { Check, CheckResult, Claim } from '../types.js';
import type { PluginCheck, PluginClaim, PluginContext } from './types.js';

const files = z.array(z.string()).optional();
const verdictSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pass'), resolvedFiles: files }),
  z.object({
    status: z.literal('fail'),
    message: z.string().min(1),
    suggestion: z.string().optional(),
    resolvedFiles: files,
  }),
  z.object({ status: z.literal('unknown'), reason: z.string().min(1) }),
]);

const ENVIRONMENT = 'depends on the environment, not the checkout';

function toPluginClaim(claim: Claim, check: PluginCheck): PluginClaim {
  const matched = claim.meta?.['matched'] as PluginClaim['matched'];
  const out: PluginClaim = { ...claim, kind: 'custom', matched };
  if (matched === 'command') out.argv = shellWords(claim.value);
  if (matched === 'fence' && claim.meta?.['lang'] !== undefined) out.lang = claim.meta['lang'];
  const re = matched === 'inline-code' ? check.match.inlineCode : check.match.links;
  const m = matched === 'inline-code' || matched === 'link' ? re?.exec(claim.value) : null;
  if (m) out.groups = m.slice(1).map((g) => g ?? '');
  return out;
}

/** `readFile` for a plugin: repo-relative, refuses paths outside the root (a mix-up guard). */
function reader(root: string): PluginContext['readFile'] {
  return async (path) => {
    const abs = resolve(root, path);
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`readFile: \`${path}\` is outside the checkout`);
    }
    return readFile(abs, 'utf8').catch(() => undefined);
  };
}

/**
 * Wraps a plugin check as an internal check. Malformed plugin output never becomes a failure:
 * a throw, a wrong verdict count or an invalid verdict makes the claims unknown.
 */
export function adapt(plugin: string, check: PluginCheck, options: unknown): Check {
  const id = check.id;
  return {
    id,
    kinds: ['custom'],
    ...(check.environment === true && { environment: true }),
    ...(check.description !== undefined && { description: check.description }),
    async run(claims, ctx) {
      const pastCommit = ctx.index.depsRoot !== undefined;
      if (check.environment === true && pastCommit) {
        return claims.map((c) => unknown(c, id, ENVIRONMENT));
      }
      const all = (reason: string): CheckResult[] =>
        claims.map((c) => unknown(c, id, `plugin ${plugin}: ${reason}`));
      let verdicts: unknown;
      try {
        verdicts = await check.verify(
          claims.map((c) => toPluginClaim(c, check)),
          {
            root: ctx.index.root,
            pastCommit,
            index: ctx.index,
            readFile: reader(ctx.index.root),
            options,
          },
        );
      } catch (err) {
        return all(`verify failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!Array.isArray(verdicts) || verdicts.length !== claims.length) {
        const got = Array.isArray(verdicts) ? `${verdicts.length} verdicts` : typeof verdicts;
        return all(`verify returned ${got} for ${claims.length} claims`);
      }
      return claims.map((claim, i) => {
        const v = verdictSchema.safeParse(verdicts[i]);
        if (!v.success) return unknown(claim, id, `plugin ${plugin}: invalid verdict`);
        const resolved = v.data.status === 'unknown' ? [] : (v.data.resolvedFiles ?? []);
        switch (v.data.status) {
          case 'pass':
            return pass(claim, id, resolved);
          case 'unknown':
            return unknown(claim, id, v.data.reason);
          case 'fail':
            return fail(claim, id, ctx.severity, v.data.message, resolved, v.data.suggestion);
        }
      });
    },
  };
}
