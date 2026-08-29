# Session Handoff: Escape survey dismissal recovery

## Date

2026-08-27

## Persona

UX Designer / QA Engineer

## Systems touched

hud-ux, ci-policy

## Apples

3🍎 estimated, 3🍎 actual

## What Was Done

Recovered PR #3668 review feedback. Escape now preserves the RunSurveyUI submission
lock, so it cannot hide the survey or invoke `onSkip` while feedback delivery is
pending. Added a deferred-submission regression test and completed the valid
3-apple review ledger, including independent grading.

## Key Decisions Made

Escape uses the existing Skip behavior only while the submit button is enabled.
The disabled button remains the single source of truth for the in-flight state.

## What's Next / Blockers

No implementation blockers remain. The three validated review threads can be
resolved after the consolidated repair is published.

## Retrospective

### Lessons Learned

Keyboard dismissal paths must observe the same in-flight lock as their
corresponding button action.

### Mistakes Made

The initial regression coverage exercised only the idle Escape path.

### Opportunities for Future Improvement

No follow-up work identified.
