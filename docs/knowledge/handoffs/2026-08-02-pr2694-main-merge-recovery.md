# Handoff: PR #2694 main-merge recovery

## Systems touched

mapgen, agent-memory

## Apples

Estimated: 2🍎 (Small) — actual: 2🍎. One main-merge conflict plus one deterministic data-fix surfaced by post-merge verification.

## Summary

- Unshallowed the repo, fetched `origin/main`, and merged it into `copilot/optimize-build-terrain-layer`.
- Resolved the only textual merge conflict in `docs/knowledge/agent-memory.jsonl` by preserving the branch's `Session_Mistakes` entity alongside the upstream memory snapshot.
- Fixed the merged branch's one deterministic regression in `src/shared/data/set-pieces.json`: `welcome-room/welcome-rug` still declared a 3.62ft height, but the shipped rug sprite is the reprocessed 128×73 asset, so contain-fit actually draws it at 3.35ft. Updated the authored feet box to match the shipped art.

## Files touched

- `docs/knowledge/agent-memory.jsonl`
- `src/shared/data/set-pieces.json`
- `docs/knowledge/handoffs/2026-08-02-pr2694-main-merge-recovery.md`

## Validation

- `npx vitest run tests/unit/set-piece-declared-feet.test.ts tests/unit/stamp-set-piece.test.ts tests/unit/set-piece-types.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅

## Notes

- Fresh-worktree validation required a temporary, non-committed `package-lock.json` tarball-host rewrite from `ms-feed-*.pkgs.visualstudio.com` to `registry.npmjs.org` so `npm ci --ignore-scripts` could run in this sandbox. The lockfile was restored immediately after install.
- No `files/guard-telemetry.jsonl` artifact existed in this session, so no telemetry capture file was needed.
