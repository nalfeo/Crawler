# Epic: Floor 2 Equipment

## Goal

Make every Floor 2 representative build feel meaningfully stronger as the player
levels up. The success criterion is a **median aggregate DPS ratio of 1.7×–2.3×**,
measured independently at two progression checkpoints:

| Checkpoint   | Baseline build          | Comparison build         | Target range |
| ------------ | ----------------------- | ------------------------ | ------------ |
| Level 1 → 6  | Naked level 1           | Tier-1 equipped level 6  | 1.7×–2.3×    |
| Level 6 → 11 | Tier-1 equipped level 6 | Tier-2 equipped level 11 | 1.7×–2.3×    |

"Aggregate DPS" is derived via the existing runtime helpers in `src/core/effective-stats.ts`
and `src/shared/stats.ts`. The B1 tooling MUST use these exact paths to avoid drifting from
live combat math:

1. `computeEffectiveStatsFromLoadout` (`src/core/effective-stats.ts`) computes
   `EffectiveStats` from base stats + level-up points + equipped items.
2. Weapon DPS at each level is then: `(weapon.baseDamage + eff.damageBonus) × (1 + eff.damagePercent) × attackSpeedFactor × critFactor × typedPrimaryMultiplier`, where:
   - `attackSpeedFactor = 1 / (1 + clamp(eff.attackSpeed, ATTACK_SPEED_BONUS_MIN_CLAMP, ∞)) × (1 − eff.cooldownReduction)` (see `applyAttackSpeedAndCooldownReduction`)
   - `critFactor = 1 + eff.critChance × (eff.critMultiplier − 1)`
   - `typedPrimaryMultiplier` = `computeTypedPrimaryMultiplier` from `src/shared/stats.ts` (the STR/INT typed-primary scaling path)

Deviating from these helpers risks tuning item stats against the wrong formula.

Release requires every **non-deferred** slice to reach `validated` status with
commit-addressed evidence, **and** both DPS-ratio checkpoints to pass.

---

## Control plane

| Artifact             | Path                                                              |
| -------------------- | ----------------------------------------------------------------- |
| This plan            | `docs/knowledge/epics/floor-2-equipment/PLAN.md`                  |
| State / cache        | `docs/knowledge/epics/floor-2-equipment/epic-state.json`          |
| Schema               | `docs/knowledge/epics/floor-2-equipment/epic-state.schema.json`   |
| Offline status       | `npm run epic:status -- floor-2-equipment`                        |
| Read-only audit      | `npm run epic:status -- floor-2-equipment --github --reconcile`   |
| Materialization plan | `npm run epic:status -- floor-2-equipment --materialization-plan` |

The Producer is the sole global-state writer. Child sessions update their own
child issue and handoff; they do not update `epic-state.json`.

---

## Slice graph

```
A0 (Bootstrap — this slice)
│
├── B1 DPS ratio measurement tooling
├── B2 Tier 1 equipment catalog
└── B3 Tier 2 equipment catalog
         │
         └── B4 Shop / loot-table wiring
                    │
                    ├── (+ B1) C1 DPS ratio validation sweep
                               │
                               └── C2 CI gate (deterministic test)
```

---

## Slice descriptions

### slice:A0 — Bootstrap: Control plane

**Status:** `in_progress` — advances to `validated` when this PR merges (Producer fills `commit_evidence` with the merge SHA).

Creates the durable planning artifacts you are reading now: `PLAN.md`,
`epic-state.json`, `epic-state.schema.json`, the `epic:status` CLI, and
the unit-test suite for the tooling. No equipment gameplay changes.

---

### slice:B1 — DPS ratio measurement tooling

**Status:** `planned` (computed-ready after A0 validates)

Build a deterministic script (`scripts/agent/floor2-dps-ratio.ts`) that:

1. Instantiates a representative level-1, level-6, and level-11 build using
   `computeEffectiveStatsFromLoadout` from `src/core/effective-stats.ts`.
2. Applies the Tier-1 loadout at level 6 and the Tier-2 loadout at level 11.
3. Computes aggregate DPS using the **runtime combat formula** from `src/shared/stats.ts`
   (typed-primary multiplier via `computeTypedPrimaryMultiplier`, cadence via
   `applyAttackSpeedAndCooldownReduction`, crit via `critChance`/`critMultiplier`) —
   NOT a simplified approximation.
4. Emits a JSON result with `ratio_1_to_6` and `ratio_6_to_11`.

Acceptance: script exits 0 and outputs both ratios to stdout as JSON. Unit test
that calls the script with a known fixed loadout and asserts the ratio matches the
analytically expected value (regression guard).

---

### slice:B2 — Tier 1 equipment catalog

**Status:** `planned` (computed-ready after A0 validates)

Define new entries for Floor 2 levels 1–5 in **both**:

- `EquipmentItemDef` entries (in `src/shared/equipmentDefs.ts` or a new
  `equipmentDefs.floor2.ts`) for the equipment slot system
- Matching inventory item entries in `src/shared/items.ts` (so items can live in
  the bag and round-trip through equip/unequip)

Target slots: at least one weapon slot (mainHand), one armor slot (torso or head),
and one accessory slot (ring or neck). Stat bonuses must be tuned — using the B1
measurement tooling — to contribute a share of the 1.7–2.3× DPS uplift at the
level-6 checkpoint.

Acceptance: all new defs pass the existing `equipmentSystem` integration tests;
B1 tooling reports `ratio_1_to_6` in [1.7, 2.3] with Tier-1 loadout equipped.

---

### slice:B3 — Tier 2 equipment catalog

**Status:** `planned` (computed-ready after A0 validates)

Define new entries for Floor 2 levels 6–11 in **both** `equipmentDefs` and `items.ts`
(same plumbing pattern as B2). Minimum coverage: one weapon upgrade (higher tier than
B2), one armor upgrade, one accessory upgrade. Stat bonuses tuned to contribute the
1.7–2.3× DPS uplift at the level-11 checkpoint over the Tier-1 equipped level-6
baseline.

Acceptance: B1 tooling reports `ratio_6_to_11` in [1.7, 2.3] with Tier-2 minus
Tier-1 loadout. All new defs pass existing equipment tests.

---

### slice:B4 — Shop / loot-table wiring

**Status:** `planned` (requires B2 + B3)

Wire Tier-1 items into the early Floor 2 shop archetypes
(`src/shared/data/shop-archetypes.floor2.json`) and any chest loot tables.
Wire Tier-2 items into mid/late Floor 2 archetypes and loot tables.

**Note:** Floor 2 currently has no AI shop-purchase loop (the settlement spawns
inventory snapshots but there is no AI agent that buys from shops on Floor 2). B4
does **not** need to add that loop — it only needs to make the items available.
The C1 sweep measures the DPS ratio analytically (via B1 tooling applied to
known loadouts), not from observed headless transactions.

Acceptance: `generateShopInventory` returns the new items for the appropriate
archetypes; unit tests verify the expected items appear in the loot pools.

---

### slice:C1 — DPS ratio validation sweep

**Status:** `planned` (requires B4 + B1)

Run ≥30 headless AI seeds with the Floor 2 scenario. For each seed, record the
aggregate DPS at the level-6 and level-11 checkpoints using the B1 tooling.
Compute the median ratios. Adjust Tier-1 / Tier-2 item stats if either median
falls outside [1.7, 2.3]. Iterate until both medians pass.

Acceptance: median `ratio_1_to_6` ∈ [1.7, 2.3] and median `ratio_6_to_11` ∈
[1.7, 2.3] across ≥30 seeds. Record evidence commit in `epic-state.json`.

---

### slice:C2 — CI gate (deterministic DPS ratio test)

**Status:** `planned` (requires C1)

Add a deterministic unit test in `tests/unit/` that calls the B1 DPS ratio
function with the Tier-1 and Tier-2 representative loadouts and asserts both
ratios are in [1.7, 2.3]. This test runs in CI on every PR and enforces the
hard release gate without headless compute.

Acceptance: `npm run test:unit` passes with the new test. The test is not
skipped or marked `todo`.

---

## Dependency graph (machine-readable)

See `epic-state.json` for the authoritative dependency list consumed by
`npm run epic:status -- floor-2-equipment --materialization-plan`.

---

## Governance

- **Producer** is the sole writer of `epic-state.json`.
- Child issues use structured `CLAIMED`, `BLOCKED`, `UNBLOCKED`,
  `SCOPE-CHANGE-REQUEST`, and `HANDOFF` comments (see parent issue #1264).
- Default leases are 24 hours; heartbeat required by 48 hours.
- Scope changes require a parent-issue request, impact analysis, coordinated
  plan/schema/state/issue updates, tier review, and evidence invalidation.
