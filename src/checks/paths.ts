import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import { closest } from '../util/distance.js';
import type { Check, CheckContext, CheckResult, Claim } from '../types.js';
import { docDir, fail, pass, unknown } from './result.js';
import { clean } from '../git/diff.js';
import { siteOf } from '../index/sites.js';

/** The dir a site link's leading `/` points at: the doc's site, else its top-level `docs/`. */
function siteRoot(file: string, ctx: CheckContext): string | undefined {
  return siteOf(file, ctx.index.sites)?.dir ?? (file.startsWith('docs/') ? 'docs' : undefined);
}

/** Candidate repo-relative resolutions in priority order; empty when all escape the repo. */
function candidates(claim: Claim, site: string | undefined): string[] {
  const norm = (p: string) => posix.normalize(p).replace(/\/+$/, '');
  const fromRoot = norm(claim.value.replace(/^\/+/, ''));
  const out =
    claim.meta?.anchor === 'root'
      ? [fromRoot, ...(site === undefined ? [] : [norm(posix.join(site, fromRoot))])]
      : [norm(posix.join(docDir(claim.file), claim.value)), fromRoot];
  return [...new Set(out)]
    .filter((p) => p !== '..' && !p.startsWith('../'))
    .map((p) => (p === '.' ? '' : p));
}

/** Paths git ignores, via one `check-ignore` call. Empty when git is unavailable. */
function gitIgnored(root: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', root, 'check-ignore', '-z', '--stdin'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: clean(process.env),
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => resolve(new Set()));
    child.stdin.on('error', () => undefined);
    child.on('close', () =>
      resolve(
        new Set(
          out
            .split('\0')
            .filter(Boolean)
            .map((p) => p.replace(/\/$/, '')),
        ),
      ),
    );
    // Both forms so directory-only patterns (`dist/`) match paths that do not exist on disk.
    child.stdin.end(paths.flatMap((p) => [p, `${p}/`]).join('\0'));
  });
}

/**
 * Weak claims (`foo/bar`: no extension, trailing slash or `./`) are often not paths at all
 * (`react-dom/client`, `origin/main`, `text/html`). Only verify them when their first
 * segment is a real directory, next to the doc or at the repo root.
 */
function anchoredInRepo(claim: Claim, ctx: CheckContext): boolean {
  const [first = ''] = claim.value.replace(/^\/+/, '').split('/');
  const bases = claim.meta?.anchor === 'root' ? [''] : [docDir(claim.file), ''];
  return bases.some((base) => ctx.index.files.hasDir(posix.join(base, first)));
}

function suggest(
  target: string,
  ctx: CheckContext,
): { hint: string; suggestion: string } | undefined {
  const { files } = ctx.index.files;
  const moved = ctx.index.files.findByBasename(posix.basename(target));
  const [only] = moved;
  if (moved.length === 1 && only !== undefined && only !== target) {
    return { hint: ` (moved to \`${only}\`?)`, suggestion: only };
  }
  const ext = posix.extname(target);
  // Renames that extend or shorten the name (`format.ts` -> `formatting.ts`) exceed the edit
  // distance threshold; accept them when exactly one sibling shares the stem as a prefix.
  const dir = posix.dirname(target);
  const stem = posix.basename(target, ext);
  const siblings = files.filter((f) => {
    if (posix.dirname(f) !== dir || posix.extname(f) !== ext) return false;
    const other = posix.basename(f, ext);
    return (
      stem.length >= 3 && other.length >= 3 && (other.startsWith(stem) || stem.startsWith(other))
    );
  });
  const [sibling] = siblings;
  if (siblings.length === 1 && sibling !== undefined) {
    return { hint: ` (did you mean \`${sibling}\`?)`, suggestion: sibling };
  }
  const near = closest(
    target,
    files.filter((f) => posix.extname(f) === ext),
    Math.max(2, Math.floor(target.length * 0.2)),
  );
  return near === undefined
    ? undefined
    : { hint: ` (did you mean \`${near}\`?)`, suggestion: near };
}

export const pathsCheck: Check = {
  id: 'paths',
  kinds: ['path'],
  async run(claims, ctx) {
    const { files } = ctx.index;
    const results: (CheckResult | { claim: Claim; cands: string[] })[] = claims.map((claim) => {
      const link = claim.source === 'link';
      const site = link ? siteRoot(claim.file, ctx) : undefined;
      const cands = candidates(claim, site);
      if (cands.length === 0) return unknown(claim, 'paths', 'outside repository');
      const found = cands.find((p) =>
        claim.meta?.dir === 'true'
          ? files.hasDir(p)
          : p === '' || files.hasFile(p) || files.hasDir(p),
      );
      if (found !== undefined) return pass(claim, 'paths', [found]);
      // Site links name pages without their extension: `/config/pool`, `../guide/reporters`
      // (`<p>/index.md` already passed as the directory `<p>`).
      const route = link && posix.extname(claim.value) === '';
      const page = route ? cands.map((p) => `${p}.md`).find((p) => files.hasFile(p)) : undefined;
      if (page !== undefined) return pass(claim, 'paths', [page]);
      // In a site, `/x` is the site's URL root (public assets, generated pages), not the repo's.
      if (route || (site !== undefined && claim.meta?.anchor === 'root')) {
        return unknown(claim, 'paths', 'site route');
      }
      // A bare filename (`config.ts`) usually names a file by basename, wherever it lives.
      if (!claim.value.includes('/') && claim.meta?.dir !== 'true') {
        const same = files.findByBasename(claim.value);
        if (same.length > 0) return pass(claim, 'paths', same);
      }
      if (claim.meta?.shape === 'weak' && !anchoredInRepo(claim, ctx)) {
        return unknown(claim, 'paths', 'not a repository path');
      }
      return { claim, cands };
    });

    const missing = results.filter((r): r is { claim: Claim; cands: string[] } => 'cands' in r);
    const ignored = await gitIgnored(ctx.index.root, [...new Set(missing.flatMap((m) => m.cands))]);

    return results.map((r) => {
      if (!('cands' in r)) return r;
      const { claim, cands } = r;
      const [target = ''] = cands;
      if (cands.some((p) => ignored.has(p))) return unknown(claim, 'paths', 'gitignored', [target]);
      if (claim.meta?.generated === 'true') {
        return unknown(claim, 'paths', 'described as generated', [target]);
      }
      const s = claim.meta?.dir === 'true' ? undefined : suggest(target, ctx);
      return fail(
        claim,
        'paths',
        ctx.severity,
        `Path \`${claim.value}\` does not exist${s?.hint ?? ''}`,
        [target],
        s?.suggestion,
      );
    });
  },
};
