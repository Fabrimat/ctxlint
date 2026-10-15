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
- `symbols` check: functions, classes and members named in inline code are looked up in a syntactic index of the TypeScript and JavaScript sources, with rename suggestions; globals, package imports and framework APIs are `unknown`.
- `snippets` check: `ts`/`tsx` fences are type-checked against the repository (nearest `tsconfig.json`, workspace packages mapped to their sources) and fail only on drift-type diagnostics.
- `versions` check: `pkg@range` mentions and install arguments are compared with `node_modules`, the lockfile (npm, pnpm, yarn) or the declared range.
- `agent` output format for coding agents that run the CLI: one actionable line per stale claim with an explicit replacement; selected automatically when a coding agent is detected (`CLAUDECODE`, `GEMINI_CLI`) or via `CTXTRUTH_FORMAT`.
- `markdown` (pull request comment) and `sarif` (code scanning) output formats, plus `--output`, `--sarif` and `--link-base`.
- `--new-only --base <ref>`: compares with the merge base in a temporary git worktree and reports only the claims a change made false, telling code changes apart from doc edits.
- `--changed-only --base <ref>`: only checks docs, and claims about code, changed since the base.
- `ctxtruth blame`: finds the commit that made each stale claim false (shared binary search over the first-parent history in one temporary worktree), or reports it as stale when written, broken by uncommitted changes, or undetermined; names files the breaking commit renamed or deleted.
- `ctxtruth history`: walks the history and records stale episodes (opened by code or docs, resolved by code or docs, days and commits open) as text, JSON or JSONL.
- DriftBench: a dataset builder over pinned open-source repositories, with a dataset card.
- Composite GitHub Action that upserts a single pull request comment and uploads SARIF.
- Configuration via `ctxtruth.config.json`/`.ts`/`.js`, validated, with a `defineConfig` helper.
- Text and JSON reports with per-file freshness scores.
- `ctxtruth check` CLI with `--format`, `--config`, `--root`, `--fail-on`, `--verbose` and `--no-color`, and exit codes 0/1/2.
- Programmatic API: `check`, `defineConfig`, `formatReport` and the report types.
