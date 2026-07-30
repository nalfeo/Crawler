# ADR: InventoryBag accessor contract

## Status

Accepted

## Date

2026-07-30

## Estimated Complexity

2 apples - targeted review recovery spanning shared inventory contracts, engine inventory rendering, and lint enforcement

## Context

`InventoryBag` now has two storage lanes: stackable static `slots` and exact generated-equipment
references in `generatedEquipment`. The initial encapsulation pass correctly added shared accessors,
but two follow-up review gaps remained:

- the Inventory UI still rendered only the static lane, so a generated-only bag could appear empty
  even though `equipFromBag(...)` already supports exact generated entries;
- the lane-access lint rule only matched a few hardcoded AST shapes, so direct reads like
  `world.inventories.get(eid)!.slots` could still bypass the stated ban.

Because the branch changes shared inventory contracts, the real shipped inventory UI, and the lint
workflow that is supposed to defend those contracts, this recovery crosses multiple systems and
needs an ADR.

## Decision

Treat shared inventory accessors as the only supported cross-lane read contract, and make the real
Inventory UI consume the discriminated inventory view instead of the legacy static lane.

- **DEC-001**: Render `InventoryUI` from `listInventoryEntries(...)`, resolving generated entries
  through the world registry so generated-only bags produce real cells, tags, tooltips, counts,
  and refresh signatures.
- **DEC-002**: Route inventory double-click equip intents through a widened callback that can pass
  either a static item id or a `GeneratedEquipmentInventoryEntry`, reusing the existing
  `equipFromBag(...)` overload rather than inventing a parallel UI-only path.
- **DEC-003**: Replace the narrow selector-based lint check with a dedicated custom ESLint rule
  that recognizes InventoryBag aliases and wrapper nodes such as `TSNonNullExpression`, so the ban
  applies to real code patterns instead of identifier-name conventions.
- **DEC-004**: Add deterministic regression coverage for both the lint rule and the generated-only
  Inventory UI render path.

## Consequences

### Positive

- **POS-001**: Generated reward/equipment references are visible in the real inventory overlay even
  when the bag has no static items.
- **POS-002**: The Inventory UI can re-equip generated entries through the same authoritative core
  equip path already used by gameplay and AI callers.
- **POS-003**: Direct raw lane reads like `inventories.get(...)!.slots` now fail lint instead of
  silently bypassing the policy.

### Negative

- **NEG-001**: `InventoryUI` now owns a small amount of render-model projection logic for
  generated entries because the shared slot-only helpers cannot carry instance identity.
- **NEG-002**: The lint policy now depends on a repo-local custom rule instead of a pure
  selector-only ESLint configuration.

### Risks

- **RSK-001**: If future bag lanes are added, the custom lint rule and render projection must be
  updated in tandem or the contract will drift again.
- **RSK-002**: Generated entries whose registry records are missing fail closed (skip render) until
  their upstream ownership/serialization bug is fixed.

## Alternatives Considered

### Keep InventoryUI slot-only and count generated entries separately

- **ALT-001**: **Description**: Leave the grid static-only and merely include generated references
  in the footer/signature.
- **ALT-002**: **Rejection Reason**: That would still leave real player-held generated equipment
  invisible and not manually re-equippable, which preserves the user-facing bug.

### Expand selector-only lint patterns further

- **ALT-003**: **Description**: Add more `no-restricted-syntax` selectors for `TSNonNullExpression`
  and known alias shapes.
- **ALT-004**: **Rejection Reason**: The review failure came from exactly that shape-specific
  approach; a dedicated rule is more robust than continuing to enumerate bypass patterns.
