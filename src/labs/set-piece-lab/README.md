# Set Piece Viewer Lab

Visual inspector for **set pieces** — themed rooms "picked up from Earth and
dropped into the dungeon" (Jimmy's Pizza, a doctor's office, a blue-collar break
room, etc.).

Run it with `npm run lab` → open `?lab=set-piece-lab`.

## What it shows

- Renders the selected set piece on a tile grid, drawing every prop's stacked
  sprite **layers** in `z` order (e.g. a flower pot composited on top of a table).
- Resolves art from all three sprite sources:
  - **catalog** — reuse an existing sprite-catalog entry.
  - **sheet** — "recorded" frame from an existing spritesheet (sheetKey + col/row).
  - **custom** — a requested asset that does not exist yet; drawn as a magenta
    placeholder (or its optional stand-in) until real art is generated.
- Side panel lists set-piece metadata and the de-duplicated **custom art
  requests** the art pipeline still owes this room.

## Controls (lil-gui)

- **Set piece** — choose which room to inspect.
- **Zoom** — 1–6× pixel zoom.
- **Show grid** / **Prop labels** — layout debugging aids.
- **Mark custom art** — overlay the ◴ marker on layers backed by pending custom art.

## Source

- Data model + registry: `src/shared/set-piece-types.ts`
- Bundled content pack: `src/shared/data/set-pieces.json`

> Set pieces are **not** wired into map generation yet — this lab is the
> design/authoring surface for the content model only.
