# Crawler Sprite Style Guide

> Source of truth for the visual style of every sprite the generation pipeline produces. This file is loaded as plain text and concatenated into **every** prompt sent to the image provider as a hard preamble. It is how we keep the model grounded on the project's style — alongside the mandatory ≥2 reference images per brief (see ADR `0003`, spec F2.3). Reference images do ~90% of the style fidelity work; this preamble pins the remaining hard constraints so the model cannot drift into "generic AI pixel art".

## The style in one paragraph

Crawler sprites are **16×16 pixel art** in the Kenney roguelike tradition — solid filled shapes with a 1-pixel dark outline on the silhouette, two-stop shading inside (a base mid-tone plus a darker shadow on the lower / right side), no anti-aliasing, no decorative noise. The whole frame must read as a **single subject** centered on a transparent background, square, with no decorative borders. Silhouettes-first: if the shape doesn't read at 1× over a dark floor tile, the sprite is wrong regardless of how nice the interior detail looks.

## Hard constraints (these are non-negotiable)

The generator MUST follow every constraint below. Each is also enforced by a deterministic sensor downstream (see `scripts/sprites/sensors/`):

1. **Size:** the final sprite is exactly `[width, height]` from the brief — typically 16×16. The model is asked for 1024×1024; the post-processor does the nearest-neighbor downscale.
2. **Palette:** every opaque pixel must snap to an exact entry in `data/palettes/kenney-roguelike.json` (the locked Kenney roguelike palette). No off-palette colors. No gradients. No hue shifts the palette doesn't already contain.
3. **Alpha:** every pixel is fully opaque (alpha 255) or fully transparent (alpha 0). No partial transparency, no anti-aliased fringes.
4. **Background:** transparent — or, if the model insists on solid, a flat neutral color (pure white, pure black, or pure magenta `#ff00ff`) reachable from the frame corners so the post-processor can flood-fill it away. No decorative backgrounds, no checkerboards, no gradients, no shadows under the subject.
5. **Composition:** a **single subject**, **centered**, **square aspect**, **fully inside the frame** with at least 1 pixel of breathing room on every side at the final 16×16 size.
6. **No text of any kind.** No numbers, no digits, no labels, no captions, no signatures, no watermarks, no UI chrome. The pipeline rejects sheets where the model added a number on each cell — this happens often enough that it must be called out explicitly in the prompt.
7. **No multiple subjects per cell.** If the brief asks for a sword, the cell shows one sword — not "a sword on a shield" or "a sword next to a coin".
8. **No anti-aliasing.** Edges are hard. Color transitions are 1-pixel boundaries between palette entries.

## Visual conventions

These are softer guidelines — the model should follow them, but downstream sensors don't enforce them. Reference images do most of the work here:

- **Outline:** one-pixel-wide dark outline on the silhouette. Pure black is fine; a near-black palette entry is preferred.
- **Shading:** two stops inside the silhouette — a base mid-tone covering most of the shape, plus a darker shadow stop on the lower-right side. Highlights, if any, are 1-pixel pops in the upper-left. Avoid more than three stops total per material — Kenney sprites are deliberately flat.
- **Silhouette first:** the shape should read clearly at 16×16 even with all interior detail removed. Test mentally: "if I painted the whole sprite black, would I still know what it is?"
- **Orientation:** weapons stand **vertical** by default — held upright with the grip at the bottom and the business end at the top. This is what `data/sprite-types/weapon.json` sets, so the in-game renderer can rotate any weapon around a single known axis. Briefs that genuinely need a side-profile / diagonal shape (e.g. `iron-sword.yaml`) override with `sensors.weapon.orientation: diagonal`. Characters face the viewer. Items sit grounded as if on a surface.
- **Anchor pixel:** every brief declares an `anchor` (typically the grip on a weapon, the feet on a character, the base on an item). That pixel must be opaque in the final 16×16 sprite — the engine uses it to attach effects, hands, etc.

## Sheet-mode layout

Default sheet-mode generation asks for a **4×4 grid of 16 distinct variants** on a 1024×1024 canvas (configurable per brief). 1024 ÷ 4 = 256, so every cell is a clean integer 256×256 — the post-processor nearest-neighbor downscales by ×16 / ×8 / ×4 to 16×16, 32×32, or 64×64 with no resampling artefacts. 16 variants per call gives the scoring loop plenty of headroom to reject low-quality candidates without paying for a second provider round-trip. Each variant occupies one cell. Constraints for the grid:

- Cells are equal-sized squares, arranged left-to-right, top-to-bottom.
- Each variant fits **fully** within its cell — no cropping, no overflow into the adjacent cell.
- Variants are **distinct**: different silhouette / proportions / hilt-shape / shading choices. Diversity is the entire point of sheet mode.
- All variants share the same orientation, same scale, same subject type. They are siblings, not "a sword, then a dagger, then an axe".
- The same background-color rules apply to the **whole sheet**: a flat neutral color the post-processor can flood-fill, or transparent. No per-cell borders, dividers, or labels.

## The prompt preamble

The exact text below is what `scripts/sprites/build-prompt.ts` concatenates at the top of every prompt. Editing this section is the supported way to change generator behavior across all briefs at once. Keep it short — the model has a finite attention budget and the brief-specific subject description is what we want it to spend it on.

> --- STYLE PREAMBLE (do not deviate) ---
>
> You are generating pixel art in the **Kenney roguelike** style for the game _Crawler_. Every output must follow these rules without exception:
>
> 1. Hard 1-pixel outlines. No anti-aliasing. No partial transparency. Edges are crisp 1-pixel transitions between solid colors.
> 2. Limited palette: flat fill colors only, no gradients. The downstream pipeline will snap every pixel to a fixed 70-color palette, so subtle hue variation will be lost — use bold, distinct colors.
> 3. Two-stop shading inside each shape: a base mid-tone plus a darker shadow on the lower-right side. Optional 1-pixel highlight in the upper-left. No more than three color stops per material.
> 4. **Single subject, centered, square**, fully inside its cell with at least 10% margin on every side.
> 5. **Transparent or flat neutral background** (pure white, pure black, or pure magenta). No decorative backgrounds, no shadows under the subject, no scene props.
> 6. **No text, numbers, digits, labels, captions, watermarks, signatures, or UI chrome anywhere in the image.** This is the single most common failure mode and it makes the output unusable.
> 7. Silhouette-first composition: the shape must read clearly even with all interior detail removed.
> 8. Match the visual weight, outline thickness, and color saturation of the reference images attached to this request. The references are the ground truth for style — when in doubt, copy them.
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

What you get:

- `generated/brief-candidates/scythe/scythe-v{1,2,3}.yaml` — three minimal briefs with deliberately different silhouettes.
- `generated/brief-candidates/scythe/synthesis.json` — provider label, prompt hash, per-candidate rationale, raw model response (no API keys or endpoints).

### What the synthesiser does for you

- **Picks references from an allow-list.** The model is shown the list of `public/assets/kenney/*/spritesheet.png` files discovered on disk and picks 2–3 ids per candidate. It never invents reference paths.
- **Refuses vague adjectives.** `cool / awesome / epic / amazing / nice` are rejected at validation time — every candidate must read as a concrete pose/silhouette/colour description.
- **Forces visibly distinct candidates.** The system prompt requires each candidate to differ in silhouette from the others (tall narrow vs short wide vs symmetrical, etc.). The CLI prints the rationale next to each candidate.
- **Classifies type when you omit `--type`.** Only auto-assigns if the model is ≥ 0.9 confident; otherwise it tells you to re-run with `--type`.

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

After the deterministic sensors (palette/silhouette/edges/bbox) pass, an **optional** VLM judge can score each sensor-passing variant on three axes that pixel-level sensors can't measure:

1. **`style_match`** (1–5) — does the variant read as same-family with the brief's reference PNGs? Catches "technically on-palette but the wrong silhouette language".
2. **`brief_match`** (1–5) — does the variant depict what the brief's `prompt` asks for? Catches "valid sword sprite, wrong sword".
3. **`readability`** (1–5) — at 1× over a dark floor tile, is the subject still legible? Catches subjects that disappear into the background or read as noise once downscaled.

Any score `< 3` on **any** evaluator auto-rejects the variant (`combinedPassed = false`). Within the passing set, the chosen variant is the one with the highest minimum judge score; sensor score breaks ties.

### Enabling the judge on a brief

Default is **off** on every sprite type. To opt in, add to the brief (or to `data/sprite-types/<type>.json` to default for all of that type):

```yaml
judge:
  enabled: true
  maxVariants: 16 # optional; caps how many sensor-passing variants get judged per run
```

When enabled, `generate-one` issues **one** vision call per judged variant — all three evaluators in a single structured-JSON response, by design (cost discipline). Each call hits the deployment in `AZURE_OPENAI_VISION_DEPLOYMENT` from `.env`.

Per-variant cost on `gpt-4o`-class vision deployments is dominated by the candidate + 2–3 reference images (~1.5–2K prompt tokens) plus a small JSON completion (~80–150 completion tokens). With `maxVariants: 16` and a 4×4 grid that's at most 16 vision calls per `generate-one` invocation.

### Why this is **never** in CI

Per Constitutional §3, `judge.ts` refuses to run when `process.env.CI` is set — costs Azure credits and the model is non-deterministic so test results would flap. The refusal cites §3 and requires an ADR to bypass. The judge is for **local** unattended batch runs (where the alternative is the author eyeballing every variant).

Hand-authoring a brief for every weapon, enemy, or prop is tedious. The `sprites:synth` CLI turns a subject name into N reviewable minimal-brief candidates via a single Azure OpenAI structured-output call.

```pwsh
# Load Azure creds in the SAME powershell call (Windows workaround).
Get-Content ~\.copilot\session-state\<id>\files\azure-sprite-pipeline.env |
  ForEach-Object { if ($_ -match '^([^#=]+)=(.*)$') { Set-Item "Env:$($matches[1])" $matches[2] } };
npm run sprites:synth -- scythe --type weapon
```

What you get:

- `generated/brief-candidates/scythe/scythe-v{1,2,3}.yaml` — three minimal briefs with deliberately different silhouettes.
- `generated/brief-candidates/scythe/synthesis.json` — provider label, prompt hash, per-candidate rationale, raw model response (no API keys or endpoints).

### What the synthesiser does for you

- **Picks references from an allow-list.** The model is shown the list of `public/assets/kenney/*/spritesheet.png` files discovered on disk and picks 2–3 ids per candidate. It never invents reference paths.
- **Refuses vague adjectives.** `cool / awesome / epic / amazing / nice` are rejected at validation time — every candidate must read as a concrete pose/silhouette/colour description.
- **Forces visibly distinct candidates.** The system prompt requires each candidate to differ in silhouette from the others (tall narrow vs short wide vs symmetrical, etc.). The CLI prints the rationale next to each candidate.
- **Classifies type when you omit `--type`.** Only auto-assigns if the model is ≥ 0.9 confident; otherwise it tells you to re-run with `--type`.

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
- `1` — at least one brief threw (status `failed`), CLI args invalid,
  or budget wiring rejected.

### Known interaction: cache bypasses per-variant budget gate

When a `JudgeCache` is supplied, `generateOne` skips the per-variant
`wouldExceed()` check inside the run (`scripts/sprites/generate-one.ts`
~L305). Rationale: cache hits don't bill, and we can't tell hit-vs-miss
without trying the lookup. Net effect for the batch: a brief that
starts under-budget runs all its variants even if mid-brief spending
crosses the cap; the BATCH gate then stops the NEXT brief. If you
want hard per-variant cutoff, disable the cache with `--no-judge-cache`.
