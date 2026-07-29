# Crawler Sprite Style Guide

> Source of truth for the visual style of every sprite the generation pipeline produces. This file is loaded as plain text and concatenated into **every** prompt sent to the image provider as a hard preamble. It is how we keep the model grounded on the project's style — alongside the reference images attached to each request (see ADR `0003`, spec F2.3). Those references are now **our own highest-quality approved generated sprites**, selected at generate time by a deterministic same-`type`-favoring sampler (`scripts/sprites/reference-selector.ts`) — no longer Kenney placeholder spritesheets. They are the canonical style ground truth: the candidate should look like it belongs in the same shipped set. This preamble sets the hard constraints and visual richness level; the references show the exact look to match.

## The style in one paragraph

Crawler sprites turn a dark-fantasy dungeon into deranged reality-show spectacle: expressive offbeat characters, retro-futurist salvage and corporate decay, and brutal improvised machinery. Concepts combine one readable identity with one authored contradiction, becoming stranger, more grotesque, frightening, shocking, and wonderful on deeper floors without becoming less legible. Hard 1-pixel outlines, 3–5 color stops per material, readable texture, and bold color separation keep every single-subject silhouette clear at game scale.

## Hard constraints (these are non-negotiable)

The generator MUST follow every constraint below. Each is also enforced by a deterministic sensor downstream (see `scripts/sprites/sensors/`):

1. **Size:** the final sprite is exactly `[width, height]` from the brief — typically 64×64. The model is asked for 1024×1024; the post-processor nearest-neighbor resamples to the brief size.
2. **Palette:** use bold, distinct colors. The pipeline can optionally snap pixels to a locked project palette (controlled by `postprocessing.paletteMode` in the brief — default is `'none'`, meaning no snapping). Regardless of mode: no gradients, no airbrush blending. Bold color boundaries, not smooth transitions.
3. **Alpha:** every pixel is fully opaque (alpha 255) or fully transparent (alpha 0). No partial transparency, no anti-aliased fringes.
4. **Background:** transparent — or, if the model insists on solid, a flat high-contrast color that is visibly distinct from the sprite palette (for example bright magenta `#ff00ff`, electric cyan `#00ffff`, neon lime `#39ff14`, vivid yellow `#fff200`) and reachable from the frame corners so the post-processor can flood-fill it away. **Do not use black backgrounds.** No decorative backgrounds, no checkerboards, no gradients, no shadows under the subject.
5. **Composition:** a **single subject**, **centered**, **square aspect**, **fully inside the frame** with at least 1 pixel of breathing room on every side at the final output size (typically 64×64).
6. **No text of any kind.** No numbers, no digits, no labels, no captions, no signatures, no watermarks, no UI chrome. The pipeline rejects sheets where the model added a number on each cell — this happens often enough that it must be called out explicitly in the prompt.
7. **No multiple subjects per cell.** If the brief asks for a sword, the cell shows one sword — not "a sword on a shield" or "a sword next to a coin".
8. **No anti-aliasing.** Edges are hard. Color transitions are 1-pixel boundaries between palette entries.

## Bind every material to its ramp when `paletteMode: strict`

**Strict quantization does not tell the model which palette entry means which
material.** It only guarantees the shipped pixels are palette entries. If a palette
contains a small saturated warm accent (a badge, a gold ring, a lamp), the model will
reach for it whenever it wants "warm" or "bright" — and skin is the usual casualty.

This is not hypothetical: it fired on **both** Welcome Room NPCs, and the VLM judge
scored the broken art **5/5/5/5 both times**. The judge does not detect skin-hue
substitution, so no automated layer catches it — only the eyeball gate does.

| brief                | intended for the accent                   | what the model painted with it | measured                    |
| -------------------- | ----------------------------------------- | ------------------------------ | --------------------------- |
| `welcome-goon-v3`    | amber laminate badge `rgb(236,146,26)`    | the face                       | skin was hot orange         |
| `sweaty-merchant-v3` | gold ring + pouch clasp `rgb(198,150,44)` | the whole head                 | head 91% gold, 9% skin ramp |

Note the structural tell in the goon palette: the two **brightest** entries were both
amber accents, while the skin ramp topped out well below them. Asked for a bright warm
face, the nearest palette entry was the badge colour. A palette whose brightest entry
is an accent rather than skin is primed for this failure.

**The fix is prose, not a looser sensor.** Give every material an explicit ramp by RGB,
say what the accent is _and is not_ for, and add the failure as a hard negative:

```text
COLOUR ASSIGNMENT IS EXPLICIT. Quantization is strict, so every colour below is a
palette entry and each one belongs to ONE material. Do not borrow across materials:

- SKIN (face, neck, bare forearms, hands) uses the WARM TAN ramp ONLY:
  rgb(88,56,38) shadow, rgb(134,92,62) mid, rgb(180,136,98) light,
  rgb(220,180,140) highlight. It is NOT orange, NOT amber, NOT gold.
- AMBER rgb(236,146,26) is the LAMINATE BADGE ACCENT and NOTHING ELSE. It must
  NEVER appear on skin, hair or cloth. It is the brightest entry in the palette
  purely because a small badge needs to pop — brightness here does NOT mean
  "use this for the face".
- rgb(16,14,18) is the OUTLINE colour: a one-pixel contour, never a fill.

HARD NEGATIVES:
- Do NOT paint the face, neck, arms or hands orange, amber, gold or yellow.
  This is the single most common failure on this brief.
```

Verifying it is cheap and deterministic — count palette-exact pixels in the head region
rather than trusting the judge:

```text
head: gold=419 skinramp= 39   <- rejected
head: gold= 15 skinramp=350   <- correct
```

Also bind the near-black entry to **outline only**. The goon's lower body came back as a
749-pixel solid mass of `rgb(16,14,18)` because "dark legs" plus an available near-black
reads as permission to fill with it.

## Visual conventions

These are softer guidelines — the model should follow them, but downstream sensors don't enforce them. Reference images do most of the work here:

- **Outline:** one-pixel-wide dark outline on the silhouette. Pure black is fine; a near-black palette entry is preferred.
- **Shading:** 3–5 stops inside the silhouette — a base mid-tone, a shadow, a deep shadow, and optionally a highlight and a bright accent. Pixel dithering is allowed and encouraged for fabric, stone, and metal texture — use it to suggest material without relying on gradients. Avoid going below 3 stops per material; flat single-fill reads as unfinished.
- **Grungy character:** worn edges on metal, stitching on fabric, scuffs on boots. Equipment looks like it's been in a dungeon. Color choices should be bold and memorable, not drab. Allow pops of saturated color even in an otherwise earthy palette.
- **Silhouette first:** the shape should read clearly at 64×64 and remain legible when scaled down in-engine. Test mentally: "if I painted the whole sprite black, would I still know what it is?"
- **Orientation:** weapons stand **vertical** by default — held upright with the grip at the bottom and the business end at the top. This is what `data/sprite-types/weapon.json` sets, so the in-game renderer can rotate any weapon around a single known axis. Briefs that genuinely need a side-profile / diagonal shape (e.g. `iron-sword.yaml`) override with `sensors.weapon.orientation: diagonal`. Characters face the viewer. Items sit grounded as if on a surface.
- **Anchor pixel:** every brief declares an `anchor` (typically the grip on a weapon, the feet on a character, the base on an item). That pixel must be opaque in the final sprite — the engine uses it to attach effects, hands, etc.

## Sheet-mode layout

Default sheet-mode generation asks for a **4×4 grid of 16 distinct variants** on a 1024×1024 canvas (configurable per brief). 1024 ÷ 4 = 256, so every cell is a clean integer 256×256 source tile, and the post-processor nearest-neighbor resamples to the brief size (default 64×64). 16 variants per call gives the scoring loop plenty of headroom to reject low-quality candidates without paying for a second provider round-trip. Each variant occupies one cell. Constraints for the grid:

- Cells are equal-sized squares, arranged left-to-right, top-to-bottom.
- Each variant fits **fully** within its cell — no cropping, no overflow into the adjacent cell.
- Variants are **distinct**: different silhouette / proportions / hilt-shape / shading choices. Diversity is the entire point of sheet mode.
- All variants share the same orientation, same scale, same subject type. They are siblings, not "a sword, then a dagger, then an axe".
- The same background-color rules apply to the **whole sheet**: a flat neutral color the post-processor can flood-fill, or transparent. No per-cell borders, dividers, or labels.

## The prompt preamble

The preamble below is the authoritative structure that `scripts/sprites/build-prompt.ts` concatenates at the top of every prompt. At runtime, `{{CRAWLER_DESIGN_LANGUAGE}}` expands from `scripts/sprites/content-direction.ts`, the canonical shared design-language source. Keep it short — the model has a finite attention budget and the brief-specific subject description is what we want it to spend it on.

> --- STYLE PREAMBLE (do not deviate) ---
>
> You are generating pixel art for _Crawler_.
>
> {{CRAWLER_DESIGN_LANGUAGE}}
>
> Every output must follow these rules:
>
> 1. Hard 1-pixel outlines on silhouettes. No anti-aliasing. No partial transparency. Edges are crisp 1-pixel transitions between solid colors.
> 2. Use 3–5 distinct color stops per material — base mid-tone, shadow, deep shadow, optional highlight, optional accent. Keep readable contrast between stops (avoid clusters of near-identical mid-tones), but do not flatten materials to only 2 tones. Pixel dithering is allowed for fabric/stone/metal texture where it adds detail; avoid heavy checkerboard noise. No airbrush blending. **This rule governs WORLD art — props, weapons, equipment, items and tiles. Character and enemy figures are deliberately flatter and are governed by the Character/Mob rules block later in this prompt, which overrides this clause.**
> 3. **Grungy detail with readability first:** worn edges on weapons and armor, stitching lines on fabric, scuffs on boots, cracks in stone. Colors are bold and varied — not drab, not monochrome earthy. Include pops of saturated hue even in an otherwise earthy palette. **Grunge and texture apply to WORLD art only; figures use flat cel shading and carry wear as a few deliberate shapes, never as texture.**
> 4. **Scale granularity:** the full sheet is 1024×1024 with each cell rendered at 256×256 source pixels. The post-processor nearest-neighbor resamples to 64×64. This means **4 source pixels = 1 output pixel**. Draw using 4-pixel strokes for 1-pixel outlines, 8-pixel strokes for 2-pixel features. Every feature you intend to be visible must span at least 4–8 source pixels. Do not draw at an effective 16×16 resolution and scale it up.
> 5. **Single subject per cell**, fully inside its cell. Subject must not be clipped at any edge.
> 6. **Transparent or flat high-contrast background** that is clearly distinct from the sprite palette (prefer bright magenta `#ff00ff`, electric cyan `#00ffff`, neon lime `#39ff14`, or vivid yellow `#fff200`). Do not use black backgrounds. No decorative backgrounds, no shadows under the subject, no scene props.
> 7. **No text, numbers, digits, labels, captions, watermarks, signatures, or UI chrome** unless the brief explicitly identifies a sign or text-bearing object and makes lettering essential. Never invent incidental text.
> 8. Silhouette-first composition: the shape must read clearly even with all interior detail removed.
> 9. Reference images attached to this request are approved Crawler sprites. Match their outline weight, palette depth, scale, and production finish, but do not let references override the Crawler design language, requested subject, or floor context. **For character and enemy subjects, copy technique only — outline weight, palette discipline, crispness — and NOT figure proportions or rendering density; some references are older, more realistically-proportioned art the project is deliberately moving away from.**
>
> --- END STYLE PREAMBLE ---

## When to update this file

- A new asset family (enemies, tiles, VFX) needs conventions the weapon-focused MVP didn't cover → add a new H2 section, do not edit the existing weapon-tuned text in place. Sprites already approved against the old text must still pass the new sensors.
- A repeated failure mode shows up across briefs (e.g., model keeps adding swirly magic effects to weapons) → add a numbered prohibition to the prompt preamble.
- The palette is replaced or extended → update §"Hard constraints" item 2 and bump the ADR.

Avoid wordsmithing the preamble. Every additional sentence is a sentence the model has to track. Add only when a deterministic sensor downstream isn't enough and human review keeps flagging the same complaint.

## Synthesising briefs

Hand-authoring a brief for every weapon, enemy, or prop is tedious. The `sprites:synth` CLI turns a subject name into N reviewable minimal-brief candidates via a single Azure OpenAI structured-output call.

```pwsh
# Load Azure creds in the SAME powershell call (Windows workaround).
Get-Content ~\.copilot\session-state\<id>\files\azure-sprite-pipeline.env |
  ForEach-Object { if ($_ -match '^([^#=]+)=(.*)$') { Set-Item "Env:$($matches[1])" $matches[2] } };
npm run sprites:synth -- scythe --type weapon
```

Pick the **type** and **size** independently. Size variants scale the per-type
default dimensions, so a brief can be wider, taller, or bigger without restating
its geometry:

```pwsh
# A banner-style weapon: default height, twice as wide.
npm run sprites:synth -- battle-standard --type weapon --size wide
```

Use `--floor 1..20` to set the creative-intensity context. Omitted floors
default to Floor 1; generated briefs only write `floor:` when the value is above
the baseline.

GitHub `asset-request` issues expose the same variants through the optional
**Size** field. An explicit value always wins. When Size is omitted, canonical
boss requests (a terminal `-boss` asset name, or an explicitly enemy-typed brief
with a standalone boss/godfather cue) default to `large`; ordinary enemies and
all other assets remain `default`.

| `--size`  | Width | Height |
| --------- | ----- | ------ |
| `default` | 1×    | 1×     |
| `wide`    | 2×    | 1×     |
| `tall`    | 1×    | 2×     |
| `large`   | 2×    | 2×     |

What you get:

- `generated/brief-candidates/scythe/scythe-v{1,2,3}.yaml` — three minimal briefs with deliberately different silhouettes.
- `generated/brief-candidates/scythe/synthesis.json` — provider label, prompt hash, per-candidate rationale, raw model response (no API keys or endpoints).

### What the synthesiser does for you

- **Leaves references to generate time.** The synthesiser no longer picks reference images — briefs carry no `references`. At generate time, `scripts/sprites/reference-selector.ts` deterministically samples our own highest-quality approved sprites (favoring the brief's `type`) as the style anchors, and the chosen set is recorded in the run summary. Kenney spritesheets are fully retired as a reference source.
- **Refuses vague adjectives.** `cool / awesome / epic / amazing / nice` are rejected at validation time — every candidate must read as a concrete pose/silhouette/colour description.
- **Forces visibly distinct candidates.** The system prompt requires each candidate to differ in silhouette from the others (tall narrow vs short wide vs symmetrical, etc.). The CLI prints the rationale next to each candidate.
- **Classifies type when you omit `--type`.** Only auto-assigns if the model is ≥ 0.9 confident; otherwise it tells you to re-run with `--type`.
- **Sizes the sprite from `--size`.** A non-`default` size is written into the candidate YAML as `sizeVariant:` and the loader scales the per-type defaults (size, anchor, native canvas) before merging, so the prompt asks the model for the right proportion and the post-processor fits the subject without letterboxing. An explicit `size:`/`anchor:` in a brief still wins over the variant.

### What the synthesiser refuses to do

- Run in CI. Synthesis costs money and is non-deterministic; the CLI throws when `env.CI` is set to a truthy value. Treat it as a local-only tool.
- Silently rewrite a bad candidate. By default a single rejected candidate aborts the whole run with no files written. Pass `--allow-partial` to keep the valid ones.
- Write into `briefs/`. Output goes to `generated/brief-candidates/` only; promotion is a manual `mv` (see lifecycle below).

### Promotion lifecycle

The synthesised file is **not** a committed brief. The lifecycle is:

```
generated/brief-candidates/<name>/<name>-vN.yaml   (synth output, gitignored)
                ↓ human picks the best
briefs/draft/<type>s/<name>.yaml                   (review-staged, gitignored)
                ↓ npm run sprites:run iterates until a variant passes sensors
briefs/<type>s/<name>.yaml                         (committed)
```

`briefs/draft/.gitignore` enforces that drafts never get committed by mistake. Only briefs that have actually produced a passing sprite belong in version control.

### Cost discipline

One CLI invocation = one provider call (the structured-output schema returns all N candidates in one response). Repeated iteration on the same subject costs one call per `sprites:synth` you fire, not one per candidate. If you want a fourth candidate after the fact, re-run the command rather than editing the YAML manually.

## Writing prompts for Azure OpenAI chat

This applies to **every** chat-completions prompt in the repo (synth, variations expander, future judge rubric — anything routed through `azure-chat.ts` or `azure-chat-synth.ts`). The image-edits API runs a different filter stack and is more permissive, so prompts that work there will not necessarily work in chat.

Azure OpenAI's `jailbreak` content classifier inspects the **shape** of the prompt, not just the subject. It will return `400 ResponsibleAIPolicyViolation` with `jailbreak: detected: true` even on a totally innocuous subject (a `cauldron`, a `lantern`) if the surrounding instruction text looks like a jailbreak attempt to the classifier. Surfaced first in PR #50 — first cut of the synth system prompt got 400'd on every call until rewritten.

Things the classifier reacts to (avoid):

- **All-caps imperatives**: `HARD RULES`, `MUST`, `NEVER`, `DO NOT`, `FORBIDDEN`.
- **Numbered "you must" lists** with quoted banned tokens (`"cool", "awesome", "epic"` etc. as a literal forbidden-words list).
- **Adversarial framing**: "any violation rejects the candidate", "ignore previous instructions", "you are not allowed to".
- **Role-override boilerplate**: "you are X and only X", aggressive persona pinning.

What works (same semantic content, different shape):

- **Conversational role framing**: "You are an art director writing concept briefs…", "You are a reviewer scoring…". Treat the model as a collaborator, not a constrained subordinate.
- **Goal-oriented guidance**: describe what a _good_ output looks like ("a good brief is concrete; it names the pose, the silhouette…"). The model infers the inverse without you having to enumerate banned tokens.
- **Lower-case "should" / "avoid"** in place of `MUST` / `NEVER`. The semantics are identical to the model but invisible to the filter.
- **Push enforcement downstream**: document banned tokens in the **validator code** (`BANNED_ADJECTIVES` in `synthesize-brief.ts`), not in the prompt. The prompt nudges the model toward concrete language; the validator catches anything that slips through. This is also more robust — the model occasionally ignores prompt rules even when they aren't filter-tripping.

If you do need to send a quoted banned-word list to the model (rare; usually the validator-side approach is enough), prefer paraphrase: `"prefer concrete language over generic adjectives"` over `"never use cool, awesome, epic, amazing, or nice"`.

Verify any non-trivial prompt change with a **real round-trip** against the deployment — unit tests with a mocked provider will not catch filter trips. The synth integration test uses a stub provider precisely because the real call is content-filter-sensitive and we do not want CI to depend on Azure availability or classifier stability.

## VLM judge (spec §F4, local-only)

After the deterministic sensors (palette/silhouette/edges/bbox) pass, an **optional** VLM judge can score each sensor-passing variant on four axes that pixel-level sensors can't measure:

1. **`design_language`** (1–5) — does the concept feel specifically like Crawler, with one readable identity and one authored contradiction at the requested floor intensity?
2. **`reference_style_match`** (1–5) — does the rendering read as same-family with approved same-`type` reference sprites?
3. **`brief_match`** (1–5) — does the variant depict what the brief asks for, including orientation and animate/inanimate category?
4. **`readability`** (1–5) — at 1× over a dark floor tile, is the subject still legible?

Any score `< 3` on **any** evaluator auto-rejects the variant (`combinedPassed = false`). Within the passing set, the chosen variant is the one with the highest minimum judge score; sensor score breaks ties.

### Enabling the judge on a brief

Default is **off** on every sprite type. To opt in, add to the brief (or to `data/sprite-types/<type>.json` to default for all of that type):

```yaml
judge:
  enabled: true
  maxVariants: 16 # optional; caps how many sensor-passing variants get judged per run
```

When enabled, `generate-one` issues **one** vision call per judged variant — all four evaluators in a single structured-JSON response, by design (cost discipline). Each call hits the deployment in `AZURE_OPENAI_VISION_DEPLOYMENT` from `.env`.

> **Env alias.** Synth and variation expansion read `AZURE_OPENAI_CHAT_DEPLOYMENT`, but the provider factory falls back to `AZURE_OPENAI_VISION_DEPLOYMENT` (with a one-shot warning) when the chat var is missing. The deployments we provision today are the same gpt-4o-class model serving both endpoints, so this fallback is safe. To silence the warning, mirror your vision deployment value into `AZURE_OPENAI_CHAT_DEPLOYMENT` in the env file.

Per-variant cost on `gpt-4o`-class vision deployments is dominated by the candidate + 2–3 reference images (~1.5–2K prompt tokens) plus a small JSON completion (~80–150 completion tokens). With `maxVariants: 16` and a 4×4 grid that's at most 16 vision calls per `generate-one` invocation.

### Why this is **never** in CI

Per Constitutional §3, `judge.ts` refuses to run when `process.env.CI` is set — costs Azure credits and the model is non-deterministic so test results would flap. The refusal cites §3 and requires an ADR to bypass. The judge is for **local** unattended batch runs (where the alternative is the author eyeballing every variant).

## Reviewing runs in the sprite gallery (spec §F7–F9)

Unattended batch runs produce hundreds of candidates across briefs. The
gallery lab is the read-only review surface so you can scan them
without opening each PNG individually.

```pwsh
# Always refresh Azure env in this worktree first (uses az + writes .env.local).
npm run setup:azure

# Then start the sidecar + Vite lab server. Ctrl-C stops both.
npm run sprites:gallery
```

Then open `http://localhost:3000/lab.html?lab=sprite-gallery`. (The
sidecar binds 127.0.0.1 only - it is never reachable from the LAN.)

> Policy: sidecar launches are Azure-first by default (`azure-blob` + `azure-queue`).
> Do not switch to `SPRITES_RUN_STORE=local SPRITES_ASSET_QUEUE=noop` unless a human
> explicitly requests local/offline mode.

What the gallery shows, per candidate:

- Native-size sprite (typically 64x64) previewed with pixelated upscaling
- The per-variant **anchor overlay** composited on top (toggle in the
  toolbar). Every variant emits `processed/NN.anchor-overlay.png` next
  to the sprite - a fully transparent PNG with one opaque red pixel at
  the derived anchor. When derivation failed the overlay is fully
  transparent so the gallery still has a file to fetch.
- A colour-coded **sensor** pass/fail badge.
- A colour-coded **judge** pass/fail badge with the lowest of
  `style_match` / `brief_match` / `readability` when the brief opts in.
- The **chosen** variant has a yellow border + badge.

Clicking a tile loads the full per-candidate JSON (sensor scorecard,
judge breakdown, derived anchor) into the side panel as a collapsible
tree. Arrow keys nav: left/right between candidates within a brief,
up/down between briefs.

This PR is strictly **read-only** - no approve / promote / re-roll
buttons. Mutation flows ship in a follow-up per spec §F9.

If the sidecar is not running (`/api/health` unreachable) the lab
still renders and shows a fallback banner that explains how to start
it. This is the "review-only mode" requirement from spec §F9; the lab
must never hard-fail when the sidecar is down.

---

## Judge cost knobs (Phase 3)

The VLM judge is the most expensive single call in the pipeline. Two
mechanisms keep cost predictable across batch runs:

### Budget ceiling — `JudgeBudget`

A USD cap on judge spend that **persists across CLI invocations** via
`generated/.cost-state.json`. Once spend would push past the cap, the
remaining variants in the run are not judged (ranking falls back to
sensors-only) and the next CLI invocation honours the same persisted
spend.

- `--judge-budget-usd <n>` — per-batch cap. Default is `Infinity` for
  single-brief `sprites:run` so existing behaviour is preserved. The
  batch CLI (Phase 3 build 6) passes a concrete cap.
- `SPRITES_JUDGE_BUDGET_USD` — env fallback used when the flag is not
  provided. Useful for CI.
- `--reset-budget` — wipes the persisted state file before the run, so
  the new cap starts from zero spend.

The pricing table lives in `scripts/sprites/cost-tracker.ts`
(`PRICING`). Update it when Azure publishes new rates or when you add
a new deployment. The `resolveRates` lookup is substring-based against
the deployment name and falls back to a conservative high-rate row if
the deployment is unknown, so a misconfigured name fails _closed_
(under-judges) rather than over-spends.

### Vision-call cache — `JudgeCache`

A filesystem cache at `generated/.judge-cache/` keyed by:

```
sha256(modelDeployment | promptTemplateVersion | variantPNGBytes
     | referencePNGsBytes | briefMatchInstructions)
```

On hit the Azure call is skipped entirely and the cached scorecard is
replayed. On miss the call runs and the result is stored. The cache
contains **only `JudgeScorecard` JSON** — never images. Caching
generated images would cache luck, not quality.

- `--no-judge-cache` — disable for one run (e.g. after editing the
  rubric/`PROMPT_TEMPLATE_VERSION` bump is preferred, but this is the
  manual override).
- `--prune-judge-cache <hours>` — housekeeping: drop entries older
  than N hours.
- `--cache-max-entries <n>` — LRU cap. Default 1000. Eviction is by
  file mtime so reads on a hit refresh the entry.

Cache lookup is guarded by `judge.enabled` — a brief with the judge
turned off does not even compute the key, let alone touch the cache.

Both modules are pure-ish (filesystem ops at the edges, no network)
and unit-testable without mocking Azure.

## Batch runs (Phase 3 build 6)

A single command — `npm run sprites:batch` — walks a directory of brief
YAMLs, runs each through the same `generateOne` pipeline as
`sprites:run`, and threads ONE `JudgeBudget` + ONE `JudgeCache` across
every brief. Without this layer the cost ceiling is a per-process
formality; here it actually stops new work from starting.

### Flags

- `--brief <path>` (repeatable) — explicit brief YAML files.
- `--briefs-dir <dir>` — glob `**/*.yaml` under `<dir>`. Combinable with
  `--brief`. Duplicates de-duplicated.
- `--judge-budget-usd <n>` — REQUIRED unless `--no-budget` (or the
  `SPRITES_JUDGE_BUDGET_USD` env). The batch CLI exists because of the
  cap; refusing to start without one is intentional.
- `--no-budget` — explicit opt-out (dry runs, tests).
- `--reset-budget` — wipe `generated/.cost-state.json` before starting.
- `--no-judge-cache` — disable vision cache for the run.
- `--cache-max-entries <n>` — LRU cap (default 1000).
- `--prune-judge-cache <hours>` — drop entries older than N hours
  before starting.
- `--concurrency <n>` — accepted but only `1` is currently honoured.
  Sequential keeps Azure rate-limit + budget accounting deterministic.
- `--dry-run` — list briefs + projected cost without issuing any Azure
  calls. Cost projection uses `gpt-4o` rates × ~1580 tokens × 4
  variants × N briefs (rough; cache hits in a real run will be lower).

### Behaviour

1. **Pre-flight budget gate, per brief.** Before each brief we call
   `judgeBudget.wouldExceed()`. If true, the brief is marked
   `skipped-over-budget`, `generateOne` is NOT invoked, and the loop
   continues. The ceiling stops new work; it doesn't kill a brief
   already in flight.
2. **One bad brief never kills the batch.** Per-brief errors are
   caught, captured in `BatchBriefResult.error`, logged, and the loop
   continues.
3. **Incremental persistence.** After every brief (success, failure, or
   skip) the batch rewrites `batch-summary.json` with the partial
   results. Ctrl-C mid-batch leaves a valid summary on disk.

### Output

Per-brief artifacts go to the usual
`generated/runs/<brief-id>/<timestamp-id>/...`. The batch adds one
file: `generated/runs/_batch/<batch-id>/batch-summary.json`, the
gallery's input contract. Schema:

```jsonc
{
  "batchId": "2026-06-07T22-30-12-000Z-abc123",
  "startedAt": "2026-06-07T22:30:12.000Z",
  "finishedAt": "2026-06-07T22:34:01.000Z", // null while in flight
  "briefs": [
    {
      "briefPath": "briefs/weapons/iron-sword.yaml",
      "briefId": "iron-sword",
      "status": "succeeded", // or "failed" | "skipped-over-budget"
      "runDir": "/abs/.../generated/runs/iron-sword/2026-06-07T22-30-12Z-abc",
      "summary": {
        /* the per-run RunSummary, same shape as run-summary.json */
      },
      "elapsedMs": 8245,
    },
    {
      "briefPath": "briefs/weapons/bronze-axe.yaml",
      "briefId": "bronze-axe",
      "status": "skipped-over-budget",
      "runDir": "",
      "elapsedMs": 0,
    },
  ],
  "judgeBudget": {
    "budgetUsd": 0.05,
    "spentUsd": 0.0182,
    "remainingUsd": 0.0318,
    "callsThisRun": 4,
    "callsSkipped": 0,
  },
  "judgeCache": { "hits": 0, "misses": 4, "bypassed": 0 },
  "totals": {
    "briefsAttempted": 3,
    "briefsSucceeded": 1,
    "briefsFailed": 0,
    "briefsSkippedOverBudget": 2,
    "variantsJudged": 4,
    "variantsSkipped": 0,
  },
}
```

### Exit codes

- `0` — batch completed. Skipped-over-budget briefs are by-design and
  do NOT fail the run.
- `1` — runtime failure: at least one brief threw (status `failed`),
  or provider creation failed before the batch could start.
- `2` — configuration/usage error: invalid CLI args, brief resolution
  failed (no briefs matched, glob error), or budget wiring rejected
  (e.g. missing `--judge-budget-usd` and `SPRITES_JUDGE_BUDGET_USD`
  without `--no-budget`).

### Known interaction: cache bypasses per-variant budget gate

When a `JudgeCache` is supplied, `generateOne` skips the per-variant
`wouldExceed()` check inside the run (`scripts/sprites/generate-one.ts`
~L305). Rationale: cache hits don't bill, and we can't tell hit-vs-miss
without trying the lookup. Net effect for the batch: a brief that
starts under-budget runs all its variants even if mid-brief spending
crosses the cap; the BATCH gate then stops the NEXT brief. If you
want hard per-variant cutoff, disable the cache with `--no-judge-cache`.
