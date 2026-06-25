# Session Handoff: Wisdom → Mana pool + boss-battle spell-unlock hardening (ITEM 6 / PR2)

## Date

2026-06-25

## Persona(s) adopted

**Producer.** ITEM 6 spans five layers (shared model, core ECS system, game
quest logic, engine HUD, bootstrap wiring) plus docs and a determinism re-probe —
the routing matrix sends multi-layer/ambiguous work to the Producer.

## Routing verdict

✅ Right persona — the work was multi-layer and needed coordinated changes across
core/game/engine/shared/bootstrap, exactly the Producer's remit.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — five layers touched, but each change was small and well-
scoped, and the headless seed did not move (so no costly seed hunt). N/A gap.

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

PR2 of the Progression-payoff stack (base branch `nalfeo-stats-and-abilities`).
Two parts:

### (a) Wisdom → Mana pool (completes ITEM 5's Wisdom "(no effect yet)")

- **`src/shared/mana.ts`** (new): pure mana model — `MANA_BASE = 80`,
  `MANA_PER_WISDOM = 20`, `MANA_REGEN_PER_SECOND = 5`, `MANA_REGEN_PER_FRAME`
  (derived from `GAME.DELTA_MS`, no `Date.now`), and `deriveMaxMp(effWisdom)`.
  Tuned so a fresh player (effective Wisdom 1) → 100 MP (the old hardcoded value).
  Lives in `shared/` (no ECS/Phaser deps; reused by system, HUD, labs, tests) so
  it does not trip the lab gate.
- **`src/core/systems/manaSystem.ts`** (new): deterministic `(world) => void`.
  Reads the `[Player, EffectiveStats]` singleton's effective Wisdom, sets
  `playerMaxMp = deriveMaxMp(...)`, regenerates `playerMp` by
  `MANA_REGEN_PER_FRAME`, clamps `[0, max]`. No-op without the singleton (bare
  worlds keep 100/100). Runs after `statSystem`. Exported via
  `core/systems/index.ts` → `core/index.ts`.
- **Wiring**: added after `statSystem` in the headless loop
  (`game/ai/simulation-step.ts`) and the visual `preSystems`
  (`bootstrap/floor1-main-scene-options.ts`). HUD mana bar (`HudManaBar`) already
  reads `playerMp/playerMaxMp`, so it now reflects the Wisdom-scaled max with no
  HUD change.
- **`src/labs/mana-lab/`** (new) + registered in `lab-main.ts` (LAB_MODULE_PATHS
  - CATEGORY_HINTS 'Progression'): lil-gui controls to allocate Wisdom, drain MP,
    step frames, reset — watches `maxMp`/regen. Satisfies the lab gate for the new
    system.
- **Display**: `src/shared/stat-display.ts` — Wisdom now shows "+20 Max Mana per
  point" (and its level-up gain line); Charisma stays reserved "(no effect yet)".

### (b) Boss-battle spell-unlock hardening

- **`ensureBossBattleSpellReward(world, playerEid)`** (new, in
  `game/floor1Scenario.ts`): idempotent, deterministic safety net wired into
  `confirmFloor1StairDescend` (floor-exit choke point). Guarantees that a
  completed Slime Rat quest (or a set `featureUnlocks.spells` flag) always leaves
  the player with a concrete learned spell + the flag true. Preserves any
  modal/AI pick; otherwise grants `DEFAULT_FLOOR1_BOSS_REWARD_SPELL_ID = 'heal'`
  (new export in `shared/abilities.ts`) — chosen because it matches the headless
  AI's auto-pick and is non-offensive, so it stays RNG-neutral.

### Tests

- `tests/unit/mana.test.ts` (new): `deriveMaxMp` tuning anchor (Wisdom 1 → 100),
  per-point scaling, non-finite/negative floor, frame-regen derivation.
- `tests/ecs/mana-system.test.ts` (new): pool scales with allocated Wisdom, fixed
  per-frame regen + clamp-to-max, clamp-down on shrink, no-op without singleton.
- `tests/game/floor1-scenario.test.ts`: new `describe` block proving
  quest-completion ⇒ spell learned + flag true with NO Phaser/engine modal,
  plus desync-repair, idempotency/no-override, and a full Slime-Rat-defeat
  integration path.
- `tests/unit/stat-display.test.ts`: updated Wisdom assertion to expect the mana
  text; Charisma still "(no effect yet)".

## What's Next

- Charisma is still reserved ("(no effect yet)") — a future ITEM can wire it
  (e.g. shop prices / NPC reactions).
- Mana tuning (80 base / 20 per Wisdom / 5 MP/s) and spell MP costs are starting
  values; revisit when more spells land.

## Blockers

None. (Local note: Git Bash on Windows runs `scripts/agent/lab-gate-check.sh`
very slowly due to per-subprocess fork overhead; the invariant was independently
verified — all 25 systems covered, `manaSystem → mana-lab`. CI runs it on Linux
where it is fast.)

## Branch State

- Branch: `nalfeo-mana-and-abilities` (stacked on `nalfeo-stats-and-abilities`)
- All tests passing: yes
- PR created: yes (PR2 — see link in PR description; base `nalfeo-stats-and-abilities`)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — no telemetry section.

## Test Results

- `npm run verify:fast` → ✅ 218 tests across 20 files.
- `npm run verify` (full: typecheck, lint, format, knip, unit+coverage,
  integration, headless gate, vite build) → ✅ (see PR).
- Determinism re-probe: `npm run ai:headless -- --seed 15 --max-frames 19800` →
  **VICTORY**, all quests cleared (~135.6s game-time, well under the 5-min
  budget). The headless seed did **not** change — heal is cooldown-bound and the
  MP pool never depletes — so `WINNING_SEEDS` in
  `tests/headless/floor1-completion.test.ts` is unchanged.

## Key Decisions Made

See **ADR 0019** (`docs/knowledge/adr/0019-wisdom-mana-pool.md`):

- Mana model + helper in `shared/` (pure, no lab needed); the `(world)=>void`
  `manaSystem` in `core/systems/` (gets a lab).
- `manaSystem` runs after `statSystem`; no-op without the Player+EffectiveStats
  singleton so bare worlds stay deterministic.
- Spell-reward hardening is a floor-exit safety net (not the primary path) that
  preserves the player's/AI's pick and defaults to `heal` to stay RNG-neutral.
