# Session Handoff: Set Piece Themed Rooms — Design + Foundation

## Date

2026-06-25

## Persona(s) adopted

**Producer** — the task spans content modelling, a shared data sub-system, an
art-pipeline seam, and a viewer lab, so it needed coordination across layers
rather than a single specialist.

## Routing verdict

✅ right persona — multi-layer/ambiguous design work is exactly the Producer's
default lane.

## Apples

Estimated: 🍎 x 4 <!-- declared before work began -->
Actual: 🍎 x 4
Verdict: 🎯 Exact — new config-pack sub-system + 12 content defs + pure helpers +
viewer lab + tests + ADR landed as a single coherent Large slice, no surprises.

Hello kitties: 4/5 = 0.80 🎀

## Systems touched

mapgen

## What Was Done

Began the "set piece" themed-room system (Earth locales dropped into the
dungeon). Design-only foundation — **not** wired into map generation.

- **Data model** `src/shared/set-piece-types.ts` (Zod-validated packs → compiled
  registry, like quests; `installSetPiecePacks` / `installDefaultSetPiecePacks`).
  - `exact` (fixed footprint, e.g. Jimmy's Pizza) **and** `themed` (flexible kit
    with min `width/height` + `maxWidth/maxHeight`) sizing.
  - Props with semantic `kind` (floor/wall/door/fixture/furniture/decoration/
    actor) defaulting render `z` via `PROP_KIND_Z`.
  - Three-way `SpriteRef` union: `catalog` (reuse), `sheet` (record an existing
    frame), `custom` (request art + optional placeholder).
  - Sprite **layering** (`SpriteLayer[]` per prop w/ offset/scale/tint) →
    `flattenSetPieceLayers()` render order; `collectCustomArtRequests()` surfaces
    the art backlog.
- **Content pack** `src/shared/data/set-pieces.json` — 12 set pieces across food,
  retail, transit, medical, office, domestic, services, education (17 distinct
  custom-art requests).
- **Viewer lab** `src/labs/set-piece-lab/` (`?lab=set-piece-lab`), registered in
  `src/lab-main.ts`; renders layered sprites + magenta placeholders, lists art
  requests. README included.
- **Tests** `tests/unit/set-piece-types.test.ts` (18 tests): pack load, sizing,
  z-defaults, all-three-sources coverage, layering, flatten order, custom-art
  collection, schema rejections (out-of-bounds prop, max-on-exact, dup ids),
  runtime pack install/reset.
- **ADR** `docs/knowledge/adr/0024-set-piece-themed-rooms.md`.

## What's Next

- Author more set pieces (goal: hundreds) now that the model is stable.
- Generate the 17 requested custom art assets and promote them to catalog
  entries; placeholders auto-resolve once `catalog`/`sheet` refs replace `custom`.
- **Map-gen integration** (deliberately deferred): stamping set pieces into
  floors will likely need anchors/door-side metadata — extend the schema behind
  the `version` field.

## Blockers

- Could not visually confirm the lab in-browser: the Playwright MCP Chrome
  profile (`/root/.cache/ms-playwright/mcp-chrome`) was locked by a prior session
  and not clearable from the runner user. Logic is fully unit-tested and the lab
  reuses the proven sprite-catalog-lab rendering path.

## Branch State

- Branch: `copilot/design-set-piece-themed-rooms`
- All tests passing: yes (`npm run verify:fast` ✅; full unit suite 1985 ✅; lab
  gate ✅)
