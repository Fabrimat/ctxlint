# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Markdown parser that extracts path, script and command claims from inline code, links, shell fences and (opt-in) prose, with `ctxtruth-ignore` and `ctxtruth-disable`/`ctxtruth-enable` markers.
- Repository index built from git (or a directory walk) with workspace-aware `package.json` discovery.
- `paths` check with did-you-mean and moved-file suggestions; gitignored and weak paths are reported as `unknown`.
- `scripts` check for npm, pnpm, yarn and bun invocations, including workspace filters.
- `commands` check for binaries used in shell fences.
- Configuration via `ctxtruth.config.json`/`.ts`/`.js`, validated, with a `defineConfig` helper.
- Text and JSON reports with per-file freshness scores.
- `ctxtruth check` CLI with `--format`, `--config`, `--root`, `--fail-on`, `--verbose` and `--no-color`, and exit codes 0/1/2.
- Programmatic API: `check`, `defineConfig`, `formatReport` and the report types.
