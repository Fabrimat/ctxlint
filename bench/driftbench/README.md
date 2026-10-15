# DriftBench

A dataset of real documentation drift events, built by `ctxtruth history` on pinned commits of
public repositories. Each line is one **stale episode**: a claim in an agent-facing doc (AGENTS.md,
CLAUDE.md, README, docs/\*\*) that became false at one commit and, maybe, stopped being false later.
The episodes can double as labelled cases for LLM evals.

## Schema

One JSON object per line in `data/<repo>.jsonl`:

| field                      | meaning                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| `v`                        | schema version, `1`                                                    |
| `repo`                     | repository name from `repos.json`                                      |
| `check`, `kind`            | the check that failed (`paths`, `scripts`, ...) and the claim kind     |
| `file`, `value`, `section` | doc file, the claim text, and its heading path                         |
| `message`, `suggestion?`   | the finding at the commit that opened the episode                      |
| `openedAt`, `closedAt?`    | `{ sha, date, subject }` of the commit where the claim went false/true |
| `cause`                    | `code`, `docs` or `unknown` (see below)                                |
| `resolution?`              | `code` or `docs`, set with `closedAt`                                  |
| `commitsOpen`, `daysOpen`  | walked commits and days until `closedAt`, else until the last commit   |
| `censored`                 | already failing at the first walked commit (`cause` is `unknown`)      |

## How labels are derived

Every commit of the first-parent chain is checked out and every enabled check runs on that
commit's own docs. Checks are deterministic; no model is involved. Between consecutive commits
P and C, claims are matched by fingerprint (check, file, kind, value), counted, so two identical
claims where one breaks open one episode.

- An episode **opens** when a claim fails at C and did not fail at P. `cause` is `docs` when the
  doc file changed between P and C, else `code` (the code changed under an untouched claim).
- It **closes** when the failure disappears (the claim passes or is gone). `resolution` is `docs`
  when the doc file changed between P and C, else `code`.

## Known biases

- First-parent only: on merge-based repos this is one commit per merged PR, on others it is every
  commit. Changes inside a merged branch are not seen.
- `unknown` results (a claim a check could not verify) count as not failing for opening, and do
  not close an open episode.
- The `commands` check is excluded: a historical checkout has no installed binaries.
- Comparison is pairwise: an episode that opens and closes inside one commit is invisible, and a
  doc rename shows as one closed and one opened episode, both attributed to docs.
- Episodes already open at the first walked commit are left-censored.

## Rebuild

```sh
pnpm build
node bench/driftbench/build.ts
```

Repositories and pinned commits live in `repos.json` (`name`, `url`, `sha`, and optionally `root`,
`checks`, `maxCommits`). Clones go to `$DRIFTBENCH_CACHE` (default `<tmp>/driftbench`), are checked
out detached, and no script, install or hook of a cloned repository is run.
