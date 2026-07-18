# Handoff: B1 — Add generated equipment instance registry

**Date:** 2026-07-17  
**Session slug:** b1-generated-equipment-registry  
**Branch:** `copilot/b1-add-generated-equipment-instance-registry`  
**Base:** `nalfeo-floor-2-equipment-contracts` (A1 dependency branch)  
**PR:** #1289 (stacked on A1 / closes issue #1289)  
**Apple estimate:** 3🍎 · **Actual:** 3🍎

## Systems touched

equipment, world

## What was done

Implemented the B1 slice of the Floor 2 equipment epic: versioned generated-equipment-instance
contracts and a world-owned generated-item registry keyed by stable instance identity.

### New files

| File                                                                                          | Purpose                                                               |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/shared/generated-equipment-types.ts`                                                     | Brand types, constants, type guards for generated equipment instances |
| `src/game/generated-equipment-registry.ts`                                                    | World-owned registry (create, register, lookup, snapshot/hydrate)     |
| `tests/ecs/generated-equipment-registry.test.ts`                                              | 75 unit tests                                                         |
| `tests/property/generated-equipment-registry.property.test.ts`                                | 8 property tests (fast-check)                                         |
| `docs/knowledge/review-ledgers/2026-07-17-b1-generated-equipment-registry.review-ledger.json` | 3-apple review ledger (plan_review + code_review, both clean)         |

### Modified files

| File                | Change                                                                     |
| ------------------- | -------------------------------------------------------------------------- |
| `src/core/world.ts` | Added `floor2EquipmentFlags` struct (7 boolean flags, all default `false`) |

## Architecture decisions

- **`GeneratedEquipmentInstanceId`** brand type: `` `gei:v1:${string}:${number}` `` validated by regex
- **`EquipmentFingerprintV1`** brand type: `sha256:<64 hex>` validated by regex
- **Async SHA-256 fingerprint** via `globalThis.crypto.subtle.digest` — works in Node 18+ and browsers
- **WeakMap side-map** for per-world storage — same pattern as `equipmentSystem.ts`
- **`registerInstance` is async** — cryptographic fingerprint validation before storage
- **`lookupInstance` is sync** — read path works regardless of feature flag state
- **Deep freeze** via `deepFreezeInstance()` — all nested objects (resolvedEffects, frozen, statBonuses) are frozen, not just the top-level
- **Null-safe `validateInstanceStructure`** — explicit guards for null `frozen` and `frozen.statBonuses` before calling `Object.entries`
- **Serialization boundary**: `snapshotRegistry()` → array; `hydrateRegistry()` → async import with structure + fingerprint validation

## Key constants (ADR 0065 DEC-005)

| Constant                   | Value                                 |
| -------------------------- | ------------------------------------- |
| `RARITY_INHERENT_SCALAR`   | common=1.00, uncommon=1.05, rare=1.10 |
| `RARITY_EFFECT_BUDGET`     | common=0, uncommon=1, rare=2          |
| `ENHANCEMENT_MIN/MAX`      | 0 / 5                                 |
| `ENHANCEMENT_STEP_PERCENT` | 0.05                                  |

## Plan review summary

Reviewed by `gpt-5.4` (reasoning: high). 7 concerns raised, all resolved:

- (Blocking) Added `snapshotRegistry`/`hydrateRegistry` serialization boundary
- (Blocking) Added synchronous `validateInstanceStructure` before registration
- (Blocking) Made `registerInstance` async (fingerprint check async, registration sync gate)
- (Non-blocking) Documented `FrozenEquipmentFieldsV1` V1 exclusion of `activeWeaponSnapshot`
- (Non-blocking) Added strict brand-type guards with regex validation
- (Non-blocking) Added null-guard for `frozen.statBonuses` in validation
- (Non-blocking) Added deep freeze for nested objects

## Code review summary

Reviewed by `claude-sonnet-4.6` (round 1). 3 concerns raised, all resolved:

1. (High) `validateInstanceStructure` could throw on null `frozen`/`statBonuses` — added null guards
2. (Medium) `Object.freeze` was shallow — replaced with `deepFreezeInstance()`
3. (Medium) Property test isolation check was vacuous — rewritten with disjoint ID spaces + real fail path

## Test coverage

- 75 unit tests covering: identity, lookup, version rejection, duplicate handling, structural validation, fingerprint, deep-freeze immutability, null-safety, per-world isolation, feature flag, snapshot/hydrate round-trip, constants
- 8 property tests covering: lookup invariant, fingerprint determinism, fingerprint sensitivity, per-world isolation (disjoint ID spaces), canonical JSON stability

## Feature flags

All `floor2EquipmentFlags` default to `false`. Set `world.floor2EquipmentFlags.floor2EquipmentRegistry = true` to enable registration. Lookup works regardless of flag state.

## Stacking note

This PR is stacked on A1 (`nalfeo-floor-2-equipment-contracts`). Rebase onto A1 while it is open; after A1 merges, retarget toward `main`. Do not auto-merge without explicit authorization.

## Excluded scope

No instance-aware bag movement, carryover, reward generation, Quartermaster stock, weapon snapshots, sourced abilities, content catalog, or AI behavior — all deferred to downstream slices.
