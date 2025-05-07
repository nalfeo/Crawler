# Session Handoff: Exhaustive Copilot Review Prompt

## Date

2026-07-17

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 exact

## What Was Done

- Added one all-path review contract for native Copilot and harness reviewers. It
  requires a complete-diff inventory, call-site tracing, a fixed category matrix,
  root-cause deduplication, a second related-instance pass, and one consolidated
  findings response.
- Routed the global Copilot instructions to that contract and made it explicitly
  adopt the existing Reviewer persona.
- Replaced the harness's abbreviated prompt with a canonical prompt shared by every
  general reviewer, while documenting that harness agents can select models and native
  GitHub review cannot select one through repository configuration.
- Added source-level regression tests pinning all three review surfaces to the same
  contract.

Observed in `npm run verify:fast` — before: the first test run exposed an assertion
that did not tolerate Markdown line wrapping; after: the robust contract-wiring test
and all 4,140 unit tests passed.

## Key Decisions Made

- Kept one canonical contract under `.github/instructions/` rather than duplicating a
  long checklist across native and harness prompts.
- Used instructions to control native Copilot's persona and method, but did not claim
  repository control over GitHub's underlying review model.
- Kept review probabilistic and CI deterministic: the contract tells reviewers to
  promote recurring findings into tests or gates rather than treating prompt quality
  as a complete correctness guarantee.

## What's Next / Blockers

Track whether valid findings first appearing after round one fall below 10% over the
next 20 reviewed PRs. There are no implementation blockers.

## Retrospective

### Lessons Learned

Crawler already had a strong Reviewer persona, but the executable harness example used
a much weaker one-sentence prompt. Explicitly linking the persona and completeness
contract closes that drift without building another review system.

### Mistakes Made

The first regression assertion expected a prose phrase on one physical line, while
Prettier-compatible Markdown wrapped it. Switching that assertion to whitespace-aware
matching made it verify semantics rather than formatting.

### Opportunities for Future Improvement

If the 20-PR sample misses the target, add structured first-seen-round telemetry to the
review ledger so repeated root-cause classes can be promoted into deterministic gates.
