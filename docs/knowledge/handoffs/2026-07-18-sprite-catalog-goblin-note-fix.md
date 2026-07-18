# Handoff: Fix sprite:enemy.goblin note/description inconsistency

## Date

2026-07-18

## Persona

DevOps Engineer / Investigator

## Systems touched

sprites

## Apples

Estimated 1🍎, actual 1🍎.

## Summary

Investigated and fixed the root cause of the CI recovery loop on PR #1505.
The `sprite:enemy.goblin` catalog entry had its `note` field set to "Tiny Dungeon ghost
(frame 121)" when it should read "goblin" to match the `description` field. This was a
pre-existing copy-paste typo that the automated code reviewer correctly flagged on PR #1505,
but the CI recovery automation (2 dispatch cycles) failed to get a @copilot session to push
a repair commit and reply with `✅ Addressed` markers.

Also added a regression test `tests/unit/sprites/sprite-catalog-integrity.test.ts` that
detects Kenney-sprite note/description entity-name contradictions so this class of error
can be caught deterministically going forward.

## Root cause analysis

1. **Data bug**: `sprite:enemy.goblin` in `src/shared/data/sprite-catalog.json` had
   `note: "Tiny Dungeon ghost (frame 121)"` contradicting `description: "Tiny Dungeon goblin (frame 121)"`.
2. **No systemic CI recovery code bug**: The reconcile.mjs marker parser, `shouldResolveThread`,
   and `automationStallAction` all function correctly. The automation exhausted its 2-retry budget
   because @copilot sessions triggered by task comments made no progress.
3. **Recovery sessions failed silently**: The @copilot sessions were likely triggered but
   either encountered push failures, timeouts, or couldn't locate the correct branch context.

## Files touched

- `src/shared/data/sprite-catalog.json` — changed `note` from "ghost" to "goblin" for `sprite:enemy.goblin`
- `tests/unit/sprites/sprite-catalog-integrity.test.ts` — new; validates Kenney sprite note/description consistency
- `docs/knowledge/review-ledgers/2026-07-18-sprite-catalog-goblin-note-fix.review-ledger.json` — 1🍎 ledger

## Observe before done

- Before: `sprite:enemy.goblin` had `note: "Tiny Dungeon ghost (frame 121) — temp CC0 art."`
- After: `note: "Tiny Dungeon goblin (frame 121) — temp CC0 art."` (consistent with description)
- Regression test passes: `npx vitest run tests/unit/sprites/sprite-catalog-integrity.test.ts` → 2/2

## Verification run

- `npx vitest run tests/unit/sprites/sprite-catalog-integrity.test.ts` — 2/2 pass
- `npm run verify:fast` — all tests pass (1 pre-existing shallow-clone failure in epic-status.test.ts unrelated)
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-sprite-catalog-goblin-note-fix.review-ledger.json` — valid

## Unresolved issues

- PR #1505 (`copilot/create-scavenger-harness-icon`) will need to rebase onto main after this fix
  merges. Once rebased, the review threads at lines 2853 and 2860 will become outdated/resolved
  since the corrected note will no longer show as a diff.

## Recommended next steps

1. Merge this PR so the fix lands in main.
2. Rebase PR #1505 onto the updated main — the goblin/ghost review threads will be outdated.
3. The CI recovery automation for PR #1505 should then see 0 review-thread blockers and proceed
   to auto-merge.
