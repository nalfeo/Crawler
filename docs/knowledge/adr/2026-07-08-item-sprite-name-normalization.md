# ADR: Item sprites resolve by item id (retire the `ItemDef.icon` indirection)

## Status

Accepted

## Date

2026-07-08

## Estimated Complexity

🍎 x 4 — touches three systems (items data, engine inventory/equipment UI, sprite pipeline)
plus a cross-lane disk migration of manifest + catalog + PNGs; no new lab required (resolver is a
pure `src/shared` helper unit-tested directly, observed against the real shipped manifest).

## Context

Inventory and equipment panels render a **real generated item sprite** when one exists, and a
2-character text placeholder otherwise. In practice the real art almost never resolved, so most
items showed the placeholder even though approved art was checked in.

Root cause (verified in code, not assumed): the sprite pipeline bakes the generation **version**
(`-vN`) into the manifest entry's **`briefId`**, not just the manifest map key:

| manifest key                   | `briefId`     | `sourceRun`   |
| ------------------------------ | ------------- | ------------- |
| `iron-ore-placeholder`         | `iron-ore`    | `placeholder` |
| `iron-ore-v1-var-0` (real art) | `iron-ore-v1` | a real run    |

Items resolve their sprite by `briefId === itemId` (`pickGeneratedVariant(registry, itemId, …)`).
The bare id `iron-ore` therefore matches the **placeholder** entry's `briefId`, never the real art
whose `briefId` is `iron-ore-v1`. The pipeline's own `placeholder-audit` collapses both to the
concept `iron-ore` and marks it "replaceable", but `generate-wiring` then files it as
"manifest-only, auto-resolves, no code needed" — a false assumption that left ~16 items stuck.

Two items papered over this with a manual **version-pin hack** in `items.ts`: `bone-club`
(`icon: 'baseball-bat-v1'`) and `classified-dossier` (`icon: 'classified-dossier-v1'`). The
`ItemDef.icon` field exists only to enable this hack — all six item helpers otherwise set
`icon: id`. The maintainer's directive: _"In inventory, we shouldn't need separate icons vs item
sprites. Just use the real item sprite."_

Additional verified facts that shape the decision:

- The bat's inventory **item id is `bone-club`**, and its art is keyed `baseball-bat-*` (mapped via
  `equipmentDefs`: `bone-club → weaponId: 'baseball-bat'`). There is no item id `baseball-bat`.
- `baseball-bat` is **multi-lineage**: `baseball-bat-v1-var-0` (real anchor) and
  `baseball-bat-v3-var-6` (**`anchor: null`**). The in-world swing must never resolve to `v3`.
- `classified-dossier`'s real art carries manifest `type: 'character'` (a data quirk), while its
  placeholder is `type: 'item'`. So `type` is **not** a reliable resolver/normalization signal.
- The only `ItemDef.icon` consumers are `InventoryUI`, `EquipmentUI`, and one integration test;
  save/load and the item index use ids, not `icon`.

## Decision

**An item maps to exactly one sprite — its real generated art — resolved by item id.** Concretely:

1. **New resolver `resolveItemSprite(registry, itemId, seed)`** in `src/shared/item-sprites.ts`.
   It gathers candidate manifest entries across **both** the item id **and**
   `getEquipmentDefForItem(itemId)?.weaponId`, then ranks the whole pool **globally** by quality
   tier: bare non-placeholder `briefId` > version-tolerant non-placeholder (`^concept-v\d+$`) >
   placeholder (last). A real weapon-id match therefore always beats an item-concept placeholder
   (the `bone-club` case). Within a tier it tiebreaks deterministically: non-null `anchor` →
   ascending version → item-id-before-weapon-id → `SeededRandom(seed).pick(...)` among exact ties.
   Placeholder ⇔ `sourceRun === 'placeholder'` or `assetPath` ends `-placeholder.png`. The generic
   registry (`lookup`/`variants`/`pickGeneratedVariant`) is left **unchanged**, so enemy/tile/
   set-piece resolution is untouched.

2. **Retire `ItemDef.icon`.** Delete the field, the six `icon: id` assignments, and both version-pin
   overrides. `InventoryUI`/`EquipmentUI` route through `resolveItemSprite(itemId)`.

3. **Canonical item-art naming = the bare item id.** An item's shipping manifest key + `briefId` +
   PNG + `generated:` catalog id equal the bare `<item-id>`; variants are `-var-<N>` only. Real art
   is physically re-keyed on disk by a deterministic, idempotent migration script (no hand-editing),
   and each `<item>-placeholder` entry is retired once real bare-keyed art exists. `type`, anchors,
   scores, timestamps, and `sourceRun` are preserved verbatim by the migration.

4. **`approve.ts` ships future item art bare.** For a brief whose name strips exactly one trailing
   `-vN` to a known **gameplay item identity** — a member of `{ all ItemDef.id } ∪ { weaponId
aliases }` (not the sprite `type`) — the version suffix is stripped before computing the variant
   id / sprite name / asset path, with an explicit collision error. True non-item briefs stay
   versioned.

Category prefixes (`tile-`/`prop-`) and explicit enemy pins are **kept** — different asset classes
resolve through different contracts, and forcing uniform naming would break environment/enemy art
for a cosmetic. This ADR is scoped to the **item-icon class**.

## Consequences

### Positive

- Items render their real approved art with no per-item `icon` bookkeeping; "no separate icon vs
  item sprite" is structurally true, not a convention.
- The pipeline's false "auto-resolves" assumption is fixed at the source (`approve.ts`) so the class
  of bug cannot silently recur.
- Blast radius is contained: only the item resolver changes behavior; the shared registry and all
  non-item consumers are byte-for-byte unaffected.

### Negative

- Item art now lives at a bare key, diverging from the still-versioned convention used by
  enemies/tiles — intentional, but the split must be documented for future art sessions.
- The migration rewrites files shared with other in-flight sessions (manifest, catalog, PNGs),
  requiring a tight allowlist and a rebase-then-rerun before the PR.

### Risks

- **Multi-lineage bat:** removing the override before the disk migration relies on the resolver's
  anchor/version tiebreak to prefer `v1` over `v3`. Mitigated by the deterministic tiebreak and by
  migrating `baseball-bat` to a single bare lineage (retiring `v3`) as a coordinated, atomic step.
- **Cross-lane collision:** consumable icons, harvestables, welcome-room set-pieces, and the enemy
  `angry-roomba` lane are explicitly excluded from the migration allowlist.

## Alternatives Considered

- **Registry-layer normalization (change `lookup`/`variants` to be version/placeholder aware).**
  Rejected: it would alter enemy/tile/set-piece resolution too — far higher blast radius for no item
  benefit. Containing the logic in `resolveItemSprite` keeps the generic registry pure.
- **Resolver-only (no disk rename).** Rejected against the maintainer's explicit turn-3 instruction
  to clean the names on disk; leaving `-vN` keys in place would keep the pipeline emitting the same
  inconsistent names and rely on the safety-net forever.
- **Keep `ItemDef.icon` and just fix the two overrides.** Rejected: it preserves the indirection the
  maintainer asked to remove and does nothing for the other ~14 stuck items.
