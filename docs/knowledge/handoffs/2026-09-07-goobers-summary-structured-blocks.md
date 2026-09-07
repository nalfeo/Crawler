# Session Handoff: Goobers summary blocks for issue-close-out output

## Date

2026-09-07

## Persona

QA Engineer

## Systems touched

ci-policy,mcp-tooling,docs-tooling

## Apples

3🍎 estimated

## What Was Done

Wired the Goobers `implement.summary` output into all three issue close-out branches (`in-review`, `needs-human`, and `needs-remediation`) via `inputsFrom`, which is how the pinned runner injects `GOOBERS_INPUT_SUMMARY`. The stages stay direct `goobers issue-close-out` commands: they hold `github:issues:write`, and a `script` both drops the operational run context the built-in needs and would execute branch-authored code with that credential in scope.

The structured requirement lives in a new, separate contract, `crawler.goobers.summary/v1` (`summarySemanticErrors()`), which demands four ordered, non-empty sections: `Description`, `Systems`, `Verification`, and `Risk`. `crawler.goobers.output/v1` keeps its original "non-empty string" summary semantics so in-flight v1 outputs stay valid. The coder instructions now specify the block so the summary is produced correctly upstream, before any credential is in scope.

Observed in the deterministic workflow contract test and `node .github/scripts/validate-goobers-contracts.mjs` — before: the close-out task had no summary source; after: all terminal close-out branches declare `implement.summary` as a runtime input and the summary contract is enforced by fixtures plus unit coverage for empty-section, out-of-order, and non-string summaries.

## Key Decisions Made

- Defaulted to an ordered four-line labelled block (`Description`, `Systems`, `Verification`, `Risk`) instead of a freeform sentence so the final comment is both readable and machine-checkable.
- Kept the machine-readable output compact while raising the human-facing summary quality to match the issue acceptance criteria.
- Reused the existing contract validator, but expressed the new rule as its own `crawler.goobers.summary/v1` contract rather than tightening `crawler.goobers.output/v1`, to honor the v1 compatibility policy in `.goobers/README.md`.
- Enforced the block at the production point (coder instructions + contract fixtures) instead of inside the credentialed close-out stage, keeping branch-authored code out of any stage holding `github:issues:write`.

## What's Next / Blockers

Residual gap: the structured block is enforced at the production point (coder
instructions) and by the contract fixtures/unit tests, not by a stage inside the
running workflow. Runtime enforcement was deliberately not added inside the three
close-out stages because they hold `github:issues:write`, and a capability-free
pre-review stage was rejected as well because `implement` is required to hand
straight to the review gate (the previous `checkpoint-branch` stage between them
was removed on purpose and `goobers-run-workflow.test.ts` pins that shape). If
the pinned runtime later grows an output-validation hook for agentic task
results, `summarySemanticErrors()` should be attached there.

## Retrospective

### Lessons Learned

The repo already had the right validation architecture; the missing piece was simply enforcing a structured summary at the semantic-contract layer instead of leaving it as an informal convention.

### Mistakes Made

None significant.

### Opportunities for Future Improvement

If the Goobers runtime later emits final comments from a separate producer binary, the same contract should be mirrored there so the host-side and runtime-side summaries stay in lockstep.
