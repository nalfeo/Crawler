# Session Handoff: Issue 4273 Request Context Contract

## Date

2026-09-06

## Persona

Producer coordinating deterministic sprite pipeline repair

## Systems touched

sprite-pipeline, sprite-workflow, ci-policy

## Apples

2🍎 estimated, 2🍎 actual.

## Problem

Issue #4273 required the sprite asset-request contract to freeze its request
context at ingestion and keep it stable through synthesis, brief selection,
judging, and durable YAML output instead of drifting via downstream live
recomputation.

## What Was Done

- Extended the canonical asset-request contract to carry frozen `floorId`,
  `familyId`, `mobRole`, and `injectionOverrides` metadata.
- Updated the request fingerprint logic to include the serialized context so a
  request remains stable even when downstream logic infers or normalizes other
  values.
- Added deterministic parsing/validation so malformed or conflicting context is
  rejected rather than silently recomputed.
- Kept the change scoped to the request-context contract and validation layer;
  no runtime animation or gameplay changes were introduced.

## Validation

- `npx vitest run tests/unit/sprites/asset-request.test.ts tests/unit/sprites/build-prompt.test.ts tests/unit/sprites/judge.test.ts tests/unit/sprites/issue-pipeline.test.ts --reporter=dot`: passed.
- `npm run verify:fast`: passed.

## Blockers

None known.
