# Floor and Family Sprite Design Language

## Summary

Added independently optional floor and theme/family design-language addenda to every
sprite prompt surface that reuses Crawler's shared art direction. Authored the approved
Floor 2 copy and all 18 approved family blurbs, with automatic identity-based propagation
to every Floor 2 family mob and boss.

## Systems touched

sprite-pipeline, sprite-workflow

## Persona routing

- Producer held the approved scope and coordinated the 3-apple review process.
- Graphics Designer conventions governed prompt composition and authored art direction.
- QA coverage exercised generation, synthesis, selection, variation, judging, and cache
  behavior without making credentialed provider calls.

## Implementation

- Added `design-language-addenda.ts` as the canonical Floor 2/family copy catalog and
  resolver. Family membership comes from the validated Floor 2 enemy pack rather than a
  second hand-maintained identity map.
- Kept shared design language separate from optional addenda so generation prompts do
  not duplicate the preamble. The no-addendum `contentDirectionBlock(floor)` output
  remains byte-compatible.
- Wired resolved addenda into single/sheet generation, brief synthesis, candidate
  selection, variation expansion, and VLM judging.
- Floor 2 neutral enemies receive the floor addendum but no family addendum. Non-Floor-2
  sprites remain unchanged. Synthesized `-vN` brief names resolve to their canonical
  family identity.
- Added the resolved addenda to the judge cache key and bumped the prompt template
  version so prior judgments cannot be replayed under the new rubric.

## Verification

- Focused sprite suites: 125 tests passed.
- `npm run verify:fast`: 44 files / 632 tests passed, plus typecheck, lint, physics-def
  sync, size coverage, and weight coverage.
- Deterministic request capture confirmed the approved context appears in all five
  prompt paths; no Azure generation was needed because this change affects prompt text,
  not rendered assets.

## Review

- Separate-model plan review found five concerns; all were incorporated before coding.
- Independent code review found one missing selector regression test in round 1.
- Round 2 re-read the complete diff and ended clean across correctness, data flow,
  compatibility, security, runtime/performance, and coverage.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-17-floor-design-language-blurbs.review-ledger.json`

## Apples

3 estimated, 3 actual (exact). The change touched one prompt subsystem across five
existing surfaces, a cache contract, documentation, and focused tests as planned.

## Unresolved issues

None.
