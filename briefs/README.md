# Sprite Briefs

A **brief** is the small YAML file that fully describes one sprite the
generation pipeline (`npm run sprites:run`) should make. Briefs are the
reviewable, version-controlled contract between an author (human or AI) and
the pipeline; everything downstream — prompt construction, provider call,
slicing, post-processing, sensor scoring, selection — is determined by the
brief.

## Minimal shape

Authors only need three fields:

```yaml
type: weapon
name: skull-mace
description: |
  A grim one-handed mace held vertically, head at the top, haft straight
  down. ... (visual details that the model can act on)
```

| Field | What it does |
| --- | --- |
| `type` | One of `weapon`, `enemy`, `item`, `tile`, `vfx`, `character`. Picks the per-type defaults file at `data/sprite-types/<type>.json`. |
| `name` | Lowercase kebab-case. Becomes the brief id and the output folder name under `generated/`. |
| `description` | Free-form prose. Becomes the `## Subject` block in the prompt and is the primary signal the model gets about what to draw. |

Everything else — `size`, `palette`, `anchor`, `references`, sheet layout,
sensor thresholds, even `prompt` — comes from `data/sprite-types/<type>.json`
and can be overridden inline if a particular brief needs to.

## Where briefs live

```
briefs/
  weapons/
    iron-sword.yaml
    skull-mace.yaml
  enemies/
    ...
```

Subdirectories are informational; the loader doesn't care. `type:` is the
source of truth for which defaults file to merge.

## Per-type defaults

Defaults live in `data/sprite-types/<type>.json`. For weapons, that
currently means: 16×16 sprite, `kenney-roguelike` palette, anchor at
`(8, 14)`, two reference spritesheets, a 4×4 = 16-variant generation sheet
on a 1024² canvas, and `silhouette-orientation-axis = vertical` so the
in-game renderer can rotate weapons around a known axis.

The loader deep-merges minimal briefs on top of the defaults:

- Scalars and per-leaf object keys from the brief win over defaults.
- Arrays (`references`, `tags`) **replace** the defaults' arrays — they are
  never concatenated. If you set `references:` on a brief, you're declaring
  the complete list.

## When to override defaults

Override only when the sprite genuinely differs from the type's norm.
Examples:

- **`iron-sword.yaml`** overrides `sensors.weapon.orientation: diagonal`
  because a side-profile sword reads at ~45° rather than vertical.
- A larger boss enemy might override `size: { width: 32, height: 32 }`.
- A brief that wants only one specific reference image overrides
  `references: [{ path: ..., note: ... }]` (always at least 2).

If you find yourself overriding the same field on lots of briefs, that's
a signal to update the per-type default instead.

## What happens after `npm run sprites:run -- briefs/weapons/skull-mace.yaml`

1. Load + merge defaults → full validated brief.
2. Concatenate the global style guide (`docs/agent-os/sprite-style.md`)
   with `description` and sheet constraints → one prompt string.
3. Send to the configured image provider with the reference PNGs, get back
   a 4×4 sheet PNG.
4. Slice the sheet into 16 native-resolution variants.
5. Post-process each variant: background removal, palette quantisation,
   nearest-neighbor downscale to `size`.
6. Score each post-processed variant with the universal + type-specific
   sensors using the brief's thresholds.
7. Write everything to `generated/<name>/` — raw sheet, per-variant PNG,
   per-variant scorecard JSON, ranking manifest, and the chosen variant.

The pipeline only writes under `generated/` (gitignored). Promotion of
approved sprites into `public/assets/generated/` is a separate manual step
and out of scope here.

## Authoring tips

- **Lead with silhouette and orientation.** The model is much better at
  "vertical mace, skull on top, straight haft" than at "sinister
  bone-themed bludgeoning weapon."
- **Call out forbidden details explicitly.** "No glow, no chains, no
  blood" prunes whole branches of variants.
- **Don't list keywords.** Tags from the brief are intentionally not sent
  to the model — visual detail belongs in the description, in sentences.
- **Run, look at the chosen variant, iterate the description.** Briefs
  are cheap; expect to revise.
