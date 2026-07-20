# ADR 0019: Wisdom → Mana pool (`manaSystem`) + boss-battle spell-reward hardening

## Status

Superseded by `2026-07-16-primary-stat-system-overhaul.md`

## Date

2026-06-25

## Estimated Complexity

🍎 x 3 — adds one new deterministic ECS system (so one new lab), a pure shared
mana model, and a quest-completion safety net. Touches core, game, engine,
bootstrap, and shared, but each change is small and the headless seed is
re-probed (it did not move).

## Context

ITEM 5 (ADR 0017) wired Luck → crit and Dexterity → dodge through
`EffectiveStats`, but left **Wisdom** and **Charisma** showing
"(no effect yet)". `world.playerMp` / `world.playerMaxMp` were hardcoded
`100 / 100` in `src/core/world.ts`, disconnected from any stat. So allocating Wisdom
on level-up did nothing, even though the HUD already drew a mana bar and the
boss-battle reward unlocked castable spells that spend MP.

Separately, the Floor 1 boss-battle ("Neighborhood Watch" / Slime Rat) is the
**only** source of the ability system: completing it is supposed to learn a
concrete spell (`memorizeSpell`) AND flip `world.featureUnlocks.spells = true`
(which reveals the MP bar + ability HUD). The happy paths cover this — the visual
game shows a choice modal (`selectSpellFromBossBattle`) and the headless AI auto-
claims `heal` (`autoFloor1ProgressionSystem`). But nothing guaranteed the
**invariant**: if any path flipped the unlock flag without granting a spell (or
completed the quest while both the modal and AI were absent), the player would
see an MP bar over an empty spellbook with nothing to cast.

ITEM 6 asked us to (a) harden that unlock invariant and (b) make Wisdom drive the
mana pool — completing the Wisdom half of the ITEM 5 payoff.

## Decision

1. **Pure mana model in the former _src/shared/mana.ts_.** `MANA_BASE = 80`,
   `MANA_PER_WISDOM = 20`, and `deriveMaxMp(effectiveWisdom) = MANA_BASE +
MANA_PER_WISDOM × max(0, wisdom)`. Tuned so a fresh player (effective
   Wisdom 1) maps to the historical `100` MP, preserving balance. Regen is
   `MANA_REGEN_PER_SECOND = 5`, converted to `MANA_REGEN_PER_FRAME` via
   `GAME.DELTA_MS` — the same fixed-timestep clock every timed system uses, so
   **no `Date.now`**. It lives in `shared/` (not `core/systems/`) because it is a
   pure helper + constants with no ECS or Phaser deps, reusable by the system,
   the HUD, labs, and tests — and because a non-`(world)=>void` helper in
   `core/systems/` would (correctly) trip the lab gate.

2. **New deterministic `manaSystem(world): void`** (formerly
   _src/core/systems/manaSystem.ts_).
   Queries the `[Player, EffectiveStats]` singleton; if absent it is a no-op (bare
   test/lab worlds keep their default 100/100). Otherwise it sets
   `playerMaxMp = deriveMaxMp(effectiveWisdom)`, regenerates `playerMp` by
   `MANA_REGEN_PER_FRAME`, and clamps to `[0, max]`. It runs **after** `statSystem`
   so the effective Wisdom it reads already folds in this frame's allocation and
   equipment. Exported through the core barrel (`src/core/systems/index.ts` →
   `src/core/index.ts`) like `statSystem`. Every new system needs a lab, so
   the former _src/labs/mana-lab/_ is added and registered in `lab-main.ts`.

3. **Wire into both pipelines.** Added to the headless loop
   (`src/game/ai/simulation-step.ts`) and the visual game's `preSystems`
   (`src/bootstrap/floor-main-scene-options.ts`), immediately after `statSystem`, so
   the pool scales identically headless and visual. The HUD mana bar already reads
   `world.playerMp/playerMaxMp`, so it now reflects the Wisdom-scaled max with no
   HUD logic change.

4. **Display.** `src/shared/stat-display.ts` now formats Wisdom as
   "+20 Max Mana per point" (its mana gain) instead of "(no effect yet)";
   Charisma stays reserved/"(no effect yet)".

5. **Boss-battle spell-reward hardening.** New
   `ensureBossBattleSpellReward(world, playerEid)` in `src/game/floorScenario.ts`,
   wired into `confirmFloor1StairDescend` (the floor-exit choke point). It is a
   **safety net**, idempotent and deterministic (no RNG, no modal):
   - No-op until the quest is complete OR the unlock flag is already set.
   - If a spell is already learned (modal/AI chose one), it just latches
     `featureUnlocks.spells = true` and exits — **preserving the player's/AI's
     choice**.
   - Otherwise it grants a deterministic default,
     `DEFAULT_FLOOR1_BOSS_REWARD_SPELL_ID = 'heal'`, and flips the flag.
     `'heal'` is chosen deliberately: it matches the headless AI's existing auto-
     pick and is non-offensive (no auto-cast targeting), so the fallback is RNG-
     neutral and never robs the visual player's modal pick.

## Consequences

### Positive

- Wisdom allocation now has a real, visible effect (larger MP pool), completing
  the ITEM 5 progression payoff. The HUD reflects it automatically.
- Completing the boss quest is now **guaranteed** to leave the player with a
  castable spell and the ability system unlocked — no degenerate "MP bar over an
  empty spellbook" state is reachable.
- One pure `deriveMaxMp` formula is shared by the system, HUD, and tests, so they
  can't drift.

### Negative / Risks

- Adding per-frame MP regen could in principle shift the shared RNG trajectory.
  In practice the only auto-cast spell (`heal`) is cooldown-bound (1800 frames /
  30s, 10 MP) and never depletes the ≥100 MP pool, so the headless seed is
  unchanged — **re-probed seed 15, still VICTORY with all quests at ~135s
  game-time** (well under the 5-min budget). `WINNING_SEEDS` is untouched.
- The fallback grant is a floor-exit safety net, not the primary path; if a
  future flow needs the spell earlier it must still call the modal/AI path.
- Tuning (`MANA_BASE 80` / `MANA_PER_WISDOM 20` / `5 MP/s` regen) is a starting
  point and may need balancing as more spells/costs land.

## Alternatives Considered

- **Deriving max MP inside `statSystem`** instead of a dedicated system —
  rejected; MP regen + clamp is per-frame resource maintenance, not stat
  derivation, and a separate system keeps the lab/ownership boundary clean.
- **Putting the mana constants in `core/`** — rejected; they have no ECS deps and
  the HUD (engine layer) needs them, so `shared/` is the correct home and avoids a
  spurious lab-gate trip.
- **Granting the fallback spell on the per-frame objective tick** — rejected; it
  would pre-empt and rob the visual player's choice modal. The floor-exit choke
  point fires only after the player has had every chance to pick.
- **A non-`heal` default** (e.g. `fireball`) — rejected; an offensive default
  could auto-cast and shift the headless RNG trajectory. `heal` matches the AI's
  pick and stays trajectory-neutral.
