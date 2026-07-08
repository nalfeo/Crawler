# Spec: Sprite Generation Pipeline

> **Canonical home:** this spec is the living current-state contract for the
> sprite pipeline and sidecar workflow. The numbered sprite ADRs are amendment
> history and rationale, not the primary source of present behavior.

## Context

Crawler currently sources all sprites from third-party CC0 packs (Kenney roguelike, tiny-dungeon, tiny-town, etc.). This is fine for a prototype but caps the project at the union of what those packs already provide. As we add weapons, items, enemies, and biome variants, we will repeatedly need on-style sprites that don't exist in any pack.

This spec defines an **automated pipeline** for generating new pixel-art assets in the project's chosen style, with a layered guardrail system: cheap deterministic **sensors** that block obviously-broken output, and subjective **evaluators** (LLM/VLM judges) that score style fit, brief adherence, and readability. Humans approve the winners through a dedicated lab. The pipeline is asset-type-agnostic by design, but the **MVP targets weapons** (16x16, single-frame) because that is the highest-value, lowest-complexity slice.

The pipeline must respect Crawler's constitution: deterministic CI gates only, lab-gated development, ADR-on-touch for cross-system changes, and "LLMs for creative pursuits only — enforcement is deterministic."

## Requirements

### Functional

#### F1. Brief-driven generation

A YAML brief in `briefs/<type>/<name>.yaml` is the only input needed to run the full pipeline. Briefs declare:

- `type` — asset family (`weapon`, `item`, `enemy`, `tile`); selects which sensors apply
- `name` — stable id, becomes the registry key on approval
- `size` — `[width, height]` in pixels (final, post-quantize)
- `palette` — name of a palette JSON in `data/palettes/`
- `anchor` — `{x, y}` pixel that must be opaque (e.g. weapon grip, character feet)
- `tags` — free-form, used for sibling lookup in the lab
- `prompt` — natural language description fed to the generator
- `references` — optional list of registry sprite ids to embed as visual references in the gen call

**Size variants (minimal-brief directive).** Type and size are chosen independently. A
minimal brief (or the `sprites:synth --size` flag) may set an optional
`sizeVariant` of `default` / `wide` / `tall` / `large`, which scales the per-type
default `size`, `anchor`, and sheet `nativeCanvas` (by `width` ×{1,2,1,2},
`height` ×{1,1,2,2}) at load time — before the author's explicit fields merge on
top, so a pinned `size`/`anchor` still wins. The directive is consumed and
stripped during the merge, so the strict `briefSchema` never sees it; the prompt
builder reports the resulting aspect ratio so non-square subjects are drawn to
proportion rather than letterboxed.

#### F2. Generator

**F2.1 Provider abstraction.** Generator is a strategy interface `ImageProvider` with two implementations: `OpenAIImageProvider` (default, `gpt-image-1`) and `MAIImageProvider` (`MAI-Image-2.5`, behind a feature flag). Selection via `SPRITE_GEN_PROVIDER=openai|mai` env var. Both use the OpenAI-compatible REST surface — the only differences are endpoint, deployment name, and credentials. This insulates downstream stages from provider churn.

**F2.2 Sheet-mode generation (default).** Instead of many single-image API calls, the generator requests **one 1024×1024 PNG containing a grid of distinct candidates** (current default: 4×4 = 16 variants via sprite-type generation settings). For higher diversity, the orchestrator may issue multiple sheet requests with varied per-cell hints.

**F2.3 Prompt template.** The request prompt is composed from:

1. **Brief content** — `brief.prompt`, `brief.size`, type, plus per-cell variation hints if multi-sheet.
2. **Global style preamble** — `docs/agent-os/sprite-style.md`, loaded once. Concrete, derived from analyzing actual Kenney sprites: outline thickness, shading rules, anti-aliasing prohibitions, color count per sprite, silhouette conventions.
3. **Reference images (MANDATORY)** — passed to the `images/edits` endpoint via multipart `image` field. Resolved from `brief.references`, which **must** include at least 2 exemplar sprites of the same family from existing assets, scaled up via nearest-neighbor (≥256×256) so the model can see pixel detail. Brief validation rejects any brief with fewer than 2 references. Empirically, references are doing ~90% of style fidelity work — a v3 A/B test (refs vs no-refs) showed the no-refs output produced "generic AI pixel art" while the refs output produced sprites that read as same-family Kenney tiny-dungeon weapons. References are non-optional.
4. **Layout block (sheet-mode only)** — explicit grid dimensions, square cell requirement, empty-cell location, per-cell margin (≥10%), no clipping.
5. **Negative constraints (sheet-mode only)** — explicit `NO numbers, NO digits, NO labels, NO text, NO captions, NO watermarks, NO clipping, NO overlap with cell borders`. These are non-negotiable in the template; empirically they are the difference between a usable sheet and one that needs OCR-style cleanup.

The style and prompt constraints live in `docs/agent-os/sprite-style.md`. Because references are required, the generator always hits `images/edits` (not `images/generations`).

**F2.4 Slicing (post-generator, pre-postprocessor).** A new pipeline stage `scripts/sprites/slice-sheet.ts`:

- Takes the 1024×1024 sheet PNG and detects the configured cell grid (current default: 4×4; equal-size cells with ≥1px gutter).
- Emits sliced cell PNGs to `generated/runs/<brief-id>/<run-id>/raw/NN.png`.
- If grid detection fails (e.g., model didn't follow layout), the entire sheet is rejected and the run is retried up to 2× with a stricter layout reminder appended to the prompt.

**F2.5 Module shape.** Generator + slicer remain **pure modules** — no shared mutable state, no environment assumptions beyond provider env vars. CLI entry point: `npm run sprites:run -- --brief briefs/weapons/iron-sword.yaml`.

#### F3. Post-processor (the deterministic conformance step)

Runs locally, no network. For each raw candidate:

1. **Background removal** — corner-color flood-fill heuristic, anything reachable from the four corners becomes alpha 0.
2. **Downscale** — nearest-neighbor resample from native (e.g. 1024x1024) to `brief.size`.
3. **Palette quantize** — every opaque pixel snapped to the nearest entry in the palette referenced by `brief.palette`. Distance metric is Euclidean RGB (revisit later if results warrant).
4. **Alpha hard-threshold** — alpha values not in `{0, 255}` are snapped: `>128 → 255`, else `0`.

Output: `generated/runs/<brief-id>/<run-id>/processed/NN.png`. The post-processor is the **contract** that makes sensors trivially satisfiable — sensors verify the contract was met, they do not enforce it.

#### F4. Sensors (deterministic gates)

Implemented as Vitest tests under `tests/sensors/<type>.test.ts`. Per-type sensor sets share a common base:

**Universal sensors (all types)**

- Width and height match `brief.size` exactly.
- Every alpha value is exactly 0 or 255 (no semi-transparency).
- Every opaque pixel's RGB is an exact match for an entry in the palette JSON.
- Bounding box of opaque pixels fits within image bounds.
- Opaque-pixel ratio in `[0.10, 0.65]` (rejects empty and solid outputs).
- The pixel at `brief.anchor` is opaque.

**Weapon-specific sensors (MVP)**

- Silhouette has at least one diagonal axis of variation — rejects perfect-vertical "staffs" when the brief asked for a sword. (Heuristic: PCA of opaque-pixel coordinates; primary axis must not be ±2° from vertical or horizontal.)

Sensors run in CI on every PR that touches `public/assets/generated/`. **A sensor failure is a hard fail** — there is no soft path. If the post-processor produced something a sensor rejects, the post-processor needs fixing, not the sensor.

#### F5. Evaluators (subjective scoring, offline)

Run only locally and only on candidates that passed sensors. Three named scorers, each with an explicit rejection threshold:

- **`style_match`** — VLM compares candidate to `brief.references` (the same Kenney-family sprites used to ground generation). Scores 1–5. Threshold: `< 3` auto-rejects before lab review. This is the primary defense against the model drifting into "generic AI pixel art" when the reference grounding wasn't strong enough.
- **`brief_match`** — VLM compares candidate to `brief.prompt`. Scores 1–5. Threshold: `< 3` auto-rejects.
- **`readability`** — VLM is asked "does this read at game scale on a dark floor tile?" with the candidate composited at 1× over a representative biome tile. Scores 1–5. Threshold: `< 3` auto-rejects.

Two phases for _how_ the scorers run; the contract `(candidate, brief) → {score, rationale}` is identical:

**Phase 1 — JSON scorecard.** A Node script (`scripts/sprites/judge.ts`) calls Azure OpenAI `gpt-4o` (vision) for each candidate. Input: the candidate (upscaled 8x for model legibility), `brief.prompt`, three reference PNGs from `brief.references` or sibling registry entries. Output: structured JSON artifacts under `generated/runs/<brief-id>/<run-id>/processed/*.judge.json` with run-level summary in `summary.json`:

```json
{
  "brief": "iron-sword",
  "model": "gpt-4o",
  "ts": "2026-06-04T16:00:00Z",
  "candidates": [
    {
      "id": "00",
      "sensors": "passed",
      "scores": { "style_match": 4, "brief_match": 5, "readability": 4 },
      "rejected": false,
      "rationale": "Strong diagonal silhouette..."
    },
    { "id": "01", "sensors": "failed:dimensions" },
    {
      "id": "02",
      "sensors": "passed",
      "scores": { "style_match": 2, "brief_match": 4, "readability": 3 },
      "rejected": true,
      "rejectedBy": "style_match",
      "rationale": "Outline is too thin; doesn't match Kenney maroon."
    }
  ]
}
```

**Phase 2 — Azure AI Foundry Evaluations.** Same evaluator semantics, but runs as a Foundry eval job: candidates become a dataset, each `*MatchEvaluator` becomes a custom evaluator, results land in the Foundry UI with run-over-run comparison and rationale persistence. Phase 1 ships first; Phase 2 is a port, not a redesign — the function contract `(candidate, brief) → {score, rationale}` is identical.

**Sensors stay in Vitest in both phases.** Foundry is the offline judge layer, never a CI gate.

#### F6. Approval and registry integration

- `scripts/sprites/approve.ts` / `npm run sprites:approve -- <runDir> --variant <n>` are the only operations that mutate checked-in repo state.
- It promotes `generated/runs/<brief>/<runId>/processed/<id>.png` to `public/assets/generated/<brief>.png` and upserts `public/assets/generated/manifest.json` for engine pickup.
- After approval, the sensor test for that asset is added to the per-type sensor test file so future PRs cannot land changes that break the approved sprite.

#### F7. `sprite-gallery-lab`

A lab at `src/labs/sprite-gallery-lab/` provides the human-in-the-loop surface. UI sections:

- **Brief editor** — form-bound to the YAML schema; "Save brief" writes/updates `briefs/<type>/<name>.yaml`.
- **Pipeline controls** — buttons for Generate, Postprocess, Judge, and Run-all; live status; last-run summary (candidates, sensor pass count, mean judge score).
- **References panel** — auto-pulled from registry siblings (matching `brief.type` and any tags in common); the human-visible style baseline.
- **Candidate grid** — N cards per run; each shows the 16x16 sprite at 8x preview, sensor pass/fail badge, judge scores.
- **Selected-candidate detail** — side-by-side with the nearest-style sibling; sensor breakdown (per-check status with palette overlay for palette failures); judge rationale; pixel-grid + palette overlay toggles; Approve / Reject / Iterate buttons.

**Iterate** captures the selected candidate's prompt, lets the user tweak it inline, and re-runs gen with a smaller N (default 4) using the same brief otherwise — for fast prompt-tuning loops.

#### F8. Sidecar architecture

The lab cannot call Azure OpenAI directly (secrets, file I/O). `npm run sprites:gallery` starts Vite **and** a small Fastify sidecar (`scripts/sprites/sidecar/server.ts`, port 3010) that exposes:

| Endpoint                                            | Purpose                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/health`                                   | Sidecar readiness; lab uses this to enable/disable action buttons |
| `GET /api/runs`                                     | List available run directories                                    |
| `GET /api/runs/:briefId/:runId`                     | Return the run `summary.json`                                     |
| `GET /api/runs/:briefId/:runId/processed/:filename` | Serve processed PNG/JSON artifacts                                |
| `POST /api/runs/:briefId/:runId/approve`            | Approve a variant from an existing run                            |

The sidecar is a thin HTTP shell over the same TypeScript modules the CLI uses. **No business logic in the sidecar.**

#### F9. Graceful review-only mode

When the sidecar is absent (the lab is hosted on GitHub Pages, or the user is reviewing without `npm run sprites:gallery`), the lab pings `/api/health`, fails, and falls into review-only mode:

- Reads `generated/runs/**/summary.json` and processed artifacts via static serving.
- Candidate grid and selected-detail panels render normally.
- Generate / Postprocess / Judge / Approve / Iterate / Save Brief buttons are disabled with tooltips explaining how to enable them.

This lets the lab deploy publicly as a viewer without exposing any pipeline-mutating action.

### Non-functional

- **Determinism:** the post-processor and all sensors are pure functions of their inputs. A given raw PNG always quantizes to the same processed PNG.
- **Cost ceiling:** a default run (N=8 generations + N≤8 judge calls) should cost <$0.50 at gpt-image-1 / gpt-4o list prices. The lab should display the per-run cost estimate before the user clicks Generate.
- **Secrets:** Azure credentials live in `.env` (gitignored), read only by the sidecar. They never reach the browser. The sidecar binds to `127.0.0.1` only.
- **Palette extensibility:** palettes are pure data (`data/palettes/<name>.json`). Adding a new palette (`steampunk`, `ice-dungeon`) is a no-op architecturally — drop a file in, reference it from a brief.

### Out of scope (for this spec)

- Animations / multi-frame character sheets. The pipeline is single-frame for MVP.
- Tile-edge sensors (tileability checks). Required for terrain assets; deferred.
- Auto-prompt rewriting / brief generation from natural language. Briefs are human-written for now.
- Direct integration with The Director (Ollama / floor-load AI). The pipeline is an offline content tool, not a runtime system.

## Design

### File layout

```
.specify/specs/sprite-generation-pipeline.md         # this spec
docs/knowledge/adr/0003-sprite-generation-pipeline.md # ADR
docs/agent-os/sprite-style.md                         # global style preamble (text + reference image manifests)

briefs/
  weapons/
    iron-sword.yaml
    skull-mace.yaml
data/
  palettes/
    kenney-roguelike.json   # auto-extracted, append-only edits
    # future: steampunk.json, ice-dungeon.json, ...

scripts/sprites/
  extract-palette.ts        # one-shot: builds a palette JSON from a Kenney sheet
  generate-one.ts           # brief -> run artifacts (raw + processed + summary)
  cli.ts                    # sprites:run entrypoint
  postprocess.ts            # raw -> bg-remove + downscale + quantize + alpha-snap
  judge.ts                  # processed (sensor-passing) -> scorecard.json
  approve.ts                # winner -> public/assets/generated + manifest upsert
  sidecar/
    server.ts               # Fastify; routes only call into the modules above
    jobs.ts                 # in-memory job tracker (per-process)

src/labs/sprite-gallery-lab/
  index.ts                  # registerLab + UI orchestration

generated/                  # gitignored
  runs/<brief-id>/<run-id>/
    raw/NN.png
    processed/NN.png
    processed/NN.scorecard.json
    processed/NN.judge.json
    summary.json

public/assets/generated/
  <brief-id>.png            # checked in only after approval
  manifest.json

tests/
  sensors/
    weapons.test.ts         # universal + weapon-specific sensors
  unit/
    palette-quantize.test.ts
    bg-remove.test.ts
```

### Brief schema

```yaml
# briefs/weapons/iron-sword.yaml
type: weapon
name: iron-sword
size: [16, 16]
palette: kenney-roguelike
anchor: { x: 8, y: 14 }
tags: [sword, melee, common]
prompt: |
  A rusty iron longsword. Leather-wrapped grip. Pommel pointing
  down-left, blade up-right. Game-asset framing, isolated background.
references:
  - registry: roguelike_chars
    cells: [[12, 5], [12, 6], [12, 7]]
```

A small TypeScript schema validator (`scripts/sprites/brief-schema.ts`, Zod) is the source of truth and is reused by the generator, the lab's brief editor, and the sensors.

### Palette extraction

Run once per source pack:

```
npm run sprites:extract-palette -- --source public/assets/kenney/roguelike-characters/spritesheet.png --out data/palettes/kenney-roguelike.json
```

The script walks every pixel of the input sheet, dedupes opaque RGB tuples, and writes a sorted JSON array. Re-running produces identical output (set-based, sorted) — palette files are content-addressable.

### Pipeline run

Two surfaces, identical underlying calls:

- **CLI (CI / scripted use):** `npm run sprites:run -- --brief briefs/weapons/iron-sword.yaml`
- **Lab (interactive / human review):** `sprite-gallery-lab` review + approve flow

Both invoke `generate → postprocess → sensors → judge` in sequence, writing artifacts under `generated/`. The CLI exits non-zero if any stage fails; the lab surfaces failures inline.

### Sensor failure UX

Each universal sensor returns a structured result, not a boolean:

```typescript
type SensorResult =
  | { ok: true; sensor: string }
  | { ok: false; sensor: string; reason: string; pixels?: { x: number; y: number }[] };
```

The lab uses `pixels` to highlight offending coordinates in the palette/pixel-grid overlays — palette failures show _which_ pixel is out of palette, not just "palette failed."

### Phase 2: Foundry evaluators

Each Phase-1 judge becomes a Foundry custom evaluator:

- `StyleMatchEvaluator` — VLM call comparing candidate vs. Kenney refs.
- `BriefMatchEvaluator` — VLM call comparing candidate vs. `brief.prompt`.
- `ReadabilityEvaluator` — VLM call asking "does this read at game scale on a dark floor tile?"

A Phase-2 run uploads the candidate set as a Foundry dataset, kicks an evaluation run, and the lab's Judge panel swaps its data source from run-local judge artifacts (`generated/runs/**/processed/*.judge.json`) to the Foundry run output. No other lab UI changes.

### Constitutional implications and ADR

This spec touches `assets`, `engine/sprites/registry`, `labs`, `scripts`, and `tests` — well over the "2+ systems" threshold. An ADR (`docs/knowledge/adr/NNNN-sprite-generation-pipeline.md`) will be authored before implementation begins. The ADR will record: generator choice (Azure OpenAI gpt-image-1), eval phasing (JSON → Foundry), sensor-vs-evaluator boundary, sidecar architecture, and palette-as-data convention.

## Test Plan

### Unit tests (Vitest)

- `palette-quantize.test.ts` — given a known-bad PNG and a 4-color palette, the output PNG is pixel-identical to a checked-in golden file. Property test: every output pixel's RGB is in the input palette.
- `bg-remove.test.ts` — corner-flood-fill produces alpha 0 for connected background, leaves disconnected interior pixels opaque.
- `brief-schema.test.ts` — valid briefs parse; invalid briefs (missing required fields, non-existent palette name, anchor outside bounds) produce specific error messages.
- `sensor-common.test.ts` — each universal sensor: passes on a canonical good fixture, fails with the expected `reason` and `pixels` on each kind of bad fixture.

### Integration tests

- `weapons-pipeline.test.ts` — uses a **stub generator** that returns canned 1024x1024 PNGs (checked into `tests/fixtures/`), runs the real post-processor and real sensors. Asserts that "good" fixtures pass all sensors and "bad" fixtures fail the expected sensor. No network calls in CI.
- `approve.test.ts` — running `approve.ts` against a temp repo copy moves the file and appends to a temp `registry.ts`; output diff matches a golden file.

### Lab smoke tests

- `sprite-gallery-lab` registers and renders without console errors when sidecar is absent (review-only mode). This is what runs in CI; full sidecar-driven flows are local-only.

### Out-of-CI verification

- `npm run sprites:run -- --brief <brief>` is run manually for each new asset family. Failure modes (network, auth, model regression) are tracked as handoff notes, not CI gates.

## Constitutional Compliance

- **§2 Lab-Gated Development:** `sprite-gallery-lab` ships before the pipeline is considered complete. Lab smoke test runs in CI.
- **§3 Deterministic CI Only:** sensors are pure deterministic Vitest tests with structured failure reasons. The judge / Foundry evaluators run **only locally** — never in CI. This is the explicit rationale for splitting sensors and evaluators in the first place.
- **§4 Deterministic Game Logic:** the post-processor uses no `Math.random()` and no clocks; given a raw input it always produces the same processed output. The pipeline does not run at game time, but the sprites it produces are loaded by `BootScene` like any other asset and play by the same rules.
- **§5 ECS-Phaser Bridge:** the lab and pipeline live in `src/labs/`, `scripts/`, and `tests/` — no `src/core/` imports anywhere. Approved sprites are loaded by engine preload code from `public/assets/generated/manifest.json`, which stays in the rendering layer.
- **§7 Memory Governance:** an ADR will accompany the implementation PR. Each generation run produces artifacts under `generated/` (gitignored) and a scorecard whose summary belongs in the session handoff.
- **§8 Conventional Commits:** approval commits use `feat(sprites): add <name>`. Pipeline / sensor / lab code uses `feat:`, `fix:`, `lab:` as appropriate.
- **§9 Coverage:** sensor and post-processor modules sit in `scripts/` (no minimum) but the deterministic logic is heavily tested by design. The lab itself only needs the smoke test (§3 already accounts for the 30% labs floor).
