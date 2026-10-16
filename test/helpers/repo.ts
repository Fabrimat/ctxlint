import { buildFileIndex } from '../../src/index/files.js';
import type {
  CheckContext,
  Claim,
  PackageInfo,
  RepoIndex,
  Severity,
  Site,
} from '../../src/types.js';

type PackageInit = Partial<PackageInfo> & { dir: string };

/** In-memory RepoIndex: the first package with dir '' (or an empty one) becomes the root. */
export function makeIndex(
  init: { files?: string[]; packages?: PackageInit[]; root?: string; sites?: Site[] } = {},
): RepoIndex {
  const full = (p: PackageInit): PackageInfo => ({ scripts: {}, deps: {}, bins: [], ...p });
  const list = (init.packages ?? []).map(full);
  const root = list.find((p) => p.dir === '') ?? full({ dir: '' });
  const all = [root, ...list.filter((p) => p !== root)];
  return {
    root: init.root ?? '/nonexistent-repo',
    files: buildFileIndex(init.files ?? []),
    packages: { root, all },
    sites: init.sites ?? [],
  };
}

export function makeCtx(index: RepoIndex, severity: Severity = 'error'): CheckContext {
  return { index, severity };
}

export function makeClaim(over: Partial<Claim> & Pick<Claim, 'kind' | 'value'>): Claim {
  return { file: 'README.md', line: 3, col: 5, section: [], source: 'inline-code', ...over };
}
