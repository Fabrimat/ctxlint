import { intersects, minVersion, satisfies, validRange, type SemVer } from 'semver';
import { installedVersion, type ReadCache } from '../index/versions.js';
import type { Check, CheckContext, CheckResult, Claim, PackageInfo } from '../types.js';
import { docDir, fail, pass, packageJsonPath, unknown } from './result.js';

/** Packages whose deps the claim is checked against: the doc's own package, else every declarer. */
function declarers(pkg: string, dir: string, all: PackageInfo[]): PackageInfo[] {
  const owners = all.filter((p) => p.dir === '' || dir === p.dir || dir.startsWith(`${p.dir}/`));
  const near = owners.reduce(
    (a, b) => (b.dir.length > a.dir.length ? b : a),
    owners[0] as PackageInfo,
  );
  if (near && Object.hasOwn(near.deps, pkg)) return [near];
  return all.filter((p) => Object.hasOwn(p.deps, pkg));
}

const PART = /^(\d+|[xX*])$/;

/**
 * Rewrites `range` around `to`, keeping its prefix (`^`, `~`) and precision (`3` -> `4`,
 * `3.22` -> `4.1`, `18.x` -> `19.x`). ponytail: only plain `[^~]major[.minor[.patch]]` claims.
 */
function retarget(range: string, to: SemVer): string | undefined {
  const m = /^([\^~]?)(\S+)$/.exec(range);
  const parts = m?.[2]?.split('.') ?? [];
  if (!m || parts.length > 3 || !parts.every((p) => PART.test(p))) return undefined;
  const next = [to.major, to.minor, to.patch];
  const out = parts.map((p, i) => (/^\d+$/.test(p) ? String(next[i]) : p)).join('.');
  return out === m[2] ? undefined : `${m[1]}${out}`;
}

async function verifyIn(
  claim: Claim,
  owner: PackageInfo,
  ctx: CheckContext,
  cache: ReadCache,
): Promise<CheckResult> {
  const { pkg = '', range = '' } = claim.meta ?? {};
  const declared = owner.deps[pkg] as string;
  const manifest = packageJsonPath(owner.dir);
  const found = await installedVersion(ctx.index.root, owner.dir, pkg, declared, cache);

  const files = [manifest];
  const text = (to: SemVer | null): string | undefined => {
    const r = to ? retarget(range, to) : undefined;
    return r === undefined ? undefined : `${pkg}@${r}`;
  };
  const said = `Docs say \`${pkg}@${range}\``;

  if (found) {
    if (!found.source.includes('node_modules/')) files.push(found.source);
    if (satisfies(found.version, range, { includePrerelease: true })) {
      return pass(claim, 'versions', files);
    }
    return fail(
      claim,
      'versions',
      ctx.severity,
      `${said} but \`${found.version}\` is installed (package.json: \`${declared}\`)`,
      files,
      text(minVersion(found.version)),
    );
  }
  // A base worktree has no node_modules: without a lockfile we can read, the declared range would
  // pass claims the head fails on its installed version, faking failures introduced by the change.
  if (ctx.index.depsRoot !== undefined) {
    return unknown(claim, 'versions', 'no installed or locked version at the base', files);
  }
  if (validRange(declared) === null) {
    return unknown(claim, 'versions', 'non-semver specifier', files);
  }
  if (intersects(range, declared)) return pass(claim, 'versions', files);
  return fail(
    claim,
    'versions',
    ctx.severity,
    `${said} but \`${manifest}\` requires \`${declared}\``,
    files,
    text(minVersion(declared)),
  );
}

/** Passes if any declaring package passes; otherwise the first failure, else the first result. */
async function verify(claim: Claim, ctx: CheckContext, cache: ReadCache): Promise<CheckResult> {
  const { pkg, range } = claim.meta ?? {};
  if (!pkg || !range) return unknown(claim, 'versions', 'malformed version claim');
  // "as of `wrangler@4.87`", "`x@2.7.2` does not support Vitest 5": not the version in use.
  if (claim.meta?.bound === 'true') return unknown(claim, 'versions', 'a bound or another version');
  const owners = declarers(pkg, docDir(claim.file), ctx.index.packages.all);
  // ponytail: installed-only (hoisted transitive) packages are not repo dependencies, so unknown.
  if (owners.length === 0) return unknown(claim, 'versions', 'not a dependency');
  const results = await Promise.all(owners.map((o) => verifyIn(claim, o, ctx, cache)));
  return (
    results.find((r) => r.status === 'pass') ??
    results.find((r) => r.status === 'fail') ??
    (results[0] as CheckResult)
  );
}

export const versionsCheck: Check = {
  id: 'versions',
  kinds: ['version'],
  run: (claims, ctx) => {
    const cache: ReadCache = new Map();
    return Promise.all(claims.map((c) => verify(c, ctx, cache)));
  },
};
