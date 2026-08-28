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
blocking `lifecycle-contracts` CI job. Added ADR 0093. The validator checks
contract fields, rejects unknown versions and malformed inputs, verifies
permissions and exact mutation anchors, and records explicit non-mutation
surfaces.

## Hard gate evidence

`npm run contracts:validate` passes with all six required workflow entries and
all valid/invalid fixtures. No shadow-mode workflow was added or started.
