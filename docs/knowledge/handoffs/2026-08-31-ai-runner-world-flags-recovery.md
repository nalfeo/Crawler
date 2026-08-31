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

Repaired PR #3984 review and CI blockers: inapplicable persisted world-init flags are masked before an AI Runner restart while explicit headless Floor 2 flags remain observable and inert. Flag-control applicability is carried by the registry metadata, and attack-wave documentation correctly describes its live toggle behavior. Added targeted regression assertions, updated the affected source-wiring test, and recorded a passing independent grade for commit `f62559b39a895b7f4550a7d9e28be99ecddc23d0`. Observed through deterministic unit/headless coverage — before: Floor 2’s explicit headless flag was incorrectly cleared; after: it remains set while synthetic lab targets mask inapplicable options.

## Key Decisions Made

- Apply target applicability only while forming the lab’s applied snapshot, preserving explicit headless configuration for inert-but-observable flags.
- Keep UI reload staging separate from the system’s live attack-wave flag semantics.

## What's Next / Blockers

No known implementation blockers. Re-run the PR checks after the consolidated repair push.

## Retrospective

### Lessons Learned

`check:test-only-exports` treats lab-only consumers as test-only for game/AI exports; exposing applicability as metadata on the already production-used control registry avoids a separate lab-only public helper.

### Mistakes Made

The initial repair masked every consumer in `resolveAiFeatureFlags`, which incorrectly cleared an explicit headless Floor 2 attack-wave setting; the real headless gate identified the contract mismatch.

### Opportunities for Future Improvement

The AI Runner lab’s selected-versus-applied state could be covered by a direct deterministic integration harness rather than source-string wiring assertions.
