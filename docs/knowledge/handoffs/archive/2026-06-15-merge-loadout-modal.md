# Handoff - Merge loadout overlay into modal

Date: 2026-06-15
Branch: `nalfeo/merge-loadout-modal`
Apple complexity: estimated 🍎🍎 · actual 🍎🍎 · verdict exact

## Summary

Adjusted the Floor 1 loadout UX so the standalone loadout text overlay no longer competes with the loadout modal. The modal now carries the key context itself and the background loadout panel is hidden while the modal is open.

## Files touched

- `src/engine/scenes/MainGameScene.ts`
  - Added base bonus text composition for the loadout modal body.
  - Updated modal subtitle to include the protagonist name.
  - Hid `loadoutText` while the modal picker is open to prevent double-layered UI.
- `docs/knowledge/handoffs/2026-06-15-merge-loadout-modal.md`
  - Session handoff record.

## Verification run

- `npm run verify:fast` passed.
- `npm run verify` failed in unrelated existing sprite/integration tests and timeouts in this workspace baseline.

## Unresolved issues

- Full verify remains red due to pre-existing integration/unit failures unrelated to this UI change.

## Recommended next steps

- Merge this focused UI fix.
- Follow up separately on the current sprite/integration test instability in the repository baseline.
