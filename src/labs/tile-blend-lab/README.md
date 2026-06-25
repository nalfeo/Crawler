# Tile Blend Lab (`?lab=tile-blend-lab`)

A Canvas 2D sandbox for investigating smooth transitions between terrain tile types.

## Problem

Adjacent terrain types (e.g. Stone Floor → Grass) currently produce a hard, pixelated seam
in the RenderTexture terrain layer. This lab explores three techniques to soften those edges.

## Techniques

| Mode               | Description                                                           | Phaser port                                                                          |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Hard Edge**      | Baseline — raw tile stamps, no blending                               | `rt.stamp()` only                                                                    |
| **Gradient**       | Linear-gradient alpha overlay bleeds neighbour colour across the seam | After base bake, `rt.stamp()` semi-transparent gradient textures along seam edges    |
| **Ordered Dither** | Bayer 4×4 matrix selects neighbour pixels at seam, pixel-art-friendly | Pre-bake a dither-strip texture per seam direction; `rt.stamp()` with neighbour tint |

## Controls

| Control              | What it does                                    |
| -------------------- | ----------------------------------------------- |
| Left (A) / Right (B) | Terrain types that meet at the vertical seam    |
| Mode                 | Switch between hard / gradient / dither         |
| Width (px)           | Blend zone width in pixels                      |
| Cell Size            | Zoom (pixels per tile)                          |
| Show Grid            | Tile boundary lines                             |
| Show Sprite Frame    | Preview the raw spritesheet frame for terrain A |

## Porting to `terrain-renderer.ts`

### Gradient approach

After `buildTerrainLayer()` finishes its base stamp pass, add a second loop over border tiles:

```ts
// For each tile whose east neighbour is a different terrain:
const grad = scene.textures.createCanvas('blend-e', blendWidth, tileSize);
grad.context.fillStyle = createGradientFromNeighbourColor(…);
grad.refresh();
rt.stamp('blend-e', 0, (tx + 1) * tileSize - blendWidth, ty * tileSize, { originX: 0, originY: 0, alpha: 0.8 });
```

### Dither approach

Pre-generate a set of 4 "dither strip" RenderTextures (one per cardinal edge) using
`ImageData` pixel manipulation with the Bayer 4×4 matrix defined in `tile-blend-lab/index.ts`,
then `rt.stamp()` each strip at every seam tile with `tint` set to the neighbour's fallback colour.

## Observations

- Gradient blending looks best at `blendWidth` 6–12px — wide enough to read as a transition,
  narrow enough to preserve the tile's interior character.
- Dither blending is crisper and more pixel-art authentic; works well at 4–8px.
- Both modes degrade gracefully on solid-colour fallback tiles and on sprite tiles.
