# Goobers review-thread parity fix

## Summary
This session closed the remaining Lane A parity mismatches for Goobers-owned review-thread reply/resolve behavior. The decision contract now preserves reachable ancestor lineage and follow-up backlog issue mapping in the same shape used by the trusted CI Recovery logic, and the workflow gating assertions were aligned with the live fenced revalidation wording.

## Systems touched
ci-policy

## What changed
- Updated `.github/scripts/goobers-review-threads.mjs` so resolve decisions include reachable ancestor commit lineage when applicable, while keeping the decision layer pure and side-effect-free.
- Kept the follow-up backlog mapping metadata in the decision payload so the workflow can create or reuse the correct issue mapping without guessing.
- Updated `.github/workflows/goobers-review-threads.yml` expectations and revalidation text to reflect the actual live-state check used before each mutating write.
- Added and corrected deterministic coverage in `.github/scripts/goobers-review-threads.test.mjs` and `.github/scripts/goobers-review-threads-workflow-gating.test.mjs` for lineage, stale markers, and follow-up backlog parity.
- Updated the runbook note in `docs/runbooks/ci-mutation-bridge-runbook.md` to match the restored Lane A parity contract.

## Verification
- `node --test .github/scripts/goobers-review-threads.test.mjs .github/scripts/goobers-review-threads-workflow-gating.test.mjs`
- `bash scripts/agent/verify-fast.sh`

## Risk
The change remains intentionally narrow: it only affects the Goobers-owned review-thread Lane A path and keeps the legacy fallback fail-operational. The risk is low because the fix preserves the same trusted-marker and live-state fencing semantics while aligning the contract with the recognized reachable-ancestor behavior.
