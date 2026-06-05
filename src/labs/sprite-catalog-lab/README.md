# Sprite Catalog Lab

Edits the schematized sprite/sheet catalog stored in
`src/shared/data/sprite-catalog.json`.

This lab supports:

- **Live sprite preview** — renders the actual sprite image from the sheet
- **Sheet parser** — browse all frames in a sheet, select individual tiles, and add them to the catalog
- Required one-sentence descriptions
- Tags
- Tile connectivity (`tile.connectsTo`) for tiled assets
- Animation clip references (`animation.clips`) without per-frame prev/next links
- On-demand **AI generate + judge** for the currently selected catalog entry

## Run

```bash
npm run lab
# then open ?lab=sprite-catalog
```

## Sheet Parser workflow

1. Select a sheet entry (e.g. `sheet:kenney-tiny-dungeon`)
2. Scroll to the "Parse Sheet → Catalog" section
3. Click frames to select them (green-bordered frames are already cataloged)
4. Click "Add selected to catalog" to persist them

Generated sprites get IDs like `sprite:kenney-tiny-dungeon.frame.42` and are
tagged with `generated` for easy filtering.

## Write-back behavior

Repo write-back is **local-only**. Hosted builds (including GitHub Pages)
run this lab in read-only mode.
