# Handoff: asset-search — enrich approved shards with brief text

## Summary

Corrects #2623 which incorrectly indexed un-generated briefs as separate search
documents. The correct approach is to enrich **approved shard documents** with
the text from their corresponding brief, giving the index richer concept signal
without polluting results with sprites that don't yet exist.

## Systems touched

sprite-workflow, mcp-tooling

## Files touched

- `.github/extensions/asset-search/lib/index-builder.mjs` — replaced
  `buildBriefCorpus()` with `buildBriefMap()` (briefId → capped text map);
  `toShardDocument()` now accepts the map and adds `briefText` field
- `.github/extensions/asset-search/extension.mjs` — added `briefText` to
  `fields` (boost 0.6), removed `status` from stored/returned fields, updated
  tool description
- `docs/knowledge/review-ledgers/2026-08-01-asset-search-brief-enrichment.review-ledger.json`

## Design

- Tags remain the authoritative signal (boost 3). Brief text is supplementary
  (boost 0.6) — it helps concept queries hit without overriding precise tag matches.
- `shardsFingerprint()` still watches `BRIEFS_DIR` so cache busts when briefs change.
- Brief descriptions capped at 800 chars to keep index compact.

## Verification run

`npm run verify:fast` — passed clean.

## Recommended next steps

- Watch `files/asset-search-telemetry.jsonl` to see if concept queries that
  previously missed now hit via brief enrichment.
