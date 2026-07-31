# Handoff: Big Mama Bufo CI recovery follow-up

**Date:** 2026-07-25  
**Session slug:** bufo-ci-recovery-followup  
**Issue/PR:** nalfeo/Crawler#2022  
**Apple estimate:** 2🍎

## Systems touched

vfx, enemies, ci-policy

## What was done

- Investigated CI run `30174535283` via GitHub Actions MCP and reduced the failures to three root causes:
  - `Lightweight Checks` failed on `src/core/mob-abilities/types.ts` formatting plus two TypeScript regressions in the new Bufo tests.
  - `Unit Tests` and `Advisory coverage` failed with `ReferenceError: window is not defined` across renderer-facing suites.
  - `Integration Tests` failed with the same `window is not defined` crash in `tests/integration/runtime-mob-motion.test.ts`.
- Repaired `src/engine/MobAbilityVfx.ts` by replacing the new runtime `Phaser` import + `fillPoints(Vector2[])` lane fill with `Graphics` path drawing (`beginPath`/`moveTo`/`lineTo`/`closePath`/`fillPath`). This preserves the same committed-lane telegraph footprint without importing browser-bound Phaser globals in Node-side tests.
- Updated `tests/unit/mob-ability-vfx.test.ts` to assert the lane polygon path calls instead of the removed `fillPoints(...)` call.
- Tightened `tests/e2e/big-mama-bufo-arena-observation.test.ts` with an explicit lane-geometry type so the live arena probe narrows the committed lane before reading its fields.
- Fixed the harness signature in `tests/unit/mob-abilities/tongue-repossession.test.ts` by typing the optional `aiType` parameter as `AI_TYPE`, matching the existing enum values.
- Applied the minimal formatting-only wrap in `src/core/mob-abilities/types.ts` needed to satisfy the Prettier gate.

## Verification

- GitHub Actions MCP:
  - `get_workflow_run(30174535283)` ✅ inspected final failing run metadata
  - `get_job_logs(... failed_only=true)` ✅ identified the exact root causes above
- `git diff --check` ✅
- Secret scan on changed files ✅
- `parallel_validation` ✅ no review comments; CodeQL reported 0 alerts (analysis skipped for large DB)
- `node scripts/agent/review/cli.mjs validate docs/knowledge/review-ledgers/2026-07-25-bufo-ci-recovery-followup.review-ledger.json` ⏳ run after committing related metadata
- `node scripts/agent/review/pr-prereq-check.mjs` ❌ before metadata; prompted the handoff / ledger / ADR additions for this recovery diff
- Local npm-backed verification remains blocked in the sandbox because dependency installation fails on DNS resolution for `ms-feed-2.pkgs.visualstudio.com`.

## Remaining work / notes

- Re-run CI on the PR branch to confirm the renderer import regression is gone and the updated test typings clear `Lightweight Checks`, `Unit Tests`, `Integration Tests`, and `Advisory coverage`.
- If CI surfaces a new failure after these fixes, inspect the new run rather than assuming it shares this run’s root cause.
