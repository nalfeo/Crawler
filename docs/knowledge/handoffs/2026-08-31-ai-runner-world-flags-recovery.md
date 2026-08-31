# Session Handoff: AI Runner World Flags Recovery

## Date

2026-08-31

## Persona

Game Designer → QA Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

3🍎 exact

## What Was Done

Repaired PR #3984 review and CI blockers: inapplicable persisted world-init flags now resolve to false before an AI Runner restart, flag-control applicability is carried by the production-used registry API, and attack-wave documentation correctly describes its live toggle behavior. Added targeted regression assertions, updated the affected source-wiring test, and recorded a passing independent grade for commit `56ae19da9268dbf355b6f4bd14ebb0ca1181105f`. Observed through deterministic unit/headless coverage — before: synthetic contexts retained enabled world-init options; after: resolution masks both options.

## Key Decisions Made

- Apply target applicability during feature-flag resolution so the UI snapshot and non-UI consumers share one masking rule.
- Keep UI reload staging separate from the system’s live attack-wave flag semantics.

## What's Next / Blockers

No known implementation blockers. Re-run the PR checks after the consolidated repair push.

## Retrospective

### Lessons Learned

`check:test-only-exports` treats lab-only consumers as test-only for game/AI exports; exposing applicability as metadata on the already production-used control registry avoids a separate lab-only public helper.

### Mistakes Made

The initial repair changed the Feature Flags loop signature but missed a source-string assertion in `ai-runner-merchant-weapon-wiring.test.ts`; `verify:fast` surfaced and the assertion was updated.

### Opportunities for Future Improvement

The AI Runner lab’s selected-versus-applied state could be covered by a direct deterministic integration harness rather than source-string wiring assertions.
