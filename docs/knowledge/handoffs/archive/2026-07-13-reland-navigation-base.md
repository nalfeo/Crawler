# Handoff: PR #1131 combined HUD UX batch

**Date:** 2026-07-13
**Session:** reland-navigation-base
**Apple estimate (this session):** 🍎🍎🍎 (3)
**PR:** #1131

## Systems touched

hud-ux

## Summary

This branch started as the navigation-base reland from durable ref
`handoff/ux-navigation-base-20260713` (commit `96bdf4dd)`), but PR #1131 now
contains a broader HUD batch: the reland plus arrow reservations/labels, the
Floor-2 family widget, the encounter stack layout, the boss reward-picker UX
coverage, and follow-up review-fix/tooling work.

This file remains the original 2026-07-13 reland session handoff, so its
session-level apple/accounting fields still describe that session's 3-apple
slice. For the holistic branch-level recovery audit trail and combined-scope
review evidence, see
`docs/knowledge/handoffs/2026-07-14-pr1131-combined-scope-recovery.md`.

## Changes

1. **Navigation base reland**
   - `src/engine/navigation-hud-layout.ts` — Pure layout module for responsive radar/quest
     positioning plus shared critical-HUD reservations
   - `src/engine/HudMinimap.ts` — Docked radar now consumes the shared layout
   - `src/engine/HudQuestTracker.ts` — Shared responsive positioning, 32-char hard wrapping,
     title-strip depth ordering, public bounds API

2. **Navigation arrow slice**
   - `src/engine/HudDirectionArrows.ts` — Reservation-aware off-screen arrows with compact
     labels, bounded wrapping, and screen-space bounds for deterministic probes
   - `tests/unit/hud-direction-arrows.test.ts` — Reservation + wrapping coverage

3. **Family relationships slice**
   - `src/engine/HudFamilyRelationships.ts` — Floor-2 panel with deterministic row layout,
     minimap/adjacent-HUD avoidance, and screen-space probe geometry
   - `src/labs/hud-family-relationships-lab/index.ts` — Stress-state probe and rapid-cycle
     snapshots that now sync one frame per state
   - `tests/e2e/hud-family-relationships.deterministic.test.ts` — Real containment and
     avoidance checks at both supported viewports

4. **Encounter + reward-picker UX**
   - `src/engine/hud-encounter-layout.ts`, `HudBossBar.ts`, `HudAnnouncementBanner.ts`,
     `HudFloorTimer.ts`, `HudUI.ts` — Shared top-center encounter stack geometry and probe
     bounds
   - `src/engine/ModalPickerUI.ts`, `tests/e2e/boss-reward-picker-ux.test.ts`,
     `tests/e2e/helpers/main-scene-probe.ts`, `src/labs/main-scene-probe-lab/index.ts` —
     Real-scene reward-picker geometry probes with deterministic overlap assertions

5. **Follow-up review-fix/tooling**
   - `scripts/agent/review/visual-review-agent.ts` + `tests/unit/visual-review-agent-cli.test.ts`
     — `--viewport-width/--viewport-height` now update the actual screenshot viewport
   - Navigation/family reservations now use live or shared geometry instead of stale constants

## Valid findings incorporated

- ✅ Family-panel fullscreen suppression from #1118 preserved
- ✅ Quest + arrow labels hard-split overlong tokens
- ✅ Family panel avoidance/layout now uses transformed screen-space bounds
- ✅ Direction arrows reserve the live family panel after `familyRelationships.sync()`
- ✅ Floor-2 tracker now derives from the top-center reservation and stays clear of adjacent HUD
- ✅ Reward-picker coverage now asserts sibling non-overlap and label/description separation
- ✅ Visual-review viewport width/height flags now update the effective Playwright viewport

## Review notes

- The original reland session remains a 3-apple slice with its own review ledger:
  `docs/knowledge/review-ledgers/2026-07-13-reland-navigation-base.review-ledger.json`.
- Additional reviewed slices carried on this branch:
  - `docs/knowledge/review-ledgers/2026-07-13-reserve-navigation-arrows.review-ledger.json`
  - `docs/knowledge/review-ledgers/2026-07-13-polish-relationships-hud.review-ledger.json`
  - `docs/knowledge/review-ledgers/2026-07-13-hud-encounter-slice.review-ledger.json`
  - `docs/knowledge/review-ledgers/2026-07-12-abilities-ux-polish.review-ledger.json`
- Holistic branch-scope review evidence was added in the follow-up recovery session:
  - `docs/knowledge/review-ledgers/2026-07-14-pr1131-combined-hud-scope.review-ledger.json`
  - `docs/knowledge/handoffs/2026-07-14-pr1131-combined-scope-recovery.md`
- 1–2 apple follow-up fixes on this branch (for example the visual-review viewport repair)
  intentionally do not have standalone ledgers under the repository policy.
