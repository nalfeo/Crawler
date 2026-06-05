# ADR 0003: Sprite Generation Pipeline

## Status

Accepted

## Date

2026-06-04

## Context

We need a reliable, deterministic-feeling pipeline to produce game-ready sprites — first for weapons, later for enemies, items, tiles, and VFX. Hand-authoring every sprite is too slow for a project that wants hundreds of weapons and thousands of items. Pure ad-hoc image generation is too noisy: outputs vary in size, palette, alpha cleanliness, and silhouette legibility, which collapses the readability constraints in `docs/agent-os/personas/graphics-designer.md`.

We want a pipeline where:

- Every sprite is described by a small, reviewable text artifact (a "brief").
- The expensive, non-deterministic step (image generation) is isolated.
- Every output is mechanically validated against measurable, falsifiable criteria before being accepted.
- Reusable, codified palettes prevent style drift.
- The same machinery scales from weapons to enemies, tiles, and VFX without rewrites.

This ADR locks in the foundation. It is shipped together with PR 1 (palette extractor, brief schema, post-processor, sensors). Generator, judge, sidecar, and lab UI arrive in later phases.

## Decision

### 1. Generator: Azure OpenAI `gpt-image-1`, deferred to Phase 2

The image generator will be Azure OpenAI's `gpt-image-1`. We picked Azure over the public OpenAI endpoint for compliance, billing, and key rotation reasons, and `gpt-image-1` because its prompt steering and edit modes outperform DALL·E 3 on small, prompt-locked subjects like a single weapon on a transparent background. **No Azure SDK is added in Phase 1**: no `@azure/openai` or `openai` package, no network calls, no environment-variable reads. The generator lives behind a single `generate.ts` module landing in Phase 2; everything in Phase 1 is decoupled from it.

### 2. Eval phasing: JSON sensors first, Foundry later

Quality gating splits into two layers:

1. **Sensors** — pure, deterministic, JSON-only checks (dimensions, alpha values, palette membership, silhouette PCA, anchor opacity). Runs locally in CI. No network, no model. This is what Phase 1 ships.
2. **Judge** — a model-graded evaluator for subjective qualities (appeal, theme fit, style cohesion). Lives behind a sidecar in Phase 3 and graduates to Azure AI Foundry evaluations once the sensors are stable.

Sensors gate every sprite. The judge tunes the corpus. Sensors must be deterministic with exit codes; the judge never lives in CI gates.

### 3. Sensor vs. evaluator boundary

A function is a **sensor** when its result is reproducible bit-for-bit from the same input. It returns `{ok, sensor, reason?, pixels?}` and never depends on a model, a clock, or randomness. A function is an **evaluator** the moment it asks "is this *good*?" instead of "is this *valid*?". Evaluators may use models and prose; sensors may not. Mixing the two in one file is forbidden — sensors live under `tests/sensors/`, evaluators will live behind the sidecar.

### 4. Sidecar architecture

The judge and any other model-driven services run in a small Node sidecar process, not inside the Vite dev server or the game runtime. The lab and the CLI scripts talk to it over HTTP on localhost. This isolates SDKs (`@azure/openai`, eventual Foundry SDKs) from the browser bundle and from CI test machines. Sidecar arrives in Phase 3.

### 5. Palettes are data, not code

Palettes are committed as plain JSON arrays of `[r, g, b]` triples under `data/palettes/`. They are extracted from reference art by `scripts/sprites/extract-palette.ts` and consumed by post-processing and sensors. No palette ever lives inside a `.ts` constant. This makes palettes diffable, swappable per art-direction experiment, and machine-checkable: the quantize step and the palette-membership sensor read the same JSON.

## Consequences

### Positive

- Phase 1 can be reviewed and merged with zero external dependencies and zero secrets.
- Sensors form a contract every later phase plugs into: generator + post-processor must produce pixels that pass sensors, full stop.
- Palette-as-data lets the graphics designer swap art direction without code changes.
- Sidecar boundary keeps Azure SDKs out of the browser bundle forever.

### Negative

- Briefs add ceremony around what could be a one-line prompt. Mitigated by keeping the schema small and by reusing a single brief across many sprites of the same family.
- Sensors codify "valid", not "appealing". Until the judge lands, a sprite can pass sensors and still be ugly. That is intentional for Phase 1.

### Risks

- **Sensor overfitting**: tight sensors may reject acceptable variants. We will track sensor reject rate per family; if it exceeds 30% on hand-curated good sprites, we loosen.
- **Palette lock-in**: extracting a palette from a single reference (Kenney roguelike) biases output toward that look. Phase 4 introduces per-family palettes; Phase 1 ships only the Kenney-roguelike palette as a baseline.
- **Determinism erosion**: any future contributor adding `Math.random()` or `Date.now()` to the post-processor breaks the contract. Enforced by code review and the existing project-wide rule.

## Alternatives Considered

- **Stable Diffusion locally / ComfyUI**: rejected for Phase 1. More moving parts (model weights, GPU dependency, version drift) for unclear quality gains on tiny prompt-locked subjects.
- **Pure hand-authoring**: rejected as the *only* path; still permitted as an escape hatch for one-off hero assets.
- **In-engine procedural generation (shape primitives + noise)**: viable for VFX, not for weapons or characters; out of scope.
- **Putting the judge in CI**: rejected. Model-graded checks are non-deterministic; flaky CI is worse than no CI signal.
- **Inlining palettes as TS constants**: rejected for the reasons in Decision 5.
