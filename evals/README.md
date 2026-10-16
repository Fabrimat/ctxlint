# Evals

Measures how well the semantic drift check (`--llm`) judges a documentation section against the code. It runs the shipped `buildPrompt` and `judgeSection` from `dist/llm/semantic.js`, so a prompt or validator change is measured, never a copy of it.

## What is measured

Each case has a doc section, source files and a label: `drift` or `consistent`. Per model:

- **precision** on `drift`: of the sections flagged, how many really drifted. `unknown` counts as not-drift.
- **recall** on `drift`: of the real drifts, how many were flagged. `unknown` counts as a miss.
- **unsure**: share of judgements that came back `unknown`.
- **invalid**: share of judgements where the model's output failed validation.
- **FPR (adv)**: drift verdicts on the adversarial subset whose label is `consistent`, over the size of that subset.
- **flip**: share of cases whose judgement differs across repeats.
- **$/check**, **p50/p95** latency (all provider calls of one judgement), and **n**.

Precision and adversarial FPR lead because a false alarm costs more trust than a missed drift: a tool that cries wolf gets switched off. Recall only matters once precision holds. The adversarial cases are where false alarms come from, so they carry the credibility of the numbers.

## Cases

`evals/semantic/cases/*.json`, validated by `evals/cases.ts`. About half are `drift`.

- **Drift near-misses**: 3 vs 4 retries, ms vs s, throws vs null, an inverted default, a renamed option, a removed CLI flag, a changed port, async vs sync, drift in the second of two files, drift deep in a large file.
- **Adversarial no-drift** (`adversarial: true`): a cosmetic refactor, a new undocumented feature, a paraphrase, a stale code comment while the doc matches the code, a TODO about a future change, behaviour behind a helper that is not provided (the right answer is unsure), a prompt injection asking for drift, a version or date that is not a claim.
- **Adversarial drift**: a prompt injection asking for "consistent" on a real drift.
- **Ordinary**: plain drift and plain matches.

## Add a case

Add `evals/semantic/cases/<id>.json`:

```json
{
  "id": "retries-count",
  "category": "near-miss",
  "adversarial": false,
  "label": "drift",
  "section": { "file": "docs/http.md", "path": ["HTTP", "Retries"], "body": "..." },
  "files": [{ "path": "src/http.ts", "content": "...", "changed": true }],
  "diff": "unified diff or null",
  "note": "why this label"
}
```

Use real-looking code (20 lines or more) and keep the label balance between 40% and 60% drift; `pnpm vitest run test/evals` checks it.

## Run

```sh
pnpm build
node evals/run.ts --dry-run          # no calls: worst-case cost per model
node evals/run.ts --repeats 3 --max-cost 5
```

Options: `--models a,b` (default `claude-haiku-5-5,claude-sonnet-5-5`; required for `--provider openai`), `--provider anthropic|openai`, `--repeats N` (3), `--max-cost USD` (5), `--cases <glob on ids>`, `--dry-run`.

The default is a dry run whenever the provider's key is not in the environment. A real run needs `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) and no `--dry-run`. All judgements share one budget; when it is reached the run stops, the skipped judgements are excluded from `n`, and the output says `PARTIAL RESULTS`.

The table goes to stdout and the raw judgements of each model to `evals/results/<timestamp>-<model>.json`. Results are git-ignored (only `.gitkeep` is tracked): they depend on the model snapshot and the day, so committing them would give a stale number the code cannot reproduce. The CI job uploads them as an artifact and prints the table in the job summary.

## Cost

The dry run prints the worst case: every call priced at its estimated input plus the full output cap, times repeats, with the built-in prices. Real cost is far lower. The CI job runs only with the `run-evals` label (or by hand) and is capped at `--max-cost 5`.
