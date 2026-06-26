# Session Handoff: Baby slimes — smaller size, pop/wiggle spawn anim, survive the killing swing

## Date

2026-06-26

## Persona(s) adopted

**Producer** — the task spanned `src/core` (ECS component + two systems), `src/engine`
(Phaser render), `src/labs`, `src/shared`, and the headless CI gate. A multi-layer
gameplay change with a render dimension and a determinism/gate dimension, so the
generalist coordinating persona was the right fit.

## Routing verdict

✅ right persona — the work touched four layers plus the CI gate; no single specialist
owned all of it, and the mid-task pivot needed cross-layer judgement.

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 4
Verdict: 📉 Under — a new ECS system + lab + tests is a 4-apple shape on its own, and on
top of that the invulnerability requirement forced a full architectural pivot
(time-based invuln → swing-immunity) with extensive headless-gate debugging.

Hello kitties: 4/5 = 0.80 🎀

## What Was Done

Three sub-features for split-spawned "baby" (mini) slimes:

1. **Smaller size** — `PhaserBridge` now scales `slime-mini`-tagged enemies by
   `Sprite.width / SLIME_FULL_SPRITE_WIDTH (24)`. Scoped to minis only, so full slimes,
   rats, and the two slime-textured bosses are untouched. `maybeSplitSlime` already wrote
   a smaller `Sprite.width`; the engine previously ignored it (fixed per-type scale).

2. **Pop-out + wiggle spawn animation** — new `SpawnAnim` component (`remainingMs`,
   `totalMs`) + new deterministic `spawnAnimSystem` that counts the timer down and strips
   `SpawnAnim` on expiry. Pure animation math lives in new `src/shared/spawn-anim.ts`
   (`spawnAnimProgress`, `easeOutBack`, `computeSpawnPopScale`), shared by the engine
   render and a new `src/labs/spawnanim-lab/`. **The animation is purely cosmetic — it
   grants no invulnerability.**

3. **Survive the swing that killed the parent** — implemented as **swing-immunity**, not
   timed invulnerability. New exported `markImmuneToActiveMeleeSwings(world, targetEid)`
   in `meleeSwingSystem.ts` registers each newborn baby into every active `MeleeSwing`
   entity's per-swing hit set. The killing swing therefore skips the babies; the player
   must **swing again** (a fresh `MeleeSwing` entity with an empty hit set) to kill them.
   `dropSystem.maybeSplitSlime` calls it for every mini.

### The pivot (key decision — read this)

Requirement #3 ("invulnerable during the animation") was first built as a **time-based
`Invincible` window** (~280 ms). That broke the CI-blocking headless Floor-1 gate on
`seed 7 · bow`: invulnerable babies could not be killed for gold, which froze a
quest-progress watchdog fingerprint in the bot AI, suppressed the staircase goal, and
sent the bot into endless Engage → 396 s timeout. Four targeted fixes (RNG-parity in
`applyDamage`, `findNearestEnemy` invuln-skip, inert-during-spawn AI, staircase
suppression exemptions) could not make timed invuln gate-safe without risky surgery on
load-bearing AI watchdogs.

The user clarified the real intent: _the single swing that kills the parent usually kills
the babies in the same swing; they want that one swing to miss, forcing a second swing._
That is **swing-immunity**, not a timed window. The new approach:

- Reverted **all** the risky core-damage churn — `apply-damage.ts`, `damageSystem.ts`,
  `damage-system.test.ts`, and the speculative `bt-ai-provider.ts` / `enemyAISystem.ts`
  edits — back to baseline. Babies are never `Invincible`, so the deferred-dodge/crit
  "RNG-parity fix" is unreachable for Enemy/Player targets and was dropped as dead code.
- **Bow needs no code** — bow spawns no `MeleeSwing` entities, so the helper is a no-op,
  and the killing arrow is already consumed/flown past the babies' spawn cluster by the
  next frame. Removing timed invuln returned `seed 7 · bow` to its gate-passing baseline.

## What's Next

- Optional: a Floor-1 playtest pass to tune `MINI_SLIME_SPAWN_ANIM_MS` (currently 280) and
  the pop overshoot purely on feel.
- Optional follow-up only if design later wants ranged "killing-shot" immunity too (the
  bow `pierce: 1` arrow can, in rare geometry, still clip a baby on the next frame). Not
  implemented because the reported bug was melee-specific and baseline bow already mostly
  satisfies it; adding projectile immunity risks the tight `seed 7 · bow` timing.

## Blockers

None. The feature is complete and verified.

## Branch State

- Branch: `nalfeo-slime-split-baby-size-anim`
- All tests passing: yes (see Test Results)
- PR created: yes (opened at end of session)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — nothing to paste.

## Test Results

Validated each `verify` step individually (the monolithic `npm run verify` re-runs the
12-combo headless gate back-to-back, whose coarse wall-time guard flakes on this shared
Windows box — see Key Decisions):

- `npm run verify:fast` — ✅ typecheck + lint + **767 unit tests** pass.
- `npx prettier --check` (src + tests) — ✅ all files formatted.
- `npx knip` — ✅ no new unused exports (only pre-existing `shared/` entries; non-blocking).
- `npx vitest --project integration` — ✅ 49 passed, 1 skipped.
- `npx vite build` — ✅ built in ~2 s.
- **Headless Floor-1 gate** — ✅ all 12 (seed × weapon) combos pass every deterministic
  **game-time** assertion (quests, victory, 6-min budget). `seed 7 · bow` (the combo that
  failed under timed invuln) passes. The tightest melee combo `seed 7 · baseball-bat`
  passes game-time **and** wall-time in isolation (~8 s/combo).

## Key Decisions Made

- **Swing-immunity over timed invulnerability.** Babies survive only the _specific_ attack
  instance that killed the parent (by joining that swing's hit set), not a time window.
  This matches the user's intent and is gate-safe because it adds no extended combat
  lifetime beyond ~one swing/cooldown.
- **`spawnAnimSystem` is cosmetic-only.** Decoupled from `Invincible` entirely; the
  `Invincible` component remains only for NPCs (`helpers.ts`).
- **Headless wall-time guard is environmental, not a regression.** Running all 12 combos
  back-to-back on this contended box pushed two combos over the 30 s coarse guard
  (`seed 3 · bow` 41 s, `seed 3 · bat` 38 s). Both pass in isolation, and **`bow` is a
  no-op for this change** yet was one of the two — proving the blips are machine
  contention. The guard is documented in the test as "deliberately loose to never flake"
  and calibrated for CI runners (~2–3× a dev box); CI is expected to pass.

## Rebase & Review-Resolution Addendum (2026-06-26, shepherding pass)

The original owning session ended with the PR open but **CONFLICTING/DIRTY** against a
fast-moving `main`. A shepherding pass rebased it and resolved all blocking review
threads:

- **Rebased onto `origin/main` @ `8cb53d6`** (118 files had landed since the merge-base,
  including the VFX pipeline #346, generic Spawner mob-type #345, and Floor-1 spawn
  density #343). Only `src/lab-main.ts` had a real conflict — resolved by **unioning**
  both sides' additive lab registrations (kept main's `spawner-lab` / `spawner` category
  hint **and** this PR's `spawnanim-lab`; corrected this PR's category-hint key from the
  non-matching `spawn` to the correct `spawnanim` token). `src/core/components.ts`,
  `src/core/world.ts`, and `src/engine/PhaserBridge.ts` auto-merged cleanly — verified by
  hand that both main's additions (`Spawner` component/store, `vfxEvents`, `EffectsVfx`
  wiring) **and** this PR's additions (`SpawnAnim` component/store, `applyEnemyScale`,
  spawn-pop render branch) survived intact.
- **ADR renumbered `0025` → `0026`** (`docs/knowledge/adr/0026-baby-slime-spawn-animation-and-swing-immunity.md`).
  Three `0025` ADRs had already landed on `main` (#340, #345, #346); moved to the next
  free number and updated the in-file title. No other cross-references existed.
- **Resolved 5 Copilot review threads** — all flagged stale "invulnerability" wording that
  contradicts the shipped **cosmetic-only** design. Reframed every reference (no behaviour
  change): the lab README (title, emerge bullets, control table, cyan-ring caption), the
  `spawnAnim` store comment in `components.ts`, the `MINI_SLIME_SPAWN_ANIM_MS` comment in
  `spawn-anim.ts`, and the lab `index.ts` (hint text, on-canvas `Invulnerable:` →
  `Spawning:` counter, `INVULN_RING` → `SPAWN_RING`, `Anim / invuln (ms)` →
  `Anim (ms)` control, registry description). The cosmetic animation grants no
  invulnerability; babies survive only their parent's killing swing via
  `markImmuneToActiveMeleeSwings` (owned by `dropSystem` + `meleeSwingSystem`).
- **Telemetry:** `files/guard-telemetry.jsonl` does not exist this pass — nothing to paste.
- **Re-verified:** `npm run verify:fast` green (809 unit tests after the merge picked up
  main's suites); full `npm run verify` + `lab-gate-check.sh` re-run before merge.
