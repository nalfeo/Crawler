---
name: prop-inventory
description: >-
  Decide what existing art a set piece can actually use, and rank what is missing.
  Use after `set-piece-blockout` and before commissioning any art, when asked "what
  props do we already have for this room", "what art do I need to generate for this
  set piece", or when a room is about to be dressed. Produces a kept list (existing
  sprites that fit the room art contract) and a ranked gap list that feeds
  `prop-commission`.
---

# Prop Inventory

The step between "I know what the room should be" and "I know what to build". Its
job is to prevent the two failure modes at either extreme: commissioning art that
already exists, and settling for a wrong-theme sheet cell because it was nearby.

**Precondition:** a completed `set-piece-blockout`, including the **room art
contract**. Without the contract you cannot judge fit, only availability.

## The three sources

| Source    | What it is                                                                       | When to prefer it                                      |
| --------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `catalog` | Approved generated art (`public/assets/generated/manifest.json`, sprite catalog) | Always first — it is on-style by construction          |
| `sheet`   | A raw spritesheet frame (e.g. `kenney-roguelike-rpg-pack` by `col`/`row`)        | Structure and filler only: floors, walls, generic trim |
| `custom`  | A bespoke request with a `requestId` the art pipeline keys against               | Anything the room's identity depends on                |

> **The sheet trap.** Twelve of thirteen shipped rooms are built almost entirely from
> one sheet, and that is the main reason they read as generic. Sheets are fine for
> floors, walls and background trim. They are not fine for the props that carry the
> room's identity — those get commissioned.

## Method

1. **Enumerate the prop list from the blockout.** Walk each zone and write the props
   that zone implies, with a footprint in feet and a `kind`. A service counter zone
   implies: counter (8x2.5 ft, furniture), register (1.5x1 ft, decoration), stool
   (1.5x1.5 ft, furniture), menu board (4x2 ft, decoration), clutter on the counter.
   **Include the stacking layer** — what sits _on_ each surface — or the room will
   fail the layer-depth check later.
2. **Search the catalog for each entry.** Match on concept, not on filename.
   Use the `search_assets` tool (provided by the `asset-search` extension) for
   semantic search — query with natural language like `"rusted iron storage"` or
   `"wooden furniture workshop"` to find relevant sprites by tag, not just filename.
   For example: `search_assets({ query: "ornate stone altar dungeon", type: "prop" })`.
3. **Score each candidate against the room art contract** — not against the global
   style guide, which everything already passes:
   - **Theme fit** — does it belong to this room's fiction?
   - **Scale class** — does its native aspect support the footprint in feet you need?
     A sprite drawn as a tall object cannot become a wide one.
   - **Palette compatibility** — is it inside the room's declared palette subset?
   - **Light/shadow agreement** — does its lighting match the room's declared
     direction? A top-lit prop in a left-lit room reads as pasted in.
4. **Bucket into keep / stretch / gap.**
   - **keep** — passes all four; use it.
   - **stretch** — passes theme and scale but conflicts on palette or lighting.
     Usable _only_ with a `tintHex` correction, and only for background props. If a
     stretch prop would be in the focal zone, treat it as a gap.
   - **gap** — commission it.

> **Floor art is never a stretch.** Palette compatibility is a _hard_ requirement for
> `kind: 'floor'` sprites — they tile across the whole room, so a mismatch is not a
> local blemish, it restructures how the room reads. Crawler's entire catalog floor
> set is grey stone / cave / sewer; dropped into the warm orange `welcome-room`
> carpet those tiles read as **holes in the floor**, and no `tintHex` rescues them.
> A floor variant that is not already in-palette is a gap. Commission it.

> **Never reuse a sprite just because its `kind` matches.** "Right category, wrong
> object" is the most common way a room turns back into slop: eight crates
> placeholdered with `welcome-room-shop-table` rendered as eight mini shop tables
> ringing the room. If nothing in the catalog is genuinely the object you need, that
> is a gap — say so rather than reaching for the nearest neighbour. 5. **Rank the gap list by visual impact.** Focal object first, then anything inside
> the player's likely eyeline, then perimeter dressing, then background filler. The
> ranking matters because commissioning is the slow step and you want the room to
> look right as early as possible.

## Output contract

Two lists, in session chat:

**Kept** — `prop name → sprite ref → footprint in feet → zone`.

**Gaps (ranked)** — `rank | prop name | footprint in feet | kind | zone | why no
existing art fits`. The last column is what `prop-commission` turns into a brief, so
write it as art direction, not as an apology.

Also state the count: `N props planned, K reused, G to commission`. If `G` is 0 you
are probably reusing too aggressively; if `G` is the whole list, check you actually
searched the catalog.

## Anti-patterns

- **Matching on filename instead of concept.** Generated art ships under brief ids;
  the concept you want may be under a name you did not guess.
- **Accepting a prop because it is the right _tile_ size.** Tile size is not scale.
  Judge the footprint in feet.
- **Filling the gap list with background filler.** If everything is a gap, the room
  will take forever and the identity props will land last.
- **Skipping the stacking layer.** Surfaces without clutter are the single most
  common cause of a failing layer-depth check downstream.

## Done when

Every prop in the blockout is bucketed, the gap list is ranked, and the counts are
stated. Then proceed to `prop-commission` for the gaps and `set-piece-dress` for the
kept props (they can run in parallel — dress with placeholders while art generates).

## Related

- `.github/skills/set-piece-blockout/SKILL.md` (previous step)
- `.github/skills/prop-commission/SKILL.md` (next step for gaps)
- `.github/skills/placeholder-audit/SKILL.md` (sibling: what existing art can retire a placeholder)
- `src/shared/set-piece-types.ts` — `SpriteRef` union
- **`asset-search` extension** — `search_assets` tool for semantic tag-based search (e.g. `search_assets({ query: "rusted iron workshop", type: "prop" })`)
