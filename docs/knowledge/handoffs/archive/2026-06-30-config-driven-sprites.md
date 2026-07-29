# Config-Driven Sprite Mappings & Reduced PR Overhead

**Date:** 2026-06-30  
**Branch:** `nalfeo-config-driven-art-mappings`  
**Estimate:** 🍎 (1 apple — simple refactor)

## Summary

Centralized entity-to-sprite mappings into a config file and updated the PR gate system to exempt config-only PRs (sprite assignments, asset ingestions) from the full review harness, allowing faster iteration.

## Files Touched

**New:**

- `src/shared/data/entity-sprite-mappings.json` — centralized enemy variant → textureId mapping
- `src/shared/data/entity-sprite-mappings.d.ts` — type definition for the config
- `docs/knowledge/review-ledgers/2026-06-30-config-driven-sprites.review-ledger.json` — 1-apple ledger

**Modified:**

- `src/engine/phaser-bridge/sprite-kind.ts` — load mappings from config, O(1) variant lookup
- `.github/extensions/copilot-guards/lib/pr-scope.mjs` — added `'config'` classification, whitelisted config files
- `.github/extensions/copilot-guards/tests/pr-review-ledger.test.mjs` — added 3 tests for config classification

## Verification Run

✅ `npm run verify:fast` — typecheck, lint, unit tests pass  
✅ `npm run test:guards` — 185/185 guard tests pass (3 new)  
✅ Prettier format check passes  
✅ Review ledger valid (1-apple, code_review stage clean)  
✅ No breaking changes; backward compatible

## Unresolved Issues

None. Ready to merge.

## Recommended Next Steps

1. Merge PR
2. Update sprite workflows to leverage config for asset ingestion (future work)
3. Expand config as more entity types (NPCs, decorations) need mappings
