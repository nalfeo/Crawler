# Handoff: CI-recovery / merge-train harness holistic review

## Date

2026-07-24

## Persona

Producer / DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 (analysis + documentation only). Docs-only artifact — review-ledger
exempt. No runtime code changed, so no `apples:record` JSON is required by
the complexity policy; recorded here for the audit trail.

## Summary

Landed `docs/knowledge/ci-recovery/2026-07-20-harness-holistic-review.md`, a
holistic review of the CI-recovery / merge-train reconciliation harness written
as the precursor to a simplification redesign. It maps the system **as it exists
on `main` today** and does not change any behavior.

Key findings:

- The "merge train" is actually **three independent distributed state machines**
  (CI-owner lease, merge-train queue, conflict ordering) bolted onto the same
  PRs and coordinated entirely through **GitHub labels + base64url-in-a-comment**,
  with **no authoritative owner** of a PR's lifecycle. This multi-writer /
  no-owner topology is the structural root cause of the recurring deadlocks.
- Scale: **≈13,685 non-test LOC** across 36 modules + 10 workflows. The single
  hottest file, `reconcile.mjs`, is a **2,232-LOC linear decision cascade** with
  34 decision points, 29 `process.exit(0)`, and 14 `release()` calls; the
  stale-lease GC sits ~975 lines below owner-blind short-circuit exits — the
  mechanism behind the 37h lock deadlock (#1833).
- A **D1–D10 deadlock taxonomy** ties each observed stall to a specific
  over-complexity. D1/D5/D6/D9 are the **same disease**: state advanced only
  *inside* a reconcile pass, guarded by owner-blind early exits, with no
  independent liveness sweep. **D3 (review-wake ≠ repair-wake) is the biggest
  still-open gap.**
- **§6 catalogs what is working and must be preserved** (global router
  serialization + load-aware budget, review-round throttle, per-PR concurrency,
  `expected_head_sha` fail-closed binding, the large characterization-grade test
  suite).
- **§7 gives 7 prioritized simplification directions** with a sequencing
  ((1)+(4) → (2)+(3) → (5)+(6)+(7)) that seeds the redesign epic.

## Files touched

- `docs/knowledge/ci-recovery/2026-07-20-harness-holistic-review.md` (new) —
  the review + two mermaid diagrams (the three-FSM state model and workflow
  topology). Authoring date 2026-07-20 retained in the filename/header.

## Observe / verify

Docs-only. No runtime pipeline, lab, or headless artifact is affected. Rendered
the two mermaid fences to confirm they parse (hardened earlier to avoid literal
`\n`/`→`/`@`/`#` inside fences). `verify:fast` scope classifies this as
`docs_only`.

## Follow-up

This document is the design source for a redesign **epic** (GitHub parent issue +
9 child issues) built directly from §4 (D-classes), §6 (must-preserve
invariants), and §7 (the 7 directions). The epic uses GitHub-native sub-issues +
`Blocked by #N` dependency wiring rather than the `epic-state.json` control plane,
which is hard-wired to `floor-2-equipment` in `epic-status-lib.ts` and cannot host
a second epic without a substantial (complexity-adding) tooling change.
