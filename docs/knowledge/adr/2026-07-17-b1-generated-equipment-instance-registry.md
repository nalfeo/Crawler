# ADR 0065: B1 — Generated Equipment Instance Registry

## Status

Accepted

## Date

2026-07-17

## Estimated Complexity

🍎 x 3 — touches `src/core` (world flags), `src/shared` (contracts), and `src/game` (registry); no new ECS system, no lab required

## Context

The Floor 2 equipment epic (issue #1264) needs a stable, versioned identity foundation for
generated equipment instances. A1 (`nalfeo-floor-2-equipment-contracts`) defines the governing
spec and type-level contracts. B1 must add:

- Normalized base/affix/generated-instance contracts.
- A world-owned registry keyed by stable instance identity.
- Immutable static definitions and validated frozen resolved payloads.
- Deterministic creation, lookup, duplicate rejection, serialization boundaries, and
  tuning-drift/fingerprint validation.

This addresses two gaps in the existing equipment system:

1. `src/core/` has no concept of generated/procedural instances — only static definitions.
2. There is no world-level store for run-time produced equipment instances with stable IDs,
   version tracking, and cryptographic integrity.

## Decision

### Contracts (`src/shared/generated-equipment-types.ts`)

- Define `GeneratedEquipmentRarity` (`common | uncommon | rare`) matching ADR 0065 DEC-005.
- Define `GeneratedEquipmentInstanceId` brand type: `` `gei:v1:${string}:${number}` ``.
- Define `EquipmentFingerprintV1` brand type: `` `sha256:${string}` `` (64-hex SHA-256).
- Define `GeneratedEquipmentInstanceV1` — the versioned generated-instance record.
- Define `FrozenEquipmentFieldsV1` — immutable display/stat payload baked at generation time.
- Define `ResolvedEquipmentEffectV1` — normalized per-effect record (effectId, magnitude, units).
- Export ADR 0065 DEC-005 constants: `RARITY_INHERENT_SCALAR`, `RARITY_EFFECT_BUDGET`,
  `ENHANCEMENT_MIN/MAX`, `ENHANCEMENT_STEP_PERCENT`.
- Export type guards: `isValidGeneratedInstanceId`, `isKnownGeneratedSchemaVersion`,
  `isValidFingerprintV1`, `makeRunKey`.

### Registry (`src/game/generated-equipment-registry.ts`)

- **WeakMap side-map** pattern (per-world storage, same pattern as `equipmentSystem.ts`).
- **`registerInstance` (async)** — validates schema, structure, and cryptographic fingerprint
  before storage. Rejects unknown schema versions, structurally invalid instances, fingerprint
  mismatches, and duplicates. Returns `{ ok: true }` or `{ ok: false, reason, detail? }`.
- **`lookupInstance` / `hasInstance` / `getRegistrySize` (sync)** — read path works regardless
  of feature flag state (disabling stops generation, not reads).
- **`deepFreezeInstance`** — fully freezes the top-level record plus all nested objects
  (`resolvedEffects` entries, `frozen`, `frozen.statBonuses`) so stored instances are
  truly immutable.
- **`validateInstanceStructure`** — null-safe synchronous structural validation. Explicitly
  guards against null `frozen` and null `frozen.statBonuses` to prevent `TypeError` throws
  on corrupt or deserialized data.
- **Serialization boundary**: `snapshotRegistry()` → shallow array export;
  `hydrateRegistry()` → async import with structure + fingerprint re-validation.
  `hydrateRegistry` bypasses the `floor2EquipmentRegistry` feature flag (saves loaded from
  disk must always be importable) and continues to process valid instances even when one entry
  fails validation.
- **Canonical JSON for fingerprint**: keys sorted lexicographically at every level via
  `sortedReplacer`; `undefined` values throw; arrays retain order.
- **SHA-256** via `globalThis.crypto.subtle.digest` — works in Node 18+ (Vitest) and browsers.

### Feature flags (`src/core/world.ts`)

Added `floor2EquipmentFlags` struct to `GameWorld` with 7 boolean flags (all default `false`):

- `floor2EquipmentRegistry` — gates `registerInstance` (not lookup)
- `floor2AffixSystem`, `floor2EquipmentGeneration`, `floor2MerchantStock`,
  `floor2CarryoverItems`, `floor2RewardSystem`, `floor2WeaponSnapshots` — stubs for
  downstream B/C-slice feature flags.

## Consequences

### Positive

- Stable, versioned identity foundation for the entire Floor 2 equipment epic.
- Cryptographic fingerprint enables tuning-drift detection at save-load boundaries.
- Per-world isolation via WeakMap avoids cross-world contamination in headless multi-run sweeps.
- Deep freeze prevents accidental mutation of stored instances by downstream consumers.
- Feature-flag gating allows incremental opt-in without touching existing inventory/reward code.
- No `*System` exported → no lab wiring required, no CI orphan-system guard triggered.

### Negative

- Async `registerInstance` cannot be called in a per-frame hot loop; designed for floor-load
  time only.
- Adding `floor2EquipmentFlags` to `GameWorld` increases the interface surface slightly.

### Risks

- SHA-256 availability: `globalThis.crypto.subtle` is polyfilled by Vitest/Node 18+ but could
  be absent in very old or unusual runtime environments. Considered registering a sync hash
  fallback but deferred until a concrete need arises.
- Deep freeze of `resolvedEffects` entries could break code that expects to mutate effects
  post-registration. Downstream slices should construct new instances rather than mutating.

## Alternatives Considered

1. **Sync fingerprint via `crypto` Node module**: Would simplify the call site but create a
   Node-only dependency, breaking browser builds. Rejected; `globalThis.crypto.subtle` is
   universal.

2. **Global Map instead of WeakMap**: Simple but causes memory leaks (worlds not GC'd) and
   cross-world contamination in headless multi-run sweeps. Rejected.

3. **ECS component store for instances**: Aligns with bitecs patterns but adds unnecessary
   complexity — generated instances are sparse, not hot-path-iterated, and need stable string
   IDs. A plain `Map<instanceId, instance>` per world is simpler and sufficient.

4. **Storing instances as plain JSON without freeze**: Simplifies registry but violates the
   immutability contract from the spec. All downstream code consuming registry entries would
   need to defend against mutation. Deep freeze enforces the contract at storage time.
