# Session Handoff: Level-Up Stat Allocation UX

## Date

2026-06-20

## Persona(s) adopted

Producer (default for a multi-layer feature touching `shared/`, `engine/`,
`game/` bootstrap, `labs/`, docs, and tests).

## Routing verdict

✅ Right persona — the change spans pure logic, the Phaser bridge, scene wiring,
and a lab, so the Producer's cross-layer view fit.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3

## Systems touched

inventory

## What shipped

Built the actual level-up UX where the player selects stats to raise.

- **`src/shared/level-up-allocation.ts`** — pure, immutable allocation state
  (draft per stat, available points, selection, confirm/cancel). All
  clamp/navigation/banking rules live here; no Phaser/DOM. Mirrors the
  `modal-picker.ts` pattern. Fully unit-tested.
- **`src/shared/stat-display.ts`** — labels, descriptions, and value/increment
  formatting for the gameplay `STAT_KEYS`.
- **`src/engine/LevelUpUI.ts`** — `createLevelUpUI` Phaser overlay: title +
  remaining-points header, one row per stat with −/+ controls, current value and
  a green "→ preview (+n)", a description footer for the highlighted stat, and
  Reset/Confirm buttons. Keyboard (↑/↓ select, ←/→ adjust, Enter confirm, Esc
  cancel) and pointer both supported.
- **`src/engine/scenes/MainGameScene.ts`** — replaced the old "Floor 1 has no
  allocation UI → immediately resume" stub. On `world.state === 'level_up'` with
  unspent points, the sim freezes and the overlay opens; confirming applies the
  allocation and resumes (`world.state = 'playing'`). Spend is injected via a new
  `allocateStatPoints?` scene option (keeps engine free of game-layer imports).
- **`src/bootstrap/floor1-main-scene-options.ts`** — wires `allocateStatPoints`
  to `spendPoints`.
- **`src/labs/level-up-lab/`** — Phaser sandbox (registered in `lab-main.ts`)
  exercising the real overlay → `spendPoints` → `statsSystem` path.
- **Tests** — `tests/unit/level-up-allocation.test.ts` (13) and
  `tests/unit/stat-display.test.ts` (3).
- **Docs** — `docs/systems/05-progression.md` + `levelSystem` docstring.

## Notes / decisions

- Leftover points are **banked** toward the next level (confirm with remaining >
  0 is allowed; Esc banks everything). `spendPoints` validation is never violated
  because the pure module caps the draft at `available`.
- The headless/AI path is unchanged — `auto-progression.ts` still automates
  allocation; only the visual scene uses the overlay.

## Verification

- `npm run verify:fast` ✅
- Full unit project: 1344 passed ✅

## Next session recommendations

1. Run full `npm run verify` (build + integration + coverage) before merge.
2. Consider a UX-snapshot/e2e capture of the overlay for visual regression.
3. Optional: mobile/touch sizing pass for the −/+ hit targets on small screens.
