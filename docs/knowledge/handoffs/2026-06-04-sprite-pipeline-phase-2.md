# Handoff — Sprite generation pipeline, Phase 2

**Date:** 2026-06-04
**Persona:** graphics-designer
**Branch:** `nalfeo/sprite-pipeline-phase-2` off `main`
**PR:** (to be opened after this handoff)

## What shipped

Phase 2 of the sprite-generation pipeline. Briefs in YAML → sheet-mode
generation against Azure OpenAI → slice → post-process → score → pick.
End-to-end with the CLI `npm run sprites:run -- --brief <path>`.

10 commits, all conventional, all green under `npm run typecheck && npm
run lint && npm test && npm run test:integration` (399 tests passing).

```
docs(sprites): add sprite style guide and relocate sensors
feat(sprites): brief loader with sheet+sensors schema extensions
feat(sprites): prompt builder for single and sheet modes
feat(sprites): sheet slicer with fast-check property test
feat(sprites): candidate scorer wrapping universal+weapon sensors
feat(sprites): Azure OpenAI images/edits provider (fetch-injected)
feat(sprites): generate-one orchestrator with sheet+slice+score loop
feat(sprites): sprites:run CLI
feat(sprites): example iron-sword brief
chore(sprites): update graphics-designer persona and add Phase 3 lab stub
```

## Key design decisions (locked with user)

- **Sheet defaults:** 3×3 = 9 variants per call, no empty cells.
  Configurable per brief via `generation.sheet`. Defaults are baked into
  `brief-schema.ts`.
- **Selection:** CLI prints every variant ranked passed-first / score
  desc / index asc tie-break; user reviews; `--pick <variantIndex>`
  writes `selection.json`. No `chosen.png`, no auto-pick.
- **Promotion:** out of scope. Phase 2 only writes under `generated/`
  (gitignored). Approved sprites get manually copied to
  `public/assets/generated/` by a future step.
- **Retry policy:** orchestrator retries up to `maxAttempts` (default 2)
  ONLY on `bad-grid` / `non-png` ProviderError kinds. `auth`,
  `network`, `rate-limit`, `provider-error` fail fast. "No variant
  passed all sensors" does NOT auto-retry — human reviews the sheet.

## Architecture

```
scripts/sprites/
  brief-schema.ts            -- Zod schema, extended with generation.sheet + sensors
  load-brief.ts              -- YAML loader + palette resolver (projectRoot-injectable)
  build-prompt.ts            -- pure: buildPrompt / buildSheetPrompt with style preamble
  slice-sheet.ts             -- pure: NxM grid slicer with fast-check property test
  score-candidate.ts         -- pure: wraps universal+weapon sensors, applies brief overrides
  postprocess.ts             -- (Phase 1, unchanged)
  extract-palette.ts         -- (Phase 1, unchanged)
  sensors/
    common.ts                -- (Phase 1, relocated from tests/sensors/)
    weapons.ts               -- diagonalToleranceDeg now per-call opt (default 2 deg)
  provider/
    types.ts                 -- ImageProvider, ProviderError, typed kinds
    azure-openai.ts          -- fetch-injected, no retry, Node 22 FormData/Blob
    factory.ts               -- env-driven (AZURE_OPENAI_*), SPRITES_PROVIDER switch
  run-artifacts.ts           -- pure path builders + impure writers; rankCandidates
  generate-one.ts            -- orchestrator (composes everything)
  cli.ts                     -- sprites:run entry point

docs/agent-os/
  sprite-style.md            -- style guide (preamble between START/END markers)
  personas/graphics-designer.md  -- updated for Phase 2 reality

briefs/weapons/
  iron-sword.yaml            -- example brief

src/labs/sprite-forge-lab/
  README.md                  -- Phase 3 stub

tests/unit/sprites/          -- build-prompt, slice-sheet, score-candidate, azure-openai
tests/integration/
  generate-one.test.ts       -- mock provider, full pipeline (no network)
```

## Artifact layout

```
generated/runs/<brief-name>/<run-id>/
  sheet-00.png                       -- raw multi-variant sheet from provider
  raw/NN.png                         -- N-th slice, before postprocess
  processed/NN.png                   -- final 16x16 post-processed PNG
  processed/NN.scorecard.json        -- sensor scorecard
  summary.json                       -- ranked candidates + metadata
  selection.json                     -- written only by --pick
```

`run-id` is `ISO-timestamp-shortprompthash` so two runs of the same
brief are easy to compare and never collide.

## Provider env

The factory reads:
- `AZURE_OPENAI_ENDPOINT` (required)
- `AZURE_OPENAI_API_KEY` (required)
- `AZURE_OPENAI_IMAGE_DEPLOYMENT` (default `gpt-image-1`)
- `AZURE_OPENAI_API_VERSION` (default `2025-04-01-preview`)
- `SPRITES_PROVIDER=azure-openai` (default; reserved for future
  `mai-image` swap — see TODO in `provider/azure-openai.ts`)

**Do not commit creds.** The session file at
`C:\Users\nalfeo\.copilot\session-state\f7220956-...\files\azure-sprite-pipeline.env`
has working values for local runs.

## What's NOT done (Phase 3 / later)

1. **`sprite-forge-lab`** — interactive Phaser lab for picking variants
   with overlays and judge rationales. Stub at
   `src/labs/sprite-forge-lab/README.md`.
2. **Per-icon Kenney crops** — the example brief currently references
   the full Kenney spritesheets. A Phase 3 task is to crop reference
   PNGs to single sprites and update the brief.
3. **Promotion CLI** — copying an approved variant from `generated/`
   to `public/assets/generated/sprites/<category>/<id>.png` and wiring
   it into the registry.
4. **Real Azure smoke in CI** — currently all tests mock the network.
   A nightly integration job that actually hits the gpt-image-1
   deployment would catch endpoint drift early.
5. **MAI image-gen provider** — `SPRITES_PROVIDER=mai-image` is
   reserved in the factory; the actual implementation lands when MAI
   image models are accessible from this environment.

## Verification

```sh
npm run typecheck            # green
npm run lint                 # green
npm test                     # 399 passing
npm run test:integration     # 5 generateOne tests + existing integrations
npm run lint:dead-code       # remaining warnings are pre-existing
```

The dead-code warnings on `scripts/sprites/sensors/common.ts`
(`dimensionsExact`, `alphaBinary`, etc.) are pre-existing — those
functions are called internally via the `universalSensors` umbrella but
knip doesn't see that as external use. Out of scope to fix here.

## Open questions for follow-up

- Should `--pick` require the variant to have actually passed all
  sensors? Currently yes (fails with a clear message otherwise). User
  can override by editing `summary.json` manually if needed.
- The orchestrator's `bad-grid` retry hits the model again with the
  same prompt. Should we tweak the prompt on retry (e.g., emphasise
  "fill every cell")? Today it's a straight re-roll.
- Knip configuration could be tightened to recognise the
  `universalSensors` re-export pattern. Left alone here to avoid
  scope-creep.
