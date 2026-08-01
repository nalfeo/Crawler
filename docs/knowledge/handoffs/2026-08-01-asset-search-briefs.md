# Handoff: asset-search — index briefs alongside approved shards

## Summary

Follow-up to #2600 (asset-search extension). Extended the `search_assets` MCP tool to also
index sprite briefs (`briefs/<type>/*.yaml`) as `status: "brief-only"` documents alongside
approved shard entries (`status: "approved"`). Agents can now discover
commissioned-but-not-yet-generated concepts in one search pass.

## Systems touched

sprite-workflow, mcp-tooling

## Files touched

- `.github/extensions/asset-search/lib/index-builder.mjs` — added `buildBriefCorpus()`,
  refactored `buildCorpus()` to call both `buildShardCorpus()` + `buildBriefCorpus()`
- `.github/extensions/asset-search/extension.mjs` — added `BRIEFS_DIR`, updated
  `shardsFingerprint()`, added `status` field to stored/returned data and tool description
- `docs/knowledge/review-ledgers/2026-08-01-asset-search-briefs.review-ledger.json` — 1🍎 ledger

## Verification run

`npm run verify:fast` — passed clean (typecheck + lint + no affected tests).

## Key design decisions

- Briefs with approved shard variants are skipped (approved set built first) to avoid
  duplicate results: if the art is real, the shard doc already covers it.
- Brief descriptions capped at `MAX_BRIEF_DESC_CHARS = 800` to keep index compact.
- `shardsFingerprint()` now walks both `SHARDS_DIR` and `BRIEFS_DIR` (all files, no
  extension filter) so brief changes bust the MiniSearch cache.
- `description` field falls back to `parsed.prompt` for minimal briefs that define the
  content inside the `prompt` key.

## Apples

Estimated: 🍎 x 1
Actual: 🍎 x 2
Verdict: 📉 Under — the change touches two code files and adds a new corpus-building
function (`buildBriefCorpus`) plus cache invalidation logic; that crosses into the
2🍎 "Small" tier. Original 1🍎 estimate assumed a single-file wire-up.

## Unresolved issues

None.

## Recommended next steps

- Monitor `files/asset-search-telemetry.jsonl` in agent sessions to see if brief-only
  results are surfaced and acted upon by set-piece designer / prop-commission skills.
- Consider adding `status` filter to the tool's input schema (`"approved" | "brief-only"`)
  if agents find it useful to restrict results to one category.
