# 2026-07-03 - Weapon-equipping PR #719 shepherd

## Systems touched

ci-policy, weapons

## Summary

Shepherded PR #719 (`feat/weapon-equipping`) — "require weapons to be equipped in
hand slots (starter + merchant flow)" — to a clean, mergeable state. Fixed the
failing CI `Types & Lint` job and resolved both `copilot-pull-request-reviewer`
threads:

- **CI fix:** the new `tests/game/weapon-equipping.test.ts` had two real type
  errors — `getEquipmentState` returns `EquipmentState | undefined` (needed `!`),
  and `world.floor1` requires a full `Floor1ScenarioState` (a partial spread failed
  TS2322). Replaced brittle partial-state literals with an `enterLoadout()` helper
  that builds a complete valid Floor 1 scenario state (shape copied from
  `tests/game/questWaypoints.test.ts`).
- **Thread A (stale doc comment):** repointed the doc comment in
  `src/shared/equipmentDefs.ts` from the deleted
  `FLOOR_1_STARTER_WEAPON_TO_SHOP_ITEM_ID` to the local `STARTER_WEAPON_ID_TO_ITEM_ID`.
- **Thread B (duplicated equip logic):** extracted `equipStarterOrFallback` into
  `src/game/scenarios/starterWeaponEquip.ts`; both `selectFloor1StarterWeapon`
  (`src/game/floorScenario.ts`) and `applyFloor1LoadoutChoice`
  (`src/game/scenarios/floorLoadoutScenario.ts`) now delegate to it, preserving the
  warning-on-failure behavior. Removed the now-unused `logger`/`createLogger` in
  `floorScenario.ts`.

## Files touched

- `src/game/scenarios/starterWeaponEquip.ts` (new — shared eviction/equip/fallback helper)
- `src/game/floorScenario.ts`
- `src/game/scenarios/floorLoadoutScenario.ts`
- `src/shared/equipmentDefs.ts`
- `tests/game/weapon-equipping.test.ts`
- `docs/knowledge/adr/2026-07-03-weapon-equipping-hand-slots.md` (new)
- `docs/knowledge/metrics/apples/2026-07-03-weapon-equipping-shepherd.json` (new)
- `docs/knowledge/handoffs/2026-07-03-weapon-equipping-shepherd.md` (this file)

## Verification

- `npm run verify:fast` passed (376 unit tests) after the fixes + dead-`logger` removal.
- `bash scripts/agent/lab-gate-check.sh` passed (the extracted helper is a plain
  function, not a `*System`, so no wiring/lab requirement).
- `VERIFY_FULL=1 npm run verify`: typecheck, lint, format, dead-code, guards,
  unit + integration tests, and the **headless Floor 1 completion / win-rate gate
  (32/32) all passed** — the loadout refactor did not regress the real runtime
  pipeline, and the win-rate gate held with **no** change to `MIN_WIN_RATE` and no
  seed cherry-picking (rule #13). It stopped only at PR prerequisites (missing
  handoff + ADR), which this handoff and the new ADR resolve.
- Observe-before-done (rule #10): the real artifacts exercised are the loadout
  modal picker (`applyFloor1LoadoutChoice`) and the scenario driver
  (`selectFloor1StarterWeapon`), both covered by the headless Floor 1 gate that
  runs the real `src/game/ai` pipeline — not just a lab.

## Review harness

- The PR carries a valid 3-apple review ledger
  (`docs/knowledge/review-ledgers/2026-07-03-weapon-equipping.review-ledger.json`):
  plan review + a code-review loop that ended clean (round 2, 0 concerns). The
  shepherd fixes here are review-thread remediations + a CI fix within that
  reviewed scope, so the existing ledger remains valid.

## Threads resolved

- `PRRT_kwDOSvo2Ms6OQ56M` — equipmentDefs.ts stale comment (Thread A).
- `PRRT_kwDOSvo2Ms6OQ56Y` — floorLoadoutScenario.ts duplicated equip block (Thread B).

Both replied to in-thread with `✅ Addressed in <sha>` and resolved as PR owner via
GraphQL `resolveReviewThread`.

## Unresolved issues

- None blocking. Deferred (tracked in the review ledger as intentional
  follow-ups): auto-swap-starter slot-conflict UX, and
  `getShopkeeperPostQuestStock` filtering `starterChoices` — both pre-existing and
  out of scope for this PR.

## Recommended next steps

- Auto-merge armed with `gh pr merge 719 --auto --squash`; merges once the
  aggregate `ci` + `commit-lint` checks pass on the pushed head.
