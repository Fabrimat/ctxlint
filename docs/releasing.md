# Releasing

The `release` workflow (`.github/workflows/release.yml`) publishes to npm with provenance, creates the GitHub release from the CHANGELOG and moves the major tag. It runs when a `vX.Y.Z` tag is pushed. Run it from the Actions tab (`workflow_dispatch`, `dry-run` on by default) to check lint, types, tests, build and the package contents without publishing.

## One-time setup

1. **Rename the repository** from `ctxlint` to `ctxtruth` (Settings, General). GitHub redirects the old URL; the `repository`, `homepage` and `bugs` fields already point to `Fabrimat/ctxtruth`.
2. **Make it public.** npm provenance and the Marketplace both need a public repository.
3. **Create the `release` environment** (Settings, Environments). The `publish` job runs in it, so add required reviewers if you want a manual approval, and store `NPM_TOKEN` as an environment secret there, not as a repository secret. The `verify` job runs tests with no secrets and read-only permissions.
4. **Give the workflow npm access**, with one of:
   - **Automation token (default).** Create a granular or automation access token on npmjs.com with publish rights to `ctxtruth`, and save it as the `NPM_TOKEN` secret of the `release` environment. The first publish of a new package needs a token, because a trusted publisher can only be configured on a package that exists.
   - **Trusted publishing (OIDC).** After the first publish, add a trusted publisher on the package settings page (repository `Fabrimat/ctxtruth`, workflow `release.yml`), then delete `NPM_TOKEN`: if it is still set it takes precedence over OIDC. The workflow already has `id-token: write`; npm CLI 11.5.1 or later is required, which Node 24 ships.
5. **Protect the `v*` tags** (Settings, Rules, tag ruleset). This is required: the Action and the release depend on them. Only maintainers may create tags, and the rule must let the workflow (the `github-actions` bot or the `release` environment) update `v0`, `v1` and so on.

## First release (0.1.0)

`package.json` stays at `0.0.0` until a release; the bump is part of the release commit.

1. In `CHANGELOG.md`, add the date to `## [0.1.0]` (`## [0.1.0] - YYYY-MM-DD`). The release notes are this section, so it must start with `## [0.1.0]`.
2. `npm version 0.1.0 --no-git-tag-version`, then commit: `git commit -am "chore: release 0.1.0"`.
3. Check locally: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && npm pack --dry-run`.
4. Tag and push: `git tag v0.1.0 && git push origin main v0.1.0`.

The workflow fails if the tag is not exactly `v` plus the `package.json` version.

## Verify the release

- On `https://www.npmjs.com/package/ctxtruth` the version shows a "Built and signed on GitHub Actions" provenance badge.
- `npm audit signatures` in a project that installed it reports a verified attestation.
- The GitHub release exists with the CHANGELOG section as notes.

## Publish the Action to the Marketplace

The Action's `action.yml` is at the repository root. Marketplace listing is a manual step, per release:

1. Edit the GitHub release the workflow created (or draft one).
2. Tick "Publish this Action to the GitHub Marketplace", accept the terms the first time.
3. Primary category: Code quality. Secondary: Continuous integration.
4. Save. The `name` in `action.yml` must be unique on the Marketplace; if `ctxtruth` is taken, use `ctxtruth docs drift`.

Users then write `uses: Fabrimat/ctxtruth@v0`. The `version` input defaults to `^0`, so `@v0` runs the newest 0.x CLI; pin `version: 0.1.0` for reproducible runs.

## After a release

- The workflow moves the major tag (`v0` for 0.x, `v1` for 1.x) to the release commit, except for prereleases (`0.2.0-rc.1`: published with the `next` npm tag, marked as a GitHub prerelease) and when a higher stable version of that major is already tagged. Check `git ls-remote --tags origin`.
- When cutting a new major tag `vN`, set the `version` default in `action.yml` to `^N` in the same release, so `@vN` runs the matching CLI range.
- The workflow can be re-run after a failure: it skips the npm publish and the GitHub release that already exist.
- Smoke test the CLI: `npx ctxtruth@0.1.0 check` in a scratch repository.
- Smoke test the Action: in a test repository add `uses: Fabrimat/ctxtruth@v0` to a pull request workflow (see [github-action.md](github-action.md)) and confirm the comment appears.
- Add a new empty `## [Unreleased]` section if it is missing.
