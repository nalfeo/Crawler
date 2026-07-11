# Session Handoff: Stop routine pre-PR full verification

## Date

2026-07-11

## Persona

DevOps Engineer

## Systems touched

agent-personas, docs-tooling, mcp-tooling

## Apples

2 apples actual (estimated 1 apple; under-estimated because the conflicting rule also appeared in the review harness and asset-forge agent).

## What Was Done

Removed the unconditional instruction to run full `npm run verify` before committing or creating a PR. The top-level agent instructions, review-harness workflow, code-review reference, and asset-forge agent now consistently require `npm run verify:fast` plus the focused `npm run verify:pr-prereqs` check while leaving the full suite to CI by default.

## Key Decisions Made

- Made the prohibition explicit so agents do not infer a full local run from commit or PR creation.
- Preserved fast verification, lab gating, review-ledger validation, and PR prerequisite checks.
- Retained local full verification for explicit human requests and targeted diagnosis.

## What's Next / Blockers

No blockers.

## Retrospective

### Lessons Learned

- Removing one direct mandate was insufficient because specialist agent and review-harness instructions independently reintroduced the same behavior.

### Mistakes Made

- The initial estimate assumed only the mirrored top-level instructions needed changing.

### Opportunities for Future Improvement

- Add a deterministic documentation check that rejects routine pre-PR full-verify mandates across active agent and skill instructions.
