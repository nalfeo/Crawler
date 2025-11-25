# Floor 1 Class-D Anchor Hardening

**Date:** 2026-07-11  
**Branch:** nalfeo-fix-floor1-class-d-prechain-lock  
**Apple estimate:** 3🍎  
**Verdict:** RECOMMENDED — closes the masking concern flagged by cross-session audit on #1019

## Systems touched

ai-behavior-tree, inventory

## Problem

PR #1019 (merged) fixed the class-D tutorial-goon pre-chain lock by adding
a 188ft auto-interaction fallback. Cross-session audit flagged this as
potentially masking the underlying reachability defect: the fallback could
complete the `floor1-find-welcome` objective through walls without requiring
the player to physically navigate to the NPC room entrance.

## Fix

Replaced the 188ft + 300-frame-dwell fallback with structured reachable-anchor
navigation:

### `bt-ai-provider.ts`

- **`resolveNpcInteractionAnchor()`**: BFS flood fill from player position,
  scans 40-tile radius around NPC tile, returns world coords of the nearest
  passable tile reachable from player. Cached per `npcEid` so the BFS runs
  once per floor per NPC instead of every AI tick.
- **`npcInteractionAnchorCache`**: `Map<npcEid, anchor | null>`. Stable for
  floor lifetime; null value cached to avoid redundant BFS retries. Impassable
  start-tile edge case deliberately NOT cached (transient state).
- **`createNpcProgressTarget()`**: wrapper that looks up NPC position, calls
  `resolveNpcInteractionAnchor`, stores anchor as `decision.targetX/Y`.
- Null fallback: warns via `console.warn` with NPC eid/coords and falls back
  to raw NPC position (watchdog will suppress the stuck goal).

### `auto-progression.ts`

- Removed: `TUTORIAL_GOON_HANDOFF_DISTANCE_FT = 188`, `TUTORIAL_GOON_DWELL_FRAMES`,
  `_tutorialGoonSeekFrames` WeakMap, `_setTutorialGoonSeekFramesForTest`.
- Removed dwell requirement from `tutorialSeekFallback` (now simply
  `isSeekingTutorialGoon`). The 12.5ft anchor proximity check provides
  adequate temporal gating — the player must physically navigate to the anchor.
- EXPLORE fallback checks `Math.hypot(decision.targetX - px, targetY - py) <
NPC_INTERACTION_RADIUS_FT` (12.5ft) instead of the 188ft distance to NPC.

## Validation

All three canonical class-D repro seeds pass:

| Seed + weapon         | floor1-find-welcome | suppressedProgressNav |
| --------------------- | ------------------- | --------------------- |
| seed21 + sword        | ✅ completes        | < 0.3                 |
| seed21 + baseball-bat | ✅ completes        | < 0.3                 |
| seed69 + sword        | ✅ completes        | < 0.3                 |

- 136 unit tests pass
- `collision-pair-parity.test.ts` fingerprints re-baselined (intentional: BFS
  anchor navigation takes more frames than 300-frame dwell shortcut, shifting
  the pre-chain/combat ratio in the 1500-frame window; determinism check passes)
- Full `npm run verify` passes

## Review

- Apple: 3🍎
- Ledger: `docs/knowledge/review-ledgers/2026-07-11-class-d-anchor-hardening.review-ledger.json`
- Plan review: gpt-5.4, `major_fork` divergence (addressed BFS caching, null
  fallback warning, dwell-gate semantic justification)
- Code review: claude-sonnet-4.6, round 1 clean

## Outstanding

None. Class-D is fully resolved at root cause. If the tutorial-goon room is
genuinely inaccessible in some future floor layout, the `console.warn` will
surface it for investigation.
