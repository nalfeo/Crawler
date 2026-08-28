---
title: Lifecycle mutation contracts and single-writer inventory
date: 2026-08-28
---

## Verdict

recommended — the phase is a bounded governance foundation and does not alter
runtime mutation behavior.

## Apples

🍎🍎🍎 estimated, 3 actual — tooling-only cap.

## Systems touched

ci-recovery, merge-train, goobers

## Changes

Added v1 invocation/decision schemas, valid and malformed fixtures, and the
machine-readable six-workflow mutation inventory under `.github/contracts/`.
Added `scripts/agent/contracts/validate-lifecycle-contracts.mjs` and the
blocking `lifecycle-contracts` CI job. Added ADR 0093. The validator loads and
enforces both committed schemas, rejects unknown nested properties and
malformed fail-closed errors, binds normalized resource identity and
idempotency keys, validates strict invariant fixture shapes, and checks direct
mutation implementation call sites in addition to workflow anchors.

## Hard gate evidence

`npm run contracts:validate` and `bash scripts/agent/verify-fast.sh` pass with
all six required workflow entries, direct mutation owners, and valid/invalid
fixtures. No shadow-mode workflow was added or started. This repass addresses
the review findings from `.goobers/context/06-review.verdict`.
