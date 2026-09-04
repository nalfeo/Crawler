# Handoff: Sprite backlog review recovery

## Date

2026-09-04

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, sprite-workflow

## What Was Done

- Made explicit pending-review retries select ahead of the ordinary capped
  backlog, while rejecting missing, ineligible, or over-limit retry requests
  without persisting their state change.
- Included queued-but-unpromoted Sprite Editor dislikes in backlog planning,
  using the shared base/current annotation reconciliation.
- Added regression coverage for retry priority and eligibility, retry selection,
  and pending-overlay dislike selection.

## Validation

- `npx vitest run tests/unit/sprites/sprite-backlog.test.ts tests/unit/sprites/batch-cli-backlog.test.ts`
- `npm run verify:fast`

## Apples

Estimated 2🍎, actual 2🍎 — 🎯 Exact. The repair remained within the existing
backlog planner and its focused test suite.
