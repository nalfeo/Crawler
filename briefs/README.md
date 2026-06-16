# Sprite Briefs

A **brief** is the small YAML file that fully describes one sprite the
generation pipeline (`npm run sprites:run`) should make. Briefs are the
reviewable, version-controlled contract between an author (human or AI) and
the pipeline; everything downstream — prompt construction, provider call,
slicing, post-processing, sensor scoring, selection — is determined by the
brief.

For cross-asset planning (for example, a full floor theme like "rat-themed
dungeon"), use art-plan files under `plans/floor-art/*.art.yaml` and run:

```bash
npm run sprites:asset-plan -- --plan plans/floor-art/rat-themed-dungeon-floor.art.yaml
```

The tracker reports per-asset lifecycle status (planned, brief-ready,
approved, integrated) and unresolved placeholders.

To turn missing art-plan entries into runnable draft briefs, run:

```bash
npm run sprites:plan-drafts -- --plan plans/floor-art/rat-themed-dungeon-floor.art.yaml
```

That command materializes draft briefs under `briefs/draft/` for assets still
in `needs-art-placeholder` or `planned` status. The intended multi-family flow
is:

1. `npm run sprites:asset-plan -- --plan <plan>` to see the gaps.
2. `npm run sprites:plan-drafts -- --plan <plan>` to emit draft briefs for
   enemies/mobs, items/props/decor, tiles, and VFX/flair.
3. `npm run sprites:run -- --brief <draft>` or `npm run sprites:batch -- --briefs-dir <draft-dir>`
   to generate candidates.
4. `npm run sprites:approve -- <runDir> --variant <n>` once a winner is chosen.

## Minimal shape

Authors only need three fields:

```yaml
type: weapon
name: skull-mace
description: |
  A grim one-handed mace held vertically, head at the top, haft straight
  down. ... (visual details that the model can act on)
```

| Field         | What it does                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `type`        | One of `weapon`, `enemy`, `item`, `tile`, `vfx`, `character`. Picks the per-type defaults file at `data/sprite-types/<type>.json`. |
| `name`        | Lowercase kebab-case. Becomes the brief id and the output folder name under `generated/`.                                          |
| `description` | Free-form prose. Becomes the `## Subject` block in the prompt and is the primary signal the model gets about what to draw.         |

Everything else — `size`, `palette`, `anchor`, `references`, sheet layout,
sensor thresholds, even `prompt` — comes from `data/sprite-types/<type>.json`
and can be overridden inline if a particular brief needs to.

## Where briefs live

Briefs flow through three stages:

```
generated/brief-candidates/<name>/    ← synth output (gitignored)
  <name>-v1.yaml
  <name>-v2.yaml
  <name>-v3.yaml
  synthesis.json

briefs/draft/<type>s/<name>.yaml      ← human picked one (gitignored)

briefs/<type>s/<name>.yaml            ← passes sensors, committed
```

1. **`npm run sprites:synth -- <name> --type <type>`** asks the model
   for N candidate minimal briefs and writes them under
   `generated/brief-candidates/<name>/` together with a `synthesis.json`
   sidecar (provider label, prompt hash, rationale per candidate). The
   directory is gitignored — these are throw-away artefacts.
2. The author reviews the candidates and moves the best one into
   `briefs/draft/<type>s/<name>.yaml`. The `briefs/draft/` directory is
   gitignored (see `briefs/draft/.gitignore`) so a half-formed brief
   doesn't get committed by mistake.
3. The author runs `npm run sprites:run -- --brief briefs/draft/<type>s/<name>.yaml`
   and iterates on the description until a variant passes the sensors.
4. Only then does the brief get moved to `briefs/<type>s/<name>.yaml`
   and committed.

```
briefs/
  weapons/
    iron-sword.yaml
    skull-mace.yaml
  enemies/
    ...
```

Subdirectories under `briefs/` are informational; the loader doesn't
care. `type:` is the source of truth for which defaults file to merge.
The repo uses these conventional family folders:

| Type        | Folder        |
| ----------- | ------------- |
| `weapon`    | `weapons/`    |
| `enemy`     | `enemies/`    |
| `item`      | `items/`      |
| `tile`      | `tiles/`      |
| `vfx`       | `vfx/`        |
| `character` | `characters/` |

## Per-type defaults

Defaults live in `data/sprite-types/<type>.json`. Weapons, enemies, items,
tiles, VFX, and characters now all ship with committed defaults so minimal
briefs are runnable across the same workflow. Those family defaults set size,
palette, anchor, references, sheet layout, and any family-specific
sensor/judge knobs.

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
- A larger boss enemy might override `size: { width: 96, height: 96 }`.
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
