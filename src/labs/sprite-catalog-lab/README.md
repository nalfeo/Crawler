# Sprite Catalog Lab

Edits the schematized sprite/sheet catalog stored in
`src/shared/data/sprite-catalog.json`.

This lab supports:

- required one-sentence descriptions
- tags
- tile connectivity (`tile.connectsTo`) for tiled assets
- animation clip references (`animation.clips`) without per-frame prev/next links
- on-demand **AI generate + judge** for the currently selected catalog entry

## Run

```bash
npm run lab
# then open ?lab=sprite-catalog
```

## Write-back behavior

Repo write-back is **local-only**. Hosted builds (including GitHub Pages)
run this lab in read-only mode.
