# Session Handoff: Fix sprite width selector (grid reshape + no ground shadows)

## Date

2026-06-27

## Persona(s) adopted

**Producer** — the task spanned the devtools UI, the sidecar HTTP endpoint, the
generation pipeline, and the prompt builder, plus tests across all of them. No
single specialist owned the whole slice, so the Producer coordinated the
pipeline → prompt → queue → UI → server slices end-to-end.

## Routing verdict

✅ right persona — multi-layer change with no dominant single layer; Producer
splitting into ordered slices was the correct call.

## Apples

Estimated: 🍎 x 4 <!-- declared before work began -->
Actual: 🍎 x 4
Verdict: 🎯 Exact — scope landed exactly as forecast: devtools UI + sidecar
endpoint + generation pipeline + prompt builder + tests, no new ECS system/lab.

Hello kitties: 4/5 = 0.80 🎀

## What Was Done

Two user-requested changes, both shipped:

### 1. Width selector now actually reshapes the sheet

A "wide (2×1)" request previously produced **2 sheets of 16 square sprites**
because of two independent root causes, both fixed:

- **No UI threading.** The devtools sprite-workflow composer had no size
  selector and never sent `sizeVariant` to the sidecar `/api/workflow/synthesize`.
  Added a `sizeSelect` dropdown (`src/devtools-main.ts`), a `requestedSize` field
  on the queue item (`src/devtools/sprite-workflow-queue.ts`, with
  serialization + back-compat sanitize), threading into the synthesize request
  body, a queue-chip size badge, and sidecar validation + passthrough
  (`scripts/sprites/sidecar/server.ts`).
- **Grid never reshaped.** `applySizeVariantToDefaults` used to scale `size`/
  `anchor` and **inflate** `nativeCanvas` (1024→2048) while keeping a 4×4=16
  square grid — so a wide brief still asked for 16 square cells and bad slices
  retried into 2 sheets. Now it keeps `nativeCanvas` fixed at 1024 and divides
  the grid axes by the multiplier (`scripts/sprites/size-variants.ts`):

  | variant        | grid  | cells | cell px |
  | -------------- | ----- | ----- | ------- |
  | default (1×1)  | 4×4   | 16    | 256×256 |
  | **wide (2×1)** | 4r×2c | **8** | 512×256 |
  | tall (1×2)     | 2r×4c | 8     | 256×512 |
  | large (2×2)    | 2r×2c | 4     | 512×512 |

  `scripts/sprites/build-prompt.ts` is now aspect-aware (no hardcoded "square"
  for non-square cells; correct option count/dims in the sheet + output blocks).
  Documented in **ADR 0029**.

**Observed (rule #10):** ran a deterministic script over the real
`data/sprite-types/weapon.json` defaults — `default→16, wide→8, tall→8,
large→4`, canvas stays `1024` for all. Backed by unit assertions in
`size-variants.test.ts` / `load-brief.test.ts` / `build-prompt.test.ts`.

### 2. Briefs explicitly forbid ground shadows

Every generated prompt now tells the image model to add **no ground/cast/contact/
drop shadow** beneath or around the subject (form/volume shading _on_ the sprite
is still allowed). Updated `outputSizeBlock` and `sheetConstraintsBlock` in
`build-prompt.ts`; tile branches left untouched (seamless floor textures have no
subject/floor relationship). The engine draws its own dynamic ground-shadow
ellipses under gems/coins, so baked-in art shadows would double up.

## What's Next

- Nothing blocking. Optional follow-up: expose the same size selector in the CLI
  sprite-batch path if batch authoring wants non-default sizes (currently
  devtools-only).

## Blockers

None.

## Branch State

- Branch: `nalfeo-fix-sprite-width-selector`
- All tests passing: yes (`npm run verify` — typecheck, lint, format, unit,
  integration, headless, build all green)
- PR created: yes (see PR link in session)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — no telemetry section.

## Test Results

`npm run verify` → ✅ Full verification passed. Focused suites:
`devtools-sprite-workflow-queue` (83), `sidecar-server` (64),
`sidecar-synthesize-size` (2, new passthrough proof), `build-prompt` (44),
`size-variants` + `load-brief` reshape assertions — all pass.

## Key Decisions Made

- **ADR 0029** — reshape the sheet grid on a fixed 1024 canvas instead of
  inflating the canvas, so each size variant yields fewer aspect-matched cells at
  a constant pixel budget (wide → 8 × 512×256). Clean 4× integer downscale for
  every variant; satisfies the brief schema's divisibility check.
- No-ground-shadow is a prompt-content change (single file), not a 2+ system
  architectural decision, so it rides along without its own ADR.
