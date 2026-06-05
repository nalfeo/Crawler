# Tile Explorer Lab

Browses **every tile** of any registered spritesheet. Use it to
identify which frame indices correspond to weapons, projectiles,
items, etc. before mapping them to logical sprite IDs in
`src/engine/sprites/registry.ts`.

## How to use

1. `npm run lab`
2. Open `?lab=tile-explorer`
3. Pick a sheet from the **Sheet** folder
4. Click any tile to copy its frame index to the clipboard
5. Add a new entry to `SPRITES` in the registry, e.g.:
   ```ts
   { id: 'weapon.sword', sheetKey: KENNEY_TINY_DUNGEON, frame: 73, note: 'Iron sword' }
   ```

## Frame index math

For a sheet with `cols` columns: `frame = row * cols + col`.
The tile's tooltip shows `(col, row)` plus the frame number.

## Filtering

The **Filter** field accepts:
- A frame number (e.g. `73`) — exact match
- A frame number prefix (e.g. `7` matches 7, 70, 71, …)
- `col,row` (e.g. `1,6`) — exact tile coordinate

## Purpose

Tile Explorer shows raw sheet contents — even tiles we haven't named
yet — which is what you need when integrating a new pack.
