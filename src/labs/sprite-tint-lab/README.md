# Sprite Tint Lab (`?lab=sprite-tint-lab`)

A Canvas 2D sandbox for investigating how to reuse a single approved sprite frame
to produce multiple visual variants through tinting and colour manipulation.

## Why This Matters

Custom pixel-art sprites are expensive to author. Tinting lets us derive dozens of
variants from a single approved frame:

- Slime colour variants (green, red, blue, black)
- Status effects (poison glow, freeze, burn, curse)
- Rarity tiers (common grey → uncommon green → rare blue → epic purple → legendary gold)
- Faction-specific colour coding

## Techniques

| Technique        | Canvas 2D approach                                       | Phaser 4 equivalent                                          | Cost              |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------ | ----------------- |
| **Original**     | Baseline `drawImage`                                     | `sprite` as-is                                               | Free              |
| **Hue Rotate**   | `ctx.filter = "hue-rotate(Xdeg)"`                        | PostFX pipeline with hue-rotation uniform                    | Very cheap        |
| **Multiply**     | Sprite + overlay fillRect with `"multiply"` composite op | `sprite.setTint(color)` — Phaser uses multiply tint natively | Free (GPU vertex) |
| **Screen**       | Sprite + overlay fillRect with `"screen"` composite op   | Custom PipelinePlugin or Blend Mode                          | Cheap             |
| **Colorize**     | `ctx.filter = "hue-rotate(X) saturate(Y)"`               | PostFX hue+saturation uniforms                               | Very cheap        |
| **Palette Swap** | `ImageData` per-pixel remapping                          | Pre-bake with `textures.createCanvas()` at floor load        | Bake-time only    |

## Controls

| Control             | Description                                         |
| ------------------- | --------------------------------------------------- |
| Sprite              | Pick any registered sprite from the engine registry |
| Scale               | Zoom factor (2–16×)                                 |
| Tint Colour         | Colour used for Multiply and Screen techniques      |
| Hue Shift           | Degrees used for Hue Rotate and Colorize            |
| Saturation ×        | Saturation multiplier for Colorize                  |
| Palette Swap Target | Target hue for palette swap blending                |

Quick Preset buttons configure good starting values for common use cases:
**Poison**, **Fire**, **Ice**, **Cursed**, **Gold**.

## Porting to Phaser 4

### Multiply tint (cheapest)

```ts
sprite.setTint(0x22c55e); // green tint
// Or clear:
sprite.clearTint();
```

Phaser multiplies the tint colour with each vertex colour before fragment shading.
Zero draw-call overhead.

### Hue rotation (PostFX)

```ts
const pipeline = scene.renderer.pipelines.get('HuePipeline') as HuePipeline;
sprite.setPipeline(pipeline);
(sprite.pipeline as HuePipeline).setHue(150); // degrees
```

Requires authoring a custom PostFX pipeline with a `uHue` uniform. One-time setup.

### Palette swap (bake at floor load)

```ts
const textureKey = `slime-poison`;
const canvas = scene.textures.createCanvas(textureKey, 16, 16);
const ctx = canvas.getContext('2d');
// draw original frame, then do ImageData remap loop (see lab source)
canvas.refresh();
const poisonSprite = scene.add.image(x, y, textureKey);
```

The baked texture is a permanent GPU texture — zero per-frame cost.

## Observations

- **Multiply tint** is the pragmatic default for status effects. It's native to Phaser 4,
  zero cost, and reads clearly. Recommended for 90% of cases.
- **Hue rotate** is excellent for enemy colour variants. A slime at hue+120° reads
  as "different species" immediately.
- **Palette swap** gives pixel-accurate results. Useful when you need exact colours
  (faction flags, rarity indicators) and can afford the bake at level load.
- **Screen** is underused for "glow" effects (fire, lightning, blessed) — worth
  considering alongside multiply.
- Combining techniques (e.g., hue-rotate + multiply tint) is valid in Phaser 4:
  set a pipeline for hue and `setTint` for the additional colour modulation.
