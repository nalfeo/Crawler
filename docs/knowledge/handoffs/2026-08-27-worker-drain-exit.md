# Handoff: Asset-request worker producer-complete drain

## Date

2026-08-27

## Persona

DevOps Engineer

## Systems touched

sprite-pipeline, sprite-workflow, ci-policy

## Apples

3🍎 estimated / 3🍎 actual — exact. The tooling-only cap fit: one coordination
protocol, deterministic race coverage, workflow wiring, and review harness.

## Outcome

Removed the measured **13,926ms** asset-request worker idle tail without lowering
the legacy `SPRITES_WORKER_MAX_EMPTY_POLLS` safety threshold or allowing a
producer race.

- `asset-request-pipeline.sh` now starts the two-slot worker before ingestion,
  runs the durable issue producer, and creates a unique completion marker only
  after every queue enqueue and ingest-state save has resolved.
- Coordinated drain ignores all pre-completion empty polls. It requires two
  aggregate empty observations after the marker, guaranteeing that at least one
  dequeue began after durable producer completion before the worker exits.
- The workflow uses a 1,000ms coordinated poll. The repeatable real-worker
  benchmark measured **1,015.986ms** against the **2,000ms** hard gate.
- Standalone workers without a producer marker retain the original three
  consecutive empty-poll behavior.
- Provider credentials remain available to the worker and are explicitly
  stripped from the ingestion child.

## Race contract

Deterministic concurrency-two tests cover requests visible before work begins,
after one or many pre-completion empty observations, immediately before producer
completion, between an empty dequeue and its completion-status callback, and
while another slot is processing. Every request is processed and acknowledged
before drain.

The completion marker is the current workflow producer boundary. A direct queue
submission after that marker belongs to the next serialized asset-request
workflow run; it is not treated as concurrent production by the completed run.

## Review findings resolved

The two-round review loop found and fixed five issues:

1. Capture and compare the same brief-lock tail promise so completed unique-key
   locks leave the map instead of leaking.
2. Exercise the exact marker-visible-between-dequeue-and-status race through the
   real concurrency-two worker.
3. Remove the dead `MAX_EMPTY_POLLS` workflow setting from coordinated mode.
4. Fail with an actionable message if the producer marker cannot be written.
5. Prove a skipped request resets the legacy drain counter.

Round 2 was clean. Independent grade by `gemini-3.1-pro-preview` passed with
5/5 for correctness, scope discipline, test coverage, policy compliance, and
maintainability, with zero findings.

## Verification

- `npx vitest run tests/unit/sprites/worker-cli-lib.test.ts tests/unit/sprites/worker.test.ts tests/unit/sprites/asset-request-pipeline.test.ts tests/unit/asset-request-workflow.test.ts --reporter=dot` — 55/55 passed.
- `npx tsx scripts/sprites/worker-drain-benchmark.ts` — baseline 13,926ms;
  optimized 1,015.986ms; threshold 2,000ms; concurrency 2.
- `bash -n scripts/sprites/asset-request-pipeline.sh` — passed.
- `npm run verify:fast` — passed, including 203 changed-path tests.

## Observe before done

This has no visual/gameplay surface. The real artifact is the production worker
loop plus the asset-request workflow coordinator. Before: drain mode waited on
three 5-second empty-poll windows and the measured CI tail was 13,926ms. After:
the real concurrency-two worker exits only after durable producer completion and
a post-completion dequeue, measured at 1,015.986ms.

## Blockers

None.
