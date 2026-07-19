# Session Handoff: Unique Equipment Schema, Acquisition, and Duplicate Policy

## Date

2026-07-19

## Persona

Producer → Game Designer (design/spec work only; no runtime implementation).

## Systems touched

inventory, quests, vfx

## Apples

3🍎 estimated, 3🍎 actual (exact). Pure documentation/design session spanning
schema, save/migration, acquisition, duplicate policy, art, Director, and lore
across inventory, quests, and VFX systems.

## What Was Done

Delivered the full Unique equipment design contract outside the Floor 2 equipment
epic's 37-node DAG, as specified in ADR 0065 DEC-010 and issue #1274:

1. **ADR 0066** (`docs/knowledge/adr/0066-unique-equipment-schema-and-acquisition.md`)
   — records the authored-singleton vs rarity-extension design decision, per-Unique
   duplicate rules (burn, disallow, convert-upgrade), acquisition source types, and
   all rejected alternatives (rarity extension, procedural generation, global duplicate
   rule, stacking, lazy art assignment).

2. **`## Unique Equipment` section in `.specify/specs/equipment-system.md`** —
   normative spec covering `UniqueEquipmentDef` schema (v1), relationship to
   generated instances, singleton ownership model, acquisition and duplicate policy
   enforcement, ability/passive grant model (extending ADR 0065 DEC-006), save /
   migration / carryover semantics, compatibility with inventory / rewards / shops /
   chests, Director presentation and lore integration, and art requirements.

3. **`.specify/specs/unique-equipment-roster.md`** — five fully authored Uniques,
   each with: display name, identity, bespoke mechanic and rationale (why it can't
   be expressed as effect-units), acquisition path, duplicate rule, lore hook, slot,
   art requirements (sprite/icon/VFX keys), and quest/achievement relationships.
   Includes a roster summary table and art production plan for Unique Wave 1.

4. **ADR README index** updated with ADR 0066 entry and corrected file count.

This session is docs-only. No runtime code, no feature flags, and no changes to the
Floor 2 equipment epic's 37-node DAG.

## Key Decisions Made

1. Unique equipment uses a separate `UniqueEquipmentDef` schema — not an extension
   of `GeneratedEquipmentRarity`. The two schemas are permanently parallel; each
   has its own identity model, ownership surface, and save fields.

2. Per-Unique duplicate rules (burn / disallow / convert-upgrade) rather than a
   global policy, because different items have different lore-coherent semantics.

3. Ability grants use the same source-owned model as ADR 0065 DEC-006, with source
   IDs `unique:<uniqueId>:<abilityOrdinal>`.

4. Save format is additive: two new fields (`ownedUniques`, `equippedUniques`) on
   the player's equipment state, forward-compatible (unknown IDs preserved on load).

5. Art is never from the generated pipeline — every Unique requires dedicated
   authored briefs through `sprites:enqueue`.

## What's Next / Blockers

- **No implementation is blocked on this session.** This is the design contract.
- Runtime implementation of Unique equipment is planned independently of the
  Floor 2 equipment epic; it requires a new epic or a separate approved scope
  extension.
- The five Uniques in the roster (Showstopper, Curator's Monocle, Floodgate Bracer,
  Contestant's Ring, Regret's Echo) are ready for art brief authoring when the art
  production pipeline is staffed for the Unique Wave 1 batch.
- The Echo Keeper and Curator NPC chains referenced by the quest-reward Uniques
  require authored NPC dialogue content, which is out of scope here.
- The `survive-floor2-deathless` achievement referenced by Contestant's Ring must
  be defined in the achievement catalog when that system ships.

## Retrospective

### Lessons Learned

- Docs-only changes with `.md` files under `docs/` and `.specify/specs/` are
  correctly classified as non-code by `pr-scope.mjs` (via `ANY_MD_TXT_RE`) and
  exempt from the review-ledger guard. No ledger file is needed for this session.
- The `isNonCodeOnlyDiff` exemption covers all `.md` and `.txt` files outside
  `src/`, which includes `.specify/specs/` paths — a useful thing to verify at
  session start for future docs-only work.
- The ADR README count line must be updated manually; it is not auto-generated.

### Mistakes Made

- None of substance. The `docs/` scope classification meant the review-ledger
  guard exemption was confirmed before creating files rather than after — good
  early check.

### Opportunities for Future Improvement

- The ADR README count and index are maintained by hand; a script that auto-scans
  `docs/knowledge/adr/` and emits the table would prevent drift (similar to the
  handoff INDEX generator).
- The `UniqueEquipmentDef` schema TypeScript types defined in the spec would
  benefit from being extracted to `src/shared/unique-equipment-types.ts` when
  runtime implementation begins, so the spec and source stay in sync.
