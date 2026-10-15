# ctxtruth JSON Schemas

Contract for ctxtruth's machine output (JSON Schema 2020-12). Generated from `src/schema/` by `pnpm build && pnpm schema`; do not edit by hand.

| File                      | Describes                                     |
| ------------------------- | --------------------------------------------- |
| `report-v1.json`          | `ctxtruth check --format json`                |
| `blame-v1.json`           | `ctxtruth blame --format json`                |
| `history-episode-v1.json` | one line of `ctxtruth history --format jsonl` |
| `history-v1.json`         | `ctxtruth history --format json`              |

Within a version, changes are additive only. A breaking change adds a `-v2.json` file and bumps `version` (`v` for episodes); the v1 file stays.
