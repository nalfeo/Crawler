# Handoff: Sprite pipeline test isolation

## Summary

Isolated the sprite generation/editing pipeline tests into a dedicated vitest
project (`sprites`), decoupled from the game test projects (`unit`,
`integration`). A pure sprite pipeline change now runs only sprite tests in CI
and locally; a game-only change skips sprite tests entirely.

## What changed

- **`vitest.config.ts`**: Added `sprites` vitest project covering
  `tests/unit/sprites/**`, `tests/integration/sprites/**`, and 9 pipeline
  integration test files previously mixed into the `integration` project
  (`batch-cli`, `generate-one`, `judge-*`, `run-full`, `sidecar-lifecycle`,
  `synth-to-generate`, `weapons-pipeline`). Added `exclude` arrays to `unit`
  and `integration` projects so they never pull in sprite pipeline tests.

- **`package.json`**: Added `test:sprites` script.

- **`scripts/agent/ci/detect-art-only.sh`**: Added two new output flags:
  - `sprites_only`: true when ALL changed files are in the sprites surface
    (`scripts/sprites/**`, `tests/unit/sprites/**`, `tests/integration/sprites/**`,
    plus the 9 root pipeline integration test files)
  - `sprites_touched`: true when ANY file in the sprites surface changed —
    used to gate `test-sprites` so pure game changes skip the sprite test suite
    Extended `gameplay_safe` allowlist to include the same sprite surface paths.

- **`scripts/agent/ci/local-scope.sh`**: Updated `emit_all_false` to include
  both `sprites_only=false` and `sprites_touched=false`.

- **`.github/workflows/ci.yml`**: Added `sprites_only` and `sprites_touched` to
  `changes` job outputs. Added `test-sprites` job (gated on `sprites_touched`).
  Added `sprites_only != true` skip condition to `test-unit`, `test-integration`,
  `test-unit-coverage`, and `test-e2e`. Updated merge-gate to include
  `test-sprites` with `allow_skipped=true`.

- **`scripts/agent/verify.sh`**: Added `npx vitest run --project sprites` so
  the full local pre-commit loop runs sprite pipeline tests.

- **`scripts/agent/verify-fast.sh`**: Added `--project sprites` to the
  changed-file test run so that editing `scripts/sprites/**` also runs the
  relevant sprite tests locally.

- **13 test files moved** from `tests/unit/` root (and `tests/sensors/`) into
  `tests/unit/sprites/`: bg-remove, brief-schema, normalize-item-art-names,
  palette-quantize, postprocess-modules-speckle, postprocess-rekey,
  postprocess-resize-fit, postprocess-tile, postprocess-trim-fit,
  sprite-catalog-sync, sprite-metadata-pipeline, template-pipeline,
  weapons-sensor (was tests/sensors/weapons.test.ts). Relative imports updated
  from `../../` to `../../../`.

- **`tests/unit/detect-change-scope.test.ts`**: Updated `Scope` interface,
  `run()` parser, `F()` helper, and all existing test cases to include both
  `sprites_only` and `sprites_touched`. Added 9 new test cases covering
  sprites_only, sprites_touched, root integration files, and mixed-change
  scenarios.

- **`AGENTS.md`**: Added `test:sprites` to commands table.

## Systems touched

ci-policy

## Verification

- `npm run verify:fast` — all 27 detect-change-scope tests pass
- `npx vitest run --project sprites` — 84 test files, 1124+ tests pass
- Review ledger: plan review (gpt-5.4, 4 concerns → all resolved) +
  code review (claude-opus-4.8, 1 concern → resolved)

## Apples

🍎🍎🍎 (Medium)

## Unresolved issues

None — all stray sprite-importing test files have been moved into the sprites project.

## Recommended next steps

- Monitor CI on the first sprites-only PR to confirm `test-unit`, `test-integration`,
  and `test-e2e` are correctly skipped while `test-sprites` runs.
