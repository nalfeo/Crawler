# Handoff: Themed equipment forge

**Date:** 2026-07-25
**Persona:** Producer, routing implementation through the sprite-pipeline and devtools surfaces
**Apples:** 3 estimated, 3 actual (tooling and asset-pipeline cap)

## Systems touched

sprite-pipeline, sprite-workflow, devtools, azure-infra, ci-policy

## Outcome

Added a reusable agent, skill, trusted GitHub workflow, durable state machine,
and interactive review canvas that turn an authored equipment theme into a
cohesive collection through four gated phases:
`roster -> briefs -> sprite-sheets -> variant-approval -> complete`.

Each phase supports item-level and whole-collection review, requires automated
cohesion of at least 3/5, freezes approved items, and reruns only rejected or
unresolved items. Final publication is all-or-nothing and requires every item
to have one to three approved variants.

The Classic Fantasy pilot defines 22 items spanning six weapon types and all 16
non-hand equipment slots, exceeding the required five weapon types and 11
non-hand slots. No paid generation or final asset publication was performed in
this implementation session.

## What changed

- Added strict schemas and immutable mutations for plans, phases, artifacts,
  item/set reviews, judge evidence, state revisions, and publication.
- Derived collection coverage from `SLOT_REGISTRY`, currently requiring
  `ceil(16 * 2/3) = 11` non-hand slots.
- Propagated explicit authored theme direction through brief synthesis, YAML,
  image prompting, and judging while preserving floor context.
- Added generic phase execution, deterministic contact sheets, text/vision
  collection judges, and deterministic selection of one to three variants.
- Added exact publication identity using generated `briefId`, `runId`, and
  sparse `variantIndex`, staging complete run trees into one queue commit.
- Added `.github/workflows/theme-equipment.yml` for trusted, serialized cloud
  generation, judging, phase advancement, status, and publication.
- Added the `equipment-theme-forge` agent and `theme-equipment-forge` skill.
- Added a secure review canvas keyed by stable set ID. Mutations require a
  per-instance token, exact same-origin JSON requests, bounded bodies, canonical
  schema validation, artifact identity lookup, and per-set serialization.
- Rejected reruns now increment item revisions before generation so retry
  artifacts and brief keys use `r1+` identities instead of overwriting `r0`.

## Runtime observation

The committed canvas loaded the Classic Fantasy set with all 22 items, showed
6/5 weapon coverage and 16/11 non-hand-slot coverage, and displayed canonical
gate failures. A real item approval through the loopback bridge advanced durable
state revision 0 to 1. Temporary local state used for this observation was
removed afterward.

## Review-driven fixes

The first code-review round found and resolved three concerns:

1. Workflow inputs now enter shell commands through environment variables
   instead of script interpolation.
2. Canvas routes explicitly project accepted mutation fields so request bodies
   cannot override the server-bound action or set ID.
3. Canvas subprocess commands serialize per stable set ID, preventing parallel
   instances from racing RunStore's non-atomic expected-revision check.

The second round found that rejected reruns did not advance item revisions.
`ThemeEquipmentRunner.runPhase` now applies the canonical revision mutation
before rejected-only execution. A separate-model targeted validation confirmed
the lifecycle concern is resolved without altering approved items or optimistic
save behavior.

## Validation

- Theme-focused sprite tests: 75 passed after the revision fix.
- `npm run verify:fast`: 58 files, 842 tests, typecheck, lint, and deterministic
  size/weight/physics guards passed.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-25-theme-equipment-pipeline.review-ledger.json`.

## Operational notes

- Paid generation and collection judging run only through the trusted workflow.
- Workflow concurrency serializes runs by set ID with cancellation disabled.
- RunStore expected revisions remain optimistic rather than storage-native CAS;
  trusted workflow serialization and canvas per-set serialization are therefore
  part of the mutation contract.
- Operators author a plan under `data/theme-equipment-sets/`, dispatch `init`,
  review each phase in the canvas, and publish only after variant approval.
- ADR 0073 is the architectural authority; the operator guide is
  `docs/guides/theme-equipment-pipeline.md`.
