# Session Handoff: Generic status-effect / stat-modifier framework (Floor 2 prep)

## Date

2026-07-02

## Persona(s) adopted

**Systems Engineer** (ECS/determinism-leaning specialist). The task was a single
deterministic ECS subsystem touching movement math across `core`, `game`, and the
sim pipelines — squarely a Systems Engineer scope rather than a multi-discipline
Producer split.

## Routing verdict

✅ right persona — the whole change lives in the ECS/determinism lane (components,
a system, read-site fold-ins, pipeline ordering, property/parity tests); no art,
UI, or cross-discipline coordination needed beyond a one-line file-ownership
de-conflict with the parallel combat-perf/Floor-2 sessions.

## Apples

Estimated: 🍎 x 4 <!-- declared before work began -->
Actual: 🍎 x 4
Verdict: 🎯 Exact — cross-layer framework + full tier-4 review harness; no scope
explosion and no blockers, and the determinism/parity discipline plus the
multi-model review-and-fix loop are inherent to a 4🍎 change rather than overruns.

Hello kitties: 4/5 = 0.80 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-status-effect-framework.review-ledger.json`
Stages (4🍎 tier): plan_review ✅ · dual_plan_synthesis ✅ · code_review ✅ · multi_model_review ✅
`npm run review:ledger -- validate <path>` → **valid 4-apple ledger** (exit 0).

- **dual_plan_synthesis**: 2 plans (gpt-5.5, gemini-3.1-pro-preview), judged/synthesized by claude-opus-4.8.
- **plan_review**: 2 separate-model rounds (gpt-5.4), 8 concerns, all resolved before code (notably a recycled-EID leak and an equip-atomicity hazard).
- **code_review / multi_model_review**: 2 rounds × 3 distinct models (claude-opus-4.8, gpt-5.5, gemini-3.1-pro-preview), adjudicated by claude-opus-4.8. Round 1 → 1 MAJOR + 5 MINOR (all valid, all fixed in `94b3a453`); round 2 → all three models CLEAN.

## What Was Done

Built **one** generic, deterministic, timed status-effect / stat-modifier framework
(not per-effect one-offs) and proved it on Floor 1.

- **Shared types** (`src/shared/status-effect-types.ts`): `StatusEffectSpec`/`StatusEffect`,
  `op: 'multiply' | 'add'`, `stat: 'speed' | 'hpRegen'` (extensible), discriminated-union
  `stackRule` (`replace` | `refresh` | `stack` + `maxStacks`), `sourceType`/`sourceId`,
  `durationMs: number | null` (null = persistent). `grantsStatusEffects?` added to
  `EquipmentItemDef` (`src/shared/equipment-types.ts`).
- **Core helpers** (`src/core/status-effects.ts`): `stackKey`, `getStatusEffects`
  (frozen empty on miss), `applyStatusEffect` (validated; replace/refresh/stack),
  `clearStatusEffects(predicate?)`, `computeEffectiveValue` (product-of-factors:
  `(base + Σadd) · Πmultiply`, optional clamp), `computeEffectiveSpeed`
  (default clamp `[0, base·3]`; Floor 2 hate-ramp will pass explicit `{min: base, max: playerSpeed}`).
  `isValidSpec` rejects non-finite/negative-multiply values, non-null non-finite/≤0
  durations, and stack rules without an integer `maxStacks ≥ 1`.
- **System** (`src/core/systems/statusEffectSystem.ts`): per-frame, timing from fixed
  `GAME.DELTA_MS` only. Expires timed effects deterministically (persistent skip),
  applies `hpRegen` HoT (living entities only, `max > 0` guard, write clamped to `[0, max]`),
  and prunes recycled/dead EIDs. Speed is a **read-site fold-in** — the system never
  mutates speed.
- **Sidecar + cleanup**: `world.statusEffectsByEntity` (`src/core/world.ts`);
  `clearEntityStores` deletes it on the sole non-lab creation path
  (`src/core/spawners/entity-core.ts`) to close the recycled-EID leak.
- **Read-site fold-ins**: player move speed in `src/core/systems/playerInputSystem.ts`;
  enemy speed at all three sites (wander, leap, cap) via `getEnemySpeed`/`getEnemySpeedCap`
  in `src/game/enemyAISystem.ts` — **slime-leap multipliers preserved** (fold-in composes
  with the existing leap scale).
- **Pipeline wiring**: `statusEffectSystem` runs **after** `enemyAISystem` (and after
  `playerInputSystem`, which precedes all `preSystems`) and **before**
  movement/damage/health in **both** pipelines — visual via `preSystems`
  (`src/bootstrap/floor-main-scene-options.ts`) and headless
  (`src/game/ai/simulation-step.ts`). This makes player + enemy speed reads see the same
  pre-expiry effect set each frame (no 1-frame skew) while keeping HoT before death.
- **Floor 1 demo**: the shopkeeper's **Merchant's Charm** now grants a persistent
  `hpRegen` 0.75 HP/s heal-over-time (`src/shared/equipmentDefs.ts`), applied atomically
  on equip and cleared on unequip (instance-scoped `sourceId`, `sourceType`-matched).
- **Lab**: `src/labs/statuseffect-lab/` exercising apply / stack / refresh / expire /
  clamp / HoT.
- **Tests** (~51): `tests/unit/status-effects.test.ts` (pure math + validation),
  `tests/unit/status-effects-no-wallclock.test.ts` (comment-stripped static scan — no
  `Date.now`/`Math.random`/`performance.now`), `tests/ecs/statusEffectSystem.test.ts`
  (stack rules, deterministic expiry, HoT + guards, equipment integration, recycled-EID,
  - a charm-HoT magnitude cap — win-rate honesty),
    `tests/ecs/statusEffect-pipeline-parity.test.ts` (exact-equal HoT parity across both
    pipelines + a visual-ordering guard), `tests/property/status-effects-properties.test.ts`
    (fast-check clamp/compose invariants).
- **ADR**: `docs/knowledge/adr/2026-07-02-status-effect-framework.md`.

## What's Next

- **Open the PR** (guard-cleared: valid ledger + this handoff present). Arm
  `gh pr merge --auto --squash` per merge policy.
- **Floor 2 hate-ramp** (out of scope here): implement as an **enemy-side `op:'add'`
  speed modifier source** re-applied per frame, calling
  `computeEffectiveSpeed(base, effects, { min: base, max: playerSpeed })`. The API is
  already shaped for it; no framework change should be needed.
- Optional future stats: fold `damage`/`defense`/`dot` through the same
  `computeEffectiveValue` path (the `stat` union and per-tick apply already generalize).

## Blockers

None.

## Branch State

- Branch: `nalfeo-improved-chainsaw` (off `main` @ `e55a0973`; NOT stacked on the Floor 2 docs branch)
- All tests passing: yes (see Test Results)
- PR created: not yet — `create_pull_request` is the next action this session
- Commits (9): framework core · charm demo · lab · tests · ADR · review fixes (`94b3a453`) · review ledger · charm-HoT win-rate cap guard · handoff + apple-metrics
- ADR filename uses the dated convention (`2026-07-02-status-effect-framework.md`),
  matching the same-day precedent `2026-07-02-ai-travel-steering.md` on `origin/main`;
  dated slugs are collision-free (no ADR-number merge race).
- File-ownership de-conflict confirmed with the Floor 2 / combat-perf sessions: this
  branch does **not** touch `src/core/systems/questSystem.ts`, `floorScenario.ts`, or
  `knockbackSystem.ts`.

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

> NOTE: the current artifact is dominated by **guard-suite test fixtures** written by
> the guard unit tests during `npm run verify` (guard ids like `boom`, `pr-hard`,
> `shell-bad`, `ctx-a` and the `create_pull_request`/`edit`/`powershell` tool counts are
> synthetic test events, not real session guard decisions). Included verbatim per policy.

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 15,
  "guards": {
    "boom": { "crash": 2 },
    "ctx": { "allow": 1 },
    "ctx-a": { "allow": 1 },
    "ctx-b": { "allow": 1 },
    "edit-bad": { "bypass": 1 },
    "edit-guard-self-protection": { "ask": 2 },
    "pr-a": { "deny": 1 },
    "pr-b": { "deny": 1 },
    "pr-hard": { "deny": 1 },
    "pr-warn": { "allow": 1 },
    "shell-a": { "deny": 1 },
    "shell-bad": { "deny": 2 }
  },
  "tools": { "create_pull_request": 4, "edit": 6, "powershell": 5 }
}
```

## Win-rate honesty (rule #13)

The headless AI **buys and equips** the Merchant's Charm mid-run (shopkeeper errand;
`equipPurchasedGear` in `src/game/ai/auto-progression.ts`), so the new 0.75 HP/s
heal-over-time is live during part of every Floor 1 win-rate run. Two things keep the
≥90% gate from silently depending on it:

- **Baseline argument:** the gate's per-weapon floors were set on the _pre-HoT_ charm
  (which granted only +1 charisma). This change only _adds_ healing, which can only
  raise win-rate — so a passing gate is not newly _dependent_ on the charm's heal.
- **Forcing function:** a deterministic guard (`tests/ecs/statusEffectSystem.test.ts`
  → "the charm HoT stays a modest, additive heal") pins the heal to ≤ 1 HP/s (≈ ≤ 60 HP
  over a ~60s floor). A future change that tried to crank free healing to mask a balance
  regression must consciously edit that bound, not slip past it.

No game balance was tuned to rescue specific seeds; the demo is a real purchasable item
on its real equip flow.

## Test Results

Full `npm run verify` → ✅ **all gates green**:

- typecheck / lint / format / dead-code → ✅
- guard + review-ledger tests → **212** ✓ (0 fail)
- unit → **2903** ✓ (255 files)
- integration → **49** ✓ (1 skipped)
- headless incl. **Floor 1 win-rate gate → 17** ✓
- PR prerequisites (early) → ✅ valid 4-apple ledger + committed handoff
- build → ✅ (only the pre-existing Phaser chunk-size warning)

`npm run typecheck` → ✅ exit 0; the 3 sprite-test typecheck errors flagged in the
original preflight are **not present** at this branch's base (`e55a0973`) — nothing to fix.

## Key Decisions Made

- **Product-of-factors** effective-value math with configurable clamps (default speed
  `[0, base·3]`), so multiplicative slows/hastes compose order-independently and the
  Floor 2 ramp can plug in as an additive source with explicit bounds.
- **Read-site fold-in** for speed (never mutate the stored speed) — keeps slime-leap
  and any base-speed source authoritative and makes ordering a pure timing choice.
- **statusEffectSystem after enemyAISystem** in both pipelines → player/enemy expiry
  symmetry (the MAJOR review fix), still before movement/damage/health.
- **Data-driven equipment effects** via `grantsStatusEffects` + instance-scoped,
  `sourceType`-matched `sourceId` so duplicate-capable items track/clear independently
  and `equip()` stays atomic (specs validated up front in `canEquip`).
- **Timing from fixed `GAME.DELTA_MS`** exclusively; no wall-clock anywhere (enforced by
  a static test).

## Retrospective

### Lessons Learned

- `world.stores.health` is a **Float32Array** and bitecs component identities
  (`Health`) are bare tags — data lives per-world in `world.stores.*[eid]`, and an
  **unset numeric slot reads 0, not `undefined`**. That invalidates `?? fallback`
  guards on stores and forces `toBeCloseTo(x, 3)` (not exact) for accumulated HoT math.
- The two sim pipelines have **different hook seams**: the visual step exposes
  `preSystems`/`postSystems`/`afterInput` (no pre-input seam), while the headless step
  hardcodes its order. "Run before both speed reads" was therefore impossible; the
  correct symmetric fix was "run after both reads, before movement".
- A latent-but-real correctness bug (the speed-expiry asymmetry) is still worth fixing
  properly when the fix is a zero-behavior-change reorder — cheaper than a documented
  caveat that the Floor 2 ramp author would trip over.
- PowerShell mangles the ledger CLI's `--json`; editing the ledger JSON directly is the
  reliable path. Prettier runs as a lint-staged pre-commit hook and re-adds files.

### Mistakes Made

- Initial cross-pipeline parity test asserted exact HP equality against a full-run
  oracle; the pipelines already diverge around `weaponSystem`/`floor1EnemyDirectorSystem`,
  so it was fragile. Early signal: plan-review r2 flagged it — switched to an isolated
  no-combat player-only fixture comparing only the HoT delta.
- The no-`Date.now()` static scan first matched the phrase inside doc comments; fixed by
  stripping comments before scanning. Early signal: the doc comments literally say
  "No `Date.now()`".
- Recorded the HoT exact value `50.75` before accounting for Float32 accumulation
  (`50.75004…`); relaxed to precision 3.

### Opportunities for Future Improvement

- Consider a tiny shared `preSpeedReads`/ordering assertion helper so both pipelines'
  system order can be asserted structurally in one place (only the visual `preSystems`
  is introspectable today; the headless order is guarded only behaviorally).
- `files/guard-telemetry.jsonl` gets polluted by the guard **test** suite during
  `verify`, making the handoff telemetry section noisy — worth having the guard tests
  write to a temp path so the session artifact reflects only real decisions.
- When Floor 2 lands the hate-ramp, add a determinism/parity test that a per-frame
  re-applied enemy `op:'add'` speed source yields identical results across both pipelines.

### Post-PR merge prep (rebase + review fix)

- **Rebased onto latest `origin/main` as the effective second-merger** (main advanced
  after the PR opened; the branch went `CONFLICTING`). The only conflicts were the two
  pipeline-ordering files; resolved by keeping the new relative order
  `enemyAISystem → statusEffectSystem → spawnerSystem → movement` (headless) and
  `enemyAISystem → statusEffectSystem → spawnerSystem → floor1EnemyDirectorSystem`
  (visual, preserving main's spawner→director adjacency contract). Per guardrail #3 I
  re-ran the **full `npm run verify` (exit 0)** + the **headless Floor 1 win-rate gate
  (19/19, sword/bow/baseball-bat)** + the **cross-pipeline parity + structural-ordering
  tests** on the rebased tree before force-pushing. `statusEffectSystem` never moves
  entities, so the reorder cannot perturb the combat-perf session's grid-build→melee window.
- **Addressed the Copilot PR reviewer's one finding** (`fix(core)`, commit `3b63f500`):
  `equip()` overrode a granted spec's `sourceId` but not its `sourceType`, while
  `unequip()`'s clear predicate matched on both — so a `grantsStatusEffects` entry with a
  non-`'equipment'` `sourceType` would apply on equip but never clear on unequip (latent
  leak). Fix normalizes `sourceType` to `'equipment'` on equip (mirroring the `sourceId`
  override); added a regression test (an `'aura'`-typed granted spec is applied as
  `'equipment'` and cleared on unequip). Replied `✅ Addressed` and resolved the thread.
- Net commit count on the branch is now **10** (the 9 above + the review fix). Auto-merge
  is armed (`--squash`); the branch is `MERGEABLE` with 0 unresolved review threads.
