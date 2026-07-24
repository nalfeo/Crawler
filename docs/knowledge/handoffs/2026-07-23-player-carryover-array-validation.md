# Session Handoff: Harden playerCarryover.ts array-field validation

## Date

2026-07-23

## Persona

Reviewer (defense-in-depth hardening)

## Systems touched

player-carryover

## Apples

2🍎 exact

## What Was Done

Addressed all 5 validation gaps identified in issue #1821 (pre-existing
findings surfaced by the boss-chest-lifecycle multi-model review). All gaps
are in `src/game/playerCarryover.ts`'s `normalizePlayerCarryoverSnapshot` and
the inner validation functions of `validateGeneratedCarryover`/`validateGrantOwnership`.

### Findings addressed

**Finding 1 — `achievements.*Ids` never validated as arrays.**
Added a non-null object check on `normalized.achievements`, then `assertArray`
calls for `unlockedIds`, `pendingUnlockIds`, and `claimedIds`. Previously, a
malformed `unlockedIds: 5` threw a native `TypeError` from `new Set(...)`.

**Finding 2 — `inventorySlots` / `disabledEquipmentSlots` element types.**
After each `assertArray`, added per-element guards:
- `inventorySlots[i]`: must be a non-null object with `itemId: string` (non-empty) and `quantity: number`.
- `disabledEquipmentSlots[i]`: must be a string.

**Finding 3 — `playerSkills` / `persistentStatModifiers` not `assertArray`-checked.**
Added `assertArray(normalized.playerSkills, 'playerSkills')` and
`assertArray(normalized.persistentStatModifiers, 'persistentStatModifiers')`.

**Finding 4 — Grant-source arrays not per-element guarded.**
Three call sites hardened:
- `assertNoSerializedEquipmentGrantSources`: now iterates with `for (const entry of grantSources as readonly unknown[])`, validates each entry is a `[string, unknown[]]` tuple, and each source is a non-null object before accessing `.kind`.
- `validateGeneratedActiveGrantSources`: same per-entry and per-source guards added; `source` cast to `AbilityGrantSource` only after null-object check.
- `toSourcesMap` (inside `validateGrantOwnership`): `.map` callback now validates each entry is a `[string, string[]]` tuple before destructuring.

**Finding 5 — `equippedItemIds` elements not type-checked as strings.**
Added `for...of` loop after `assertArray(normalized.equippedItemIds, ...)` to
reject non-string elements explicitly.

### Tests added

`tests/unit/player-carryover.test.ts` — three new `it` blocks:

1. `'fails closed with PlayerCarryoverSnapshotError on malformed array-typed fields'`
   — 17 invalid inputs covering findings 1, 2, 3, and 5.
2. `'fails closed with PlayerCarryoverSnapshotError on malformed ability grant-source entries'`
   — 6 invalid inputs covering finding 4 (legacy `activeAbilityGrantSources` /
   `passiveAbilityGrantSources` per-entry and per-source guards).
3. `'fails closed with PlayerCarryoverSnapshotError on malformed grant-ownership source entries'`
   — 3 invalid inputs covering finding 4 (`toSourcesMap` guard, requires
   equipped generated instance with grants to trigger the `validateGrantOwnership`
   code path).

All tests assert mutation-before-throw safety (destination playerName stays
`'Unchanged'`), consistent with the existing test contract in this suite.

## Files Changed

- `src/game/playerCarryover.ts` — validation guards only, no changes to valid-input behavior
- `tests/unit/player-carryover.test.ts` — 3 new regression `it` blocks (existing test preserved)
- `docs/knowledge/review-ledgers/2026-07-23-player-carryover-array-validation.review-ledger.json` — 2🍎 ledger (no stages required)

## Not Done / Out of Scope

- No changes to `restorePlayerCarryover` itself — all new guards fire during the
  validation phase (before any mutation), so they were the right place per the
  existing fail-closed contract.
- The hardening is purely defensive; no normal gameplay path is affected.
