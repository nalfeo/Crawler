# Handoff: one coordinating PR memory record

## Summary

Extended the existing PR preflight guard to reject multiple newly-added dated
handoff files or Apple estimate records in one PR while preserving the
docs-only/dependency-only handoff exemption and the 1–2🍎 no-record exception.
Updated the canonical policy and guard documentation and added ADR 0105.

## Systems touched

agent-tooling, memory-governance

## Files touched

- `.github/extensions/copilot-guards/guards/pr-preflight.mjs`
- `.github/extensions/copilot-guards/tests/pr-preflight.test.mjs`
- `.github/extensions/copilot-guards/README.md`
- `docs/agent-os/policies/complexity-policy.md`
- `docs/agent-os/policies/memory-policy.md`
- `docs/knowledge/adr/0105-pr-memory-record-cardinality.md`
- `docs/knowledge/handoffs/2026-09-07-pr-memory-record-cardinality.md`
- `docs/knowledge/metrics/apples/2026-09-07-pr-memory-record-cardinality.json`

## Verification run

- `bash scripts/agent/preflight.sh`
- `node --test .github/extensions/copilot-guards/tests/pr-preflight.test.mjs`
- `npm run verify:pr-prereqs`
- `bash scripts/agent/verify-fast.sh`

## Apples

Estimated 3🍎, actual 3🍎, 🎯 Exact. The implementation stayed within the
planned tooling-only guard, test, policy, and ADR scope.

## Unresolved issues

None.

## Recommended next steps

Run the required independent 3🍎 post-diff review before publication.
