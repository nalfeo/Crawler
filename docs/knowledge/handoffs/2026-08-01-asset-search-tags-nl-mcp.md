# Asset Search: Rich LLM Tags + Natural-Language MCP Tool

**Date:** 2026-08-01  
**Branch:** `nalfeo-asset-search-tags-nl-mcp`  
**Apple estimate:** 2🍎 (tooling-only, capped at 3🍎 by policy)  
**Status:** PR opened, CI in flight

## Systems touched

sprites, tooling, agent-tooling

## Problem

Generated sprite assets had only minimal pipeline tags (`["prop", "generated", "pipeline-approved"]`). There was no way to search the catalog by concept — agents like the set-piece designer had to know exact sprite IDs or scroll the sprite-editor canvas.

## What landed

### 1. LLM tag enrichment (`scripts/sprites/enrich-tags.ts` + `enrich-tags-cli.ts`)

Free-form, guided tag generation via Azure OpenAI chat completions:

- 5–15 lowercase tags per sprite covering materials, condition, function, theme, room-fit, visual traits
- Temperature 0.3 (consistent categorization, not creative)
- `parseTagsResponse()` handles `{"tags":[...]}`, bare arrays, and markdown-fenced JSON
- `createEnrichTagsProvider()` returns `null` gracefully when Azure is not configured

**Backfill CLI:** `npm run sprites:enrich-tags`

- Skips placeholders and already-tagged shards (idempotent)
- `--dry-run`, `--force`, `--key <manifestKey>` flags
- Bounded concurrency: 5 concurrent enrichments

### 2. Approval pipeline hook (`scripts/sprites/approve-cli.ts`)

After a fresh approval writes the shard, `enrichEntryTags()` is called best-effort:

- Never throws, never blocks approval
- Skips if `catalog.tags` already populated (hand-authored overrides preserved)

### 3. `asset-search` Copilot extension (`.github/extensions/asset-search/`)

MiniSearch-powered `search_assets` tool:

- **BM25 + fuzzy (0.2) + prefix** full-text search over tags (3×), label (2×), type (1.5×), description (1×)
- Lazy index rebuild: fingerprint = `${shardCount}:${maxMtime}` — busts cache on any shard change
- Inline shard reader in `.mjs` (can't import TypeScript)
- Per-query telemetry to `files/asset-search-telemetry.jsonl`

**Tool signature:**

```
search_assets({ query: string, type?: string, maxResults?: number })
→ [{ id, label, description, tags, type, assetPath, score }]
```

### 4. Telemetry capture (`scripts/sprites/search-telemetry-capture.ts`)

`npm run sprites:search-telemetry-capture -- <session-slug>`

- Reads `files/asset-search-telemetry.jsonl`
- Writes `docs/knowledge/metrics/asset-search/<slug>.json` with:
  - `totalQueries`, `foundQueries`, `coverageRate`
  - `emptyQueries` — the actual query strings that returned no results (→ candidate briefs)
  - `topTerms` — most-searched vocabulary

### 5. Skill docs updated

- `prop-inventory/SKILL.md` — step 2 now references `search_assets` for concept-based search
- `prop-commission/SKILL.md` — Related section notes `emptyQueries` in metrics as brief seeds

## File map

| File                                                    | Change                                                    |
| ------------------------------------------------------- | --------------------------------------------------------- |
| `scripts/sprites/enrich-tags.ts`                        | NEW — core LLM provider                                   |
| `scripts/sprites/enrich-tags-cli.ts`                    | NEW — batch backfill CLI                                  |
| `scripts/sprites/approve-cli.ts`                        | MODIFIED — best-effort enrichment hook                    |
| `scripts/sprites/search-telemetry-capture.ts`           | NEW — telemetry aggregation                               |
| `.github/extensions/asset-search/config.json`           | NEW — extension metadata                                  |
| `.github/extensions/asset-search/extension.mjs`         | NEW — `search_assets` tool                                |
| `.github/extensions/asset-search/lib/index-builder.mjs` | NEW — shard corpus builder                                |
| `.github/skills/prop-inventory/SKILL.md`                | MODIFIED — search_assets reference                        |
| `.github/skills/prop-commission/SKILL.md`               | MODIFIED — emptyQueries reference                         |
| `AGENTS.md`                                             | MODIFIED — new commands in table                          |
| `package.json`                                          | MODIFIED — minisearch devDep + 2 new scripts              |
| `docs/knowledge/metrics/asset-search/.gitkeep`          | NEW — tracked dir for telemetry                           |
| `tests/unit/sprites/asset-request.test.ts`              | FIXED — pre-existing TS2532 (match[1] possibly undefined) |

## Notes for next agents

- **Backfill run needed:** No shards have been enriched yet. Run `npm run sprites:enrich-tags` with Azure credentials to populate tags on existing shards.
- **Extension requires `npm install`** to have `minisearch` available (it's now in `devDependencies`).
- **MiniSearch version:** `7.1.2` (exact pin in package.json as per `check:exact-deps` policy).
- The `asset-search` extension uses `dynamic import('minisearch')` on first query — the module is resolved from `node_modules` at the repo root.
- Empty-result telemetry in `docs/knowledge/metrics/asset-search/` is the primary signal for driving new asset briefs. The `prop-commission` skill now references this.
