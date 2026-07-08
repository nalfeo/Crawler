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

- **`scripts/agent/ci/detect-art-only.sh`**: Added `sprites_only` output flag
  (true when all changed files are in `scripts/sprites/**`,
  `tests/unit/sprites/**`, or `tests/integration/sprites/**`). Also extended
  the `gameplay_safe` allowlist to include those same paths (the headless runner
  never imports `scripts/sprites/`).

- **`scripts/agent/ci/local-scope.sh`**: Updated `emit_all_false` to include
  `sprites_only=false`.

- **`.github/workflows/ci.yml`**: Added `sprites_only` to `changes` job
  outputs. Added `test-sprites` job. Added `sprites_only != true` skip
  condition to `test-unit`, `test-integration`, and `test-unit-coverage`. Updated
  merge-gate to include `test-sprites` and to allow `test-unit`/`test-integration`
  to be skipped (allow_skipped=true) when `sprites_only=true`.

- **`scripts/agent/verify.sh`**: Added note that sprite pipeline tests are now
  in a separate project and won't run in the game verify loop.

- **`scripts/agent/verify-fast.sh`**: Added `--project sprites` to the
  changed-file test run so that editing `scripts/sprites/**` also runs the
  relevant sprite tests locally.

- **`tests/unit/detect-change-scope.test.ts`**: Updated `Scope` interface,
  `run()` parser, `F()` helper, and all existing test cases to include
  `sprites_only`. Added 6 new test cases covering sprites_only=true and
  mixed-change scenarios.

- **`AGENTS.md`**: Added `test:sprites` to commands table.

## Systems touched

ci, test-infra

## Verification

- `npm run verify:fast` — all 24 detect-change-scope tests pass
- `npx vitest run --project sprites` — 71 test files, 1019 tests pass

## Apples

🍎🍎🍎 (Medium) — 9 files, CI infrastructure + test config + detection script.

## Unresolved issues

- Tests in `tests/unit/` that directly import `scripts/sprites/` but live
  outside `tests/unit/sprites/` (e.g. `bg-remove.test.ts`, `postprocess-*.test.ts`,
  `template-pipeline.test.ts`) still run in the `unit` project. They are
  lightweight and safe there, but a future pass could move them to `tests/unit/sprites/`
  for complete isolation. Tracked as a follow-up only.

## Recommended next steps

- Monitor CI on the first sprites-only PR to confirm `test-unit` and
  `test-integration` are correctly skipped.
- If the mixed `tests/unit/` sprite tests (postprocess-\*, bg-remove, etc.)
  cause friction, move them to `tests/unit/sprites/` in a follow-up.
