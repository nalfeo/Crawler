# Handoff: HUD UX consistency rebase recovery

## Date

2026-07-13

## Persona

UX Designer

## Systems touched

hud-ux, mobile-ux

## Apples

- Estimated: 🍎🍎
- Actual: 🍎🍎
- Verdict: exact

## What changed

- Rebasing PR #1087 onto current `main` surfaced a real architecture shift: the Abilities configuration surface now uses `abilityLoadoutUI` instead of the older `modalPicker` flow.
- Ported the branch's HUD-consistency guarantees onto the live `abilityLoadoutUI` path instead of reviving the older modal implementation.
- Kept the **Skills** corner shortcut visible above the open abilities loadout as a touch dismiss control.
- Preserved saferoom-only Abilities access and auto-close when the player leaves safe context while the loadout is open.
- Preserved `[B]` toggle-close and restored deterministic probe coverage for the visible Skills-tap dismiss path.
- Updated the probe helpers and e2e characterization to observe the current runtime surface (`abilityLoadoutOpen`) rather than the superseded modal-picker path.

## Observe before done

- Before the rebase repair, the branch conflicted with `main`, and the old modal-picker-specific HUD logic no longer matched the real runtime architecture.
- After the repair, the real `MainGameScene` probe e2e shows the abilities loadout opening in safe context, the **Skills** dismiss shortcut remaining visible while it is open, `[B]` closing it, and a probe-emitted Skills tap dismissing it.
- The held-input regression check was preserved by opening the loadout while paused, closing it with `S` held, then resuming simulation and confirming no latent movement leaked through.

## Files touched

- `src/engine/scenes/MainGameScene.ts`
- `src/labs/main-scene-probe-lab/index.ts`
- `tests/e2e/helpers/main-scene-probe.ts`
- `tests/e2e/main-game-scene-ui-exclusivity.test.ts`
- `tests/unit/main-game-scene-mobile-ui.test.ts`

## Verification

- `npx vitest run tests/unit/main-game-scene-mobile-ui.test.ts` ✅
- `npx vitest run --project e2e tests/e2e/main-game-scene-ui-exclusivity.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅
- GitHub Actions on the pre-rebase head showed no failing substantive CI jobs; the only remaining remote blockers were stale recovery/merge-train runs still pointing at `fefc448`.

## Notes

- `files/guard-telemetry.jsonl` was absent in this session, so no telemetry capture artifact was written.
