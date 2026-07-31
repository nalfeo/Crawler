# ADR 0070: Boss Chest Lifecycle and Reward Policy

## Status

Accepted

## Date

2026-07-24

## Estimated Complexity

🍎🍎🍎🍎🍎 — spans core (new lifecycle module + `world.bossChests` field), game
(reward-bundle resolver wrapper + `floor2Scenario.ts` wiring), and persistence
(`playerCarryover.ts`); introduces a new explicit state machine and a new
fail-closed policy boundary (Floor 1 equipment exclusion).

## Context

Floor 2 boss defeats need to grant equipment loot ("boss chests") as the
**second** equipment source after achievements (ADR 0069). Floor 1 must remain
equipment-free. The reward must be resolved deterministically at the exact
boss-defeat/chest-creation boundary, survive save/load, be claimable exactly
once via an atomic path, and expose explicit lifecycle states so a future
presentation/AI layer can drive chest-open UX without touching this policy
layer.

ADR 0069 already solved bundle resolution, RNG isolation, atomic
generation-registry commit, and exact-once claim generically (keyed by an
opaque string, not literally an achievement). Building new
generation/claim/RNG logic for boss chests would duplicate all of that and
risk a second, subtly different determinism/atomicity contract. This decision
reuses ADR 0069's primitives verbatim, keyed by `boss-chest:<familyId>`, and
adds only the state machine and policy-gating that boss chests uniquely need.

This touches 3 systems (boss-defeat detection, equipment reward resolution,
carryover) across `src/core` and `src/game`, so it requires an ADR.

## Decision

1. **Reuse, don't re-invent.** `resolveEquipmentRewardBundle` and
   `claimGeneratedEquipmentRewardBundle` (ADR 0069) are generic over their
   string key. Boss chests call them with `boss-chest:<familyId>` instead of
   an achievement id. No new generation, RNG, or claim-atomicity code is
   added — the boss chest slice is a thin state-machine wrapper.

2. **Explicit 4-state lifecycle**, stored per-chest in
   `world.bossChests: Map<string, BossChestRecord>`:
   `'available' → 'opening' → 'revealed' → 'claimed'`.
   - `available`: chest exists, bundle is already resolved (fail-closed — a
     chest is never created without a live bundle).
   - `opening`: transient marker set for the duration of the atomic claim
     call (single-threaded JS guarantees this never outlives one synchronous
     call — see Alternatives).
   - `revealed`: the atomic claim succeeded; instances are in the player's
     bag. Distinct from `claimed` so a future presentation layer can gate a
     reveal animation/acknowledgement without re-entering the grant path.
   - `claimed`: terminal state reached via `acknowledgeBossChestReveal`
     (state transition only — no presentation/audio implemented here).
     Re-invoking `openBossChest` on a `revealed`/`claimed` chest is a no-op
     success (`alreadyClaimed: true`) that never touches RNG or the generator.

3. **Boss-defeat boundary reuse and ordering.** Chest creation hooks into the
   existing per-family idempotency guard in `floor2Scenario.ts`
   (`decapitated.add(familyId)`), which already guarantees a family's
   boss-defeat logic fires exactly once per run. `spawnBossChestForDefeatedBoss`
   is additionally idempotent itself (checks `world.bossChests.has(chestId)`
   first) as defense in depth. **Ordering matters**: the chest-spawn call runs
   _before_ `decapitated.add(familyId)` and the goal-flag/encounter mutations,
   so a thrown `RewardBundleResolutionError` leaves the family retryable next
   tick instead of permanently latching "defeated" with no chest and no way to
   retry (surfaced by the adversarial plan review). `floor2Scenario.ts` has
   **two** independent boss-defeat latch paths that both call
   `decapitated.add`: the primary per-family combat-event loop, and a
   secondary "victory sweep" inside `floor2VictorySystem` that bulk-latches
   any remaining present families once all dens are unlocked and no living
   boss entities remain (covers a boss entity despawning/recycling without a
   normal `death` combat event). Code review round 1 found the secondary
   path originally omitted the `spawnBossChestForDefeatedBoss` call entirely,
   so a family latched only through that sweep would never get a chest. Both
   paths now call `spawnBossChestForDefeatedBoss` before `decapitated.add`/
   goal-flag mutations, and the call's own idempotency makes it safe to
   invoke redundantly from either path for an already-chested family. See
   `tests/unit/floor2-victory-system.test.ts`'s secondary-path regression
   test.

4. **Floor 2 equipment-economy gate, not the rewards gate.** Boss chests are
   gated on `getFloor2EquipmentEconomyAccess` (`floor2EquipmentEconomy`),
   which `world.ts` already documents as covering "Quartermaster stock + boss
   chest generation" — distinct from `getFloor2EquipmentRewardsAccess`
   (achievement bundles). Both gates fail closed off Floor 2, which keeps
   Floor 1 equipment-free regardless of flag values.

5. **Base pool: reuse, don't invent.** Boss chests draw from
   `FLOOR2_WEAPON_WAVE_A_BASE_IDS` — the same wearable-gear catalog already
   used for Floor 2 weapon-wave generation — as "current equipment
   definitions."

6. **Fail-closed error propagation mirrors ADR 0069.** A thrown
   `RewardBundleResolutionError` (config/catalog integrity bug, not
   player-driven) propagates, matching `unlockAchievement`'s convention,
   rather than being silently swallowed on a hot per-tick path.

7. **Carryover.** `world.bossChests` is serialized/restored in
   `PlayerCarryoverSnapshot` alongside `generatedEquipmentRewardBundles`, with
   the analogous semantic validation: only an `available` chest record may
   have a live bundle for its key (`opening` never persists, and both
   `revealed` and `claimed` chests must NOT have one, since
   `claimGeneratedEquipmentRewardBundle` deletes the bundle the instant it
   grants instances — well before the record reaches `claimed`). Malformed or
   inconsistent records throw `PlayerCarryoverSnapshotError` and fail closed
   the restore entirely, matching every other structural guard in
   `playerCarryover.ts` — there is no drop-and-log fallback. **Backward
   compatibility for the field itself**: `bossChests` was added to the
   `"player-carryover/v1"` shape without a schema-version bump (the same
   pattern PR #1810 used for `generatedEquipmentRewardBundles`), so a snapshot
   captured before this field existed still carries `schemaVersion:
"player-carryover/v1"` and matches the "current schema" branch of
   `normalizePlayerCarryoverSnapshot`. Multi-model code review (round 1, two
   independent models) caught that this branch cast the input directly
   without defaulting the new field, so restoring such a snapshot would throw
   `Expected array at bossChests`. Fixed by defaulting `bossChests` to `[]`
   in that branch when absent, so pre-existing saves restore cleanly with no
   boss chests (correct, since no boss chest could have existed for them).
   **Round 2 of multi-model review** (`gpt-5.3-codex`) caught that the initial
   `?? []` default treated an explicitly-present `null` the same as "absent",
   silently bypassing `assertArray`'s fail-closed guard for a genuinely
   malformed value. Fixed by defaulting only on true key-absence (`'bossChests'
in record`), so a present-but-invalid value still falls through to
   `assertArray` and throws. **Round 3 of multi-model review**
   (`gemini-3.1-pro-preview`) found the per-record validation loop checked
   `state` and derived `chestId` but never type-checked `familyId`/
   `createdAtMs` — a numeric `familyId` silently passes the chestId-derivation
   equality check because template-literal interpolation coerces it to a
   string, so a malformed record could still pass validation. Fixed by adding
   explicit `typeof` guards for both fields, mirroring the existing
   `achievementId` string guard on `generatedEquipmentRewardBundles`.
   **Round 4 of multi-model review** (`gemini-3.1-pro-preview`) found two more
   gaps in the same code region on a fresh full pass: (a) the round-1
   absent-key default was only ever applied to `bossChests`, but
   `generatedInventoryInstanceKeys`, `generatedEquippedInstanceKeys`, and
   `generatedEquipmentRewardBundles` were _also_ added to the
   `"player-carryover/v1"` shape without a schema-version bump, so a
   pre-existing snapshot missing any of those three still hit the same
   `Expected array at ...` hard-fail the round-1 fix was meant to prevent; and
   (b) `assertArray` only checks `Array.isArray`, so a malformed array element
   (e.g. `null`) in either `bossChests` or `generatedEquipmentRewardBundles`
   bypassed the fail-closed `PlayerCarryoverSnapshotError` system entirely and
   threw a native `TypeError` instead. Fixed by extending the absent-key
   default to all four fields, and by adding an explicit object guard at the
   top of both per-record validation loops.
   See `tests/unit/player-carryover.test.ts`'s
   `restores a "player-carryover/v1" snapshot captured before bossChests
existed`,
   `still fails closed when a "player-carryover/v1" snapshot has an
explicitly null bossChests`,
   `fails closed when a persisted boss chest has a non-string familyId`,
   `fails closed when a persisted boss chest has a non-numeric createdAtMs`,
   `restores a "player-carryover/v1" snapshot missing
generatedEquipmentRewardBundles`,
   `fails closed when a persisted boss chest entry is null`, and
   `fails closed when a persisted generated reward bundle entry is null`
   regression tests.

8. **Reserved id namespace.** Achievement ids and boss-chest ids share one
   reward-bundle keyspace. `BOSS_CHEST_ID_PREFIX` (`'boss-chest:'`, defined in
   `src/shared/achievements.ts`) is exported so `createBossChestId` (core) and
   the achievement-catalog validators (`parseAchievementCatalog`/
   `createAchievementCatalog`, shared) derive from one source of truth.
   Catalog construction throws if any authored achievement id starts with the
   reserved prefix, preventing an authoring accident from aliasing two reward
   sources onto the same bundle-map entry.

## Consequences

### Positive

- Zero new generation/RNG/claim-atomicity code — inherits ADR 0069's
  determinism and exactly-once guarantees directly.
- Explicit, testable state machine gives a stable seam for a future
  presentation/AI layer (chest-open animation, AI loot-routing) without this
  PR needing to implement either.
- Floor 1 exclusion is structural (chest creation is only ever called from
  `floor2Scenario.ts`; the economy gate additionally fails closed off Floor 2)
  and has a direct regression test on the shared loot tables.

### Negative / Risks

- A fourth persisted map (`world.bossChests`) alongside
  `generatedEquipmentRewardBundles` means two data structures must stay
  consistent; the carryover validator is the single point enforcing that.
- The `opening` state is unobservable outside the single synchronous
  `openBossChest` call today; it only becomes meaningful once a future
  presentation layer introduces a real async gap (see Alternatives).

## Alternatives Considered

1. **Two-state model (`available` → `claimed`, no `opening`/`revealed`)** —
   rejected via adversarial review: the hard requirement asks for states
   "suitable for later UX/AI," which implies a future chest-open
   animation/acknowledgement step. Collapsing to two states would require a
   breaking schema change later; the 4-state model costs one extra field and
   one extra transition function today.
2. **Event-sourced lifecycle (append-only transition log, state derived by
   replay)** — rejected: no other part of the codebase persists lifecycle as
   an event log (achievements use plain state sets), and replay-derived state
   would complicate the carryover validator for no behavioral benefit at this
   scope. A mutable record with an explicit `state` field matches the
   `achievements.{unlockedIds,pendingUnlockIds,claimedIds}` precedent.
3. **New standalone claim/generation logic scoped to boss chests** —
   rejected: would duplicate ADR 0069's determinism, atomicity, and
   RNG-isolation guarantees under a second, divergence-prone implementation
   for no functional gain, since the existing primitives are already generic
   over their key.

### Amendment (2026-07-31): base-pool rationale after non-armor decoupling

ADR 0069 now enforces the Common non-armor contract by generation behavior
rather than base prefiltering. Boss chests continue to use
`FLOOR2_WEAPON_WAVE_A_BASE_IDS` as their deterministic authored pool, but no
longer rely on a "stat-bonus-free base" precondition to satisfy Common
eligibility.
