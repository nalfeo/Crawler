# Session Handoff: Wire secondary stats (crit/dodge) into combat — PR1 (ITEM 5)

## Date

2026-06-25

## Persona(s) adopted

**Producer** — the task is multi-layer (core damage path + engine VFX + game sim
loop + shared stat derivation) and was explicitly a planned 2-PR stack, which is
the Producer's remit per `docs/agent-os/personas/README.md`. No specialist
hand-off was needed since the change is cohesive.

## Routing verdict

✅ right persona — a single cross-cutting combat/progression change benefits from
the Producer's whole-pipeline view; splitting across specialists would have added
coordination cost for one coherent feature.

## Apples

Estimated: 🍎 x 4 <!-- declared in first turn, before code -->
Actual: 🍎 x 4
Verdict: 🎯 Exact — touched 3 layers + forced a deterministic seed re-probe and a
property-test update, but reused the existing `EffectiveStats` store and added no
new ECS system (no new lab), landing squarely at the declared 4.

Hello kitties: 4/5 = 0.80 🎀

## Systems touched

inventory

## What Was Done

Wired the previously-inert secondary stats into combat (ITEM 5):

- **`shared/stats.ts`** — added `CORE_STAT_TO_SECONDARY` (Luck → critChance
  +0.005/pt, Dexterity → dodgeChance +0.003/pt), derived from effective primaries.
- **`core/effective-stats.ts`** (new pure helper) — single `applyEffectiveStats`
  formula: base → fold core points → equipment → derive secondaries → clamp.
  `equipmentSystem` and `statSystem` both delegate to it (no more drift).
- **`core/combat-rolls.ts`** (new) — pure `resolveCrit`/`resolveDodge`.
- **`core/apply-damage.ts`** — crit (player→enemy, scales by critMultiplier, flags
  `isCrit` on the `'hit'` event) and dodge (incoming→player, emits new `'dodge'`
  event). Gated on `EffectiveStats`; rolls use `world.rng.next()`.
- **`shared/combat-events.ts`** — added `'dodge'` type + optional `isCrit`.
- **`game/ai/simulation-step.ts`** + **`bootstrap/floor1-main-scene-options.ts`** —
  run `statSystem` each frame (headless + visual) so allocation reaches combat.
- **`engine/CombatVfx.ts`** — crit emphasis + cyan `DODGE` floater.
- **`labs/stat-lab`** — allocate Luck/Dex, watch crit/dodge rise.
- **`shared/stat-display.ts`** — Luck/Dex level-up summaries list crit/dodge gains.
- **Tests** — `combat-rolls.test.ts`, `effective-stats.test.ts`,
  extended `stat-display.test.ts`, updated `equipment.property.test.ts`.
- **Headless** — re-probed the gate's canonical **seed 6** (RNG shifted): VICTORY
  ~139s, level 5, 14 kills, all 5 quests; updated the gate's header comment.
- **ADR 0018** documents the cross-layer decision.

## What's Next

**PR2 (ITEM 6), stacked on `nalfeo-stats-and-abilities`:**

- Wisdom → mana pool resource (real work; `world.playerMp`/`playerMaxMp` are
  currently hardcoded 100/100 in `world.ts`). Completes the Wisdom "(no effect
  yet)" half left by PR1.
- New `manaSystem` **must have a lab** in `src/labs` (repo rule).
- Harden ITEM 6a: the slime-rat / spell-broker win quest should unlock a concrete
  spell + flip the ability-system feature flag (the unlock path
  `selectSpellFromBossBattle` already exists and is tested — verify + harden).
- HUD mana bar; re-probe headless seed again (mana spend may shift RNG); verify;
  open stacked PR2; report link to creator.

The SQL todo table in this session (`pr2-*` rows) has the full PR2 breakdown.

## Blockers

None. PR1 is green end-to-end.

## Branch State

- Branch: `nalfeo-stats-and-abilities`
- All tests passing: yes (`npm run verify` full suite + `lab-gate-check.sh`)
- PR created: pending (this handoff + ADR 0018 satisfy the PR preflight guards;
  PR opens immediately after)

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 1,
  "guards": {
    "pr-preflight": {
      "deny": 1
    }
  },
  "tools": {
    "create_pull_request": 1
  }
}
```

The single `pr-preflight` deny was this PR1: the guard correctly blocked the first
`create_pull_request` because the handoff (this file) and ADR 0018 were not yet
present. Both were then added.

## Test Results

- `npm run verify:fast` → 65 files / 612 tests passing.
- `npm run verify` (typecheck · lint · format · unit · integration · headless ·
  build) → ✅ passed.
- `scripts/agent/lab-gate-check.sh` → ✅ passed (every `core/systems` system has a
  lab; `effective-stats.ts` is a pure helper in `core/` root, not a system).
- Headless probe `npm run ai:headless -- --seed 6 --max-frames 19800` → VICTORY,
  ~139s game-time, level 5, 14 kills, all 5 quests.

## Key Decisions Made

- Derive crit/dodge from **effective** primaries (not the flat `stores.stats`
  pipeline) so allocation + equipment both flow through `EffectiveStats`.
- Centralize crit/dodge in the `applyDamage` choke point rather than per weapon
  handler.
- Mark crits via an `isCrit` flag on the existing `'hit'` event (not a separate
  `'crit'` event) so gore/drops/knockback consumers stay intact.
- `effective-stats.ts` is a pure helper living in `core/` root (alongside
  `apply-damage.ts`/`combat-rolls.ts`), so the lab gate does not treat it as an
  ECS system requiring its own lab.

See ADR 0018 for full rationale and alternatives.
