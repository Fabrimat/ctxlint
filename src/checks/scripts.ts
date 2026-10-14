import { posix } from 'node:path';
import { globToRegExp } from '../index/glob.js';
import { closest } from '../util/distance.js';
import type { Check, CheckContext, CheckResult, Claim, PackageInfo } from '../types.js';
import { docDir, fail, packageJsonPath, pass, unknown } from './result.js';

function matchFilter(filter: string, all: PackageInfo[]): PackageInfo[] {
  const f = filter
    .replace(/^\{(.*)\}$/, '$1')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  const re = globToRegExp(f);
  return all.filter(
    (p) => p.name === f || p.dir === f || (p.name !== undefined && re.test(p.name)),
  );
}

function nearest(dir: string, all: PackageInfo[]): PackageInfo {
  const owners = all.filter((p) => p.dir === '' || dir === p.dir || dir.startsWith(`${p.dir}/`));
  return owners.reduce((a, b) => (b.dir.length > a.dir.length ? b : a), all[0] as PackageInfo);
}

/** Packages the claim refers to, or an `unknown` result when the target cannot be resolved. */
function targets(claim: Claim, ctx: CheckContext): PackageInfo[] | CheckResult {
  const { all } = ctx.index.packages;
  const { filter, dir, recursive } = claim.meta ?? {};
  if (filter !== undefined) {
    const hit = matchFilter(filter, all);
    return hit.length > 0
      ? hit
      : unknown(claim, 'scripts', `unresolved workspace filter ${filter}`);
  }
  if (dir !== undefined) {
    const wanted = [posix.normalize(posix.join(docDir(claim.file), dir)), posix.normalize(dir)].map(
      (d) => (d === '.' ? '' : d.replace(/\/+$/, '')),
    );
    const hit = all.find((p) => wanted.includes(p.dir));
    return hit ? [hit] : unknown(claim, 'scripts', `no package at ${dir}`);
  }
  if (recursive === 'true') return all;
  return [nearest(docDir(claim.file), all)];
}

export const scriptsCheck: Check = {
  id: 'scripts',
  kinds: ['script'],
  run(claims, ctx) {
    const { all } = ctx.index.packages;
    return claims.map((claim) => {
      if (!ctx.index.files.hasFile('package.json')) {
        return unknown(claim, 'scripts', 'no package.json');
      }
      const target = targets(claim, ctx);
      if (!Array.isArray(target)) return target;
      const name = claim.value;
      const owner = target.find((p) => Object.hasOwn(p.scripts, name));
      if (owner) return pass(claim, 'scripts', [packageJsonPath(owner.dir)]);

      const first = packageJsonPath(target[0]?.dir ?? '');
      const other = all.find((p) => !target.includes(p) && Object.hasOwn(p.scripts, name));
      if (other) {
        const where = packageJsonPath(other.dir);
        return fail(
          claim,
          'scripts',
          'warning',
          `Script \`${name}\` is not defined in \`${first}\` (it is defined in \`${where}\`)`,
          [first],
        );
      }
      const near = closest(
        name,
        target.flatMap((p) => Object.keys(p.scripts)),
        2,
      );
      return fail(
        claim,
        'scripts',
        ctx.severity,
        `Script \`${name}\` is not defined in \`${first}\`${near ? ` (did you mean \`${near}\`?)` : ''}`,
        [first],
        near,
      );
    });
  },
};
