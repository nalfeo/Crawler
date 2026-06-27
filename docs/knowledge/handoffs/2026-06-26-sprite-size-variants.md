# Session Handoff: Sprite size variant support

## Date

2026-06-26

## Persona(s) adopted

**Producer** — the task spans the sprite authoring schema, the brief loader, the
synth CLI/orchestrator, and the prompt builder, plus tests and docs. Multi-layer
pipeline work with no single specialist owner, so Producer coordinated the slice
end-to-end.

## Routing verdict

✅ right persona — the change touched 5+ pipeline modules plus tests/docs, which
is exactly the cross-cutting coordination Producer is for.

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 3
Verdict: 🎯 Exact — new pure module + threading through ~7 source files with tests
and docs, no ADR or lab required; landed squarely in Medium as called.

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

Added independent **size-variant** selection to the sprite generation workflow.
Sprite **type** (weapon, enemy, …) and **size** are now chosen independently; the
variant scales the per-type defaults:

| Variant   | Width | Height |
| --------- | ----- | ------ |
| `default` | 1×    | 1×     |
| `wide`    | 2×    | 1×     |
| `tall`    | 1×    | 2×     |
| `large`   | 2×    | 2×     |

Changes:

- **`scripts/sprites/size-variants.ts`** (NEW) — pure module: `SIZE_VARIANTS`,
  `SizeVariant`, `DEFAULT_SIZE_VARIANT`, `SIZE_VARIANT_MULTIPLIERS`,
  `isSizeVariant`, `coerceSizeVariant`, and
  `applySizeVariantToDefaults(defaults, variant)`. Scales `size.{width,height}`,
  `anchor.{x,y}`, and `generation.sheet.nativeCanvas` (clamped to 2048,
  4×4-divisibility preserved). Imports nothing from `brief-schema` (one-way
  dependency).
- **`scripts/sprites/brief-schema.ts`** — minimal brief schema accepts an
  optional `sizeVariant` (passthrough), validated against `SIZE_VARIANTS`.
- **`scripts/sprites/load-brief.ts`** — `mergeMinimalIntoDefaults` extracts +
  strips `sizeVariant`, scales the per-type **defaults** before the deep-merge so
  explicit author `size`/`anchor` overrides still win (escape hatch).
- **`scripts/sprites/synthesize-brief.ts`** — threads `sizeVariant` into the
  rendered YAML (emitted only when non-default), the sidecar, and the result.
- **`scripts/sprites/synth-cli.ts`** — new `--size <default|wide|tall|large>`
  flag with help text, threaded to the orchestrator.
- **`scripts/sprites/build-prompt.ts`** — prompt is now aspect-ratio aware:
  `## Output size` block reports aspect ratio + a source-footprint band for
  non-square subjects (square subjects keep the original 1:1 wording); type rules
  scale with the brief size.
- **Tests** — new `tests/unit/sprites/size-variants.test.ts` (15 tests) plus new
  describe blocks in `load-brief`, `synthesize-brief`, `brief-schema`, and
  `build-prompt` test files. Updated `synth-cli.test.ts` for the new flag.
- **Docs** — `docs/agent-os/sprite-style.md` gained a `--size` variants table +
  bullet in the canonical "Synthesising briefs" section, and an accidental
  ~70-line duplicated block (former lines 172–240) was removed.
  `.specify/specs/sprite-generation-pipeline.md` F1 gained a `sizeVariant`
  paragraph.

## What's Next

- Optional: expose `--size` in any higher-level batch/asset-plan tooling if
  authors want to request variants there rather than per-brief.
- Optional: surface the chosen variant in the sprite gallery/catalog UI.

## Blockers

None.

## Branch State

- Branch: `nalfeo-sprite-size-variants`
- All tests passing: yes (`npm run verify` — full suite green)
- PR created: yes (see PR link in session)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist for this session — no telemetry
section to paste.

## Test Results

`npm run verify` — full suite passed:

- Typecheck + lint + format: clean (ran `npm run format` once to fix Prettier).
- Unit tests: 328 passed (23 files).
- Integration: 49 passed, 1 skipped.
- Headless Floor 1 completion gate: 68 passed.
- Build: succeeded.

## Key Decisions Made

- **`sizeVariant` scales per-type defaults, not absolute dimensions.** Keeps each
  type's tuned proportions/anchor while letting authors pick a footprint
  independently.
- **Scale defaults before merge.** Author-supplied `size`/`anchor` always win, so
  the variant is a convenience, not a constraint.
- **One-way module dependency.** `size-variants.ts` imports nothing from
  `brief-schema.ts`; `brief-schema` imports `SIZE_VARIANTS` from it, avoiding a
  cycle.
- **Prompt stays backward-compatible for square sprites** — original 1:1 wording
  is preserved; only non-square subjects get the aspect-ratio + footprint band.
