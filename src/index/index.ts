import type { RepoIndex } from '../types.js';
import { buildFileIndex, listFiles } from './files.js';
import { buildPackageIndex } from './packages.js';

export { buildFileIndex } from './files.js';
export { globToRegExp, matchesAny } from './glob.js';

export async function buildRepoIndex(root: string): Promise<RepoIndex> {
  const files = buildFileIndex(await listFiles(root));
  return { root, files, packages: await buildPackageIndex(root, files) };
}
