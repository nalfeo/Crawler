# Handoff: PR #2694 second main-merge recovery

## Systems touched

mapgen, sprite-pipeline

## Apples

Estimated: 2🍎 (Small) — actual: 2🍎. One live main-merge conflict pair plus targeted regression verification.

## Summary

- Merged the latest `origin/main` into `copilot/optimize-build-terrain-layer`.
- Resolved the two live conflicts by keeping the branch's welcome-room rug sizing and manifest entry, which still match the shipped 144×95 art and the terrain-bake recovery branch's earlier feet-box fix.
- Preserved the upstream non-conflicting review-harness / ceremony-reduction changes from `main`.

## Files touched

- `public/assets/generated/entries/welcome-room-rug-var-0.json`
- `src/shared/data/set-pieces.json`
- `docs/knowledge/handoffs/2026-08-02-pr2694-second-main-merge-recovery.md`

## Validation

- `npx vitest run tests/unit/set-piece-declared-feet.test.ts tests/unit/stamp-set-piece.test.ts tests/unit/set-piece-types.test.ts tests/unit/extensions/asset-search-index-builder.test.ts` ✅
- `npm run verify:fast` ✅

## Notes

- Local dependency installation again needed a temporary, non-committed `package-lock.json` tarball-host rewrite from `ms-feed-*.pkgs.visualstudio.com` to `registry.npmjs.org` so `npm ci --ignore-scripts` could run in this sandbox; the lockfile was restored immediately after install.
- No `files/guard-telemetry.jsonl` artifact existed in this session, so no telemetry capture file was needed.
