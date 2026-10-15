import type { Check, PackageInfo } from '../types.js';
import { fail, packageJsonPath, pass, unknown } from './result.js';

export const SYSTEM_BINARIES: ReadonlySet<string> = new Set(
  `git cd ls cat echo export mkdir rm cp mv curl wget docker docker-compose podman make cmake node npm pnpm
  yarn bun deno npx corepack nvm fnm volta brew apt apt-get dnf yum sudo sh bash zsh fish pwsh powershell
  python python3 pip pip3 uv poetry go cargo rustc rustup java mvn gradle dotnet kubectl helm terraform aws
  gcloud az gh open code touch chmod chown grep rg sed awk find xargs tar unzip zip ssh scp source set env
  which test true false sleep kill ps tee head tail sort uniq wc diff jq yq openssl`.split(/\s+/),
);

/** Binaries whose providing package has a different name; same-name packages match directly. */
const BIN_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  tsc: ['typescript'],
  playwright: ['@playwright/test', 'playwright'],
  changeset: ['@changesets/cli'],
  biome: ['@biomejs/biome'],
  nest: ['@nestjs/cli'],
  ng: ['@angular/cli'],
  remix: ['@remix-run/dev'],
};

function provider(bin: string, all: PackageInfo[]): PackageInfo | undefined {
  const names = [bin, ...(BIN_PACKAGES[bin] ?? [])];
  return all.find((p) => p.bins.includes(bin) || names.some((n) => Object.hasOwn(p.deps, n)));
}

export const commandsCheck: Check = {
  id: 'commands',
  kinds: ['command'],
  run(claims, ctx) {
    return claims.map((claim) => {
      const bin = claim.value;
      if (SYSTEM_BINARIES.has(bin)) return unknown(claim, 'commands', 'system binary');
      const pkg = provider(bin, ctx.index.packages.all);
      if (pkg) return pass(claim, 'commands', [packageJsonPath(pkg.dir)]);
      // A past commit's worktree has no node_modules/.bin, so a missing provider proves nothing.
      if (ctx.index.depsRoot !== undefined) {
        return unknown(claim, 'commands', 'no installed binaries at a past commit');
      }
      return fail(
        claim,
        'commands',
        'warning',
        `Command \`${bin}\` is not installed as a dependency`,
        [],
      );
    });
  },
};
