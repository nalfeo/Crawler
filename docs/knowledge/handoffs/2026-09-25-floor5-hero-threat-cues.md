# Session Handoff: Floor 5 Field Hero threat cues

## Date

2026-09-25

## Persona

Producer coordinating the bounded Slice 7 presentation follow-up.

## Systems touched

Floor 5 scenario HUD presentation, Field Hero lifecycle projection, headless
Hero lifecycle coverage, and MainGameScene presentation evidence.

## Recommendation and planning contract

**Recommended.** After merged objectives (#4659), objective-driven escalation
(#4712), and Command Post danger cues (#4720), the direct remaining readable
siege consequence was the field Hero lifecycle. This adds no ECS system,
mechanic, tuning, player movement, equipment decision, RNG draw, or combat
authority.

Hard gate: an identical committed Floor 5 Hero state yields identical
non-color-only text and cue IDs; inactive/captured states emit no Hero cue; the
headless pipeline and the real MainGameScene each observe deployment and defeat
presentation. Ranked tiebreakers: determinism, independent runtime evidence,
then minimal scope.

The Producer decomposer still classified the explicit measurable contract as
missing, so it was not used as a readiness authority and no delegation occurred.

## What changed

- The existing Floor 5 HUD line now names an active field Hero, its tactical
  role, and health; an actual defeat reads as a named defeat with replacement
  pending. Pending, exhausted, defeat, and capture states remain explicit.
- Stable, role-card-derived audio/VFX cue IDs announce a named Hero deployment
  or defeat. Terminal capture and Command Post defeat suppress Hero cues.
- Existing generic HUD cue deduplication remains the one-shot authority; no new
  player-facing or engine code path was introduced.

## Observation and verification

- Baseline: `tests/headless/floor5-hero-roster.test.ts` (8 tests) and
  `tests/unit/floor5-presentation.test.ts` (6 tests) passed before the change.
- Headless: `npm test -- --project headless tests/headless/floor5-hero-roster.test.ts`
  passed (8 tests). It observes named active/dead text and stable cue prefixes
  at the real floor objective tick around the ordinary damage-authority path.
- Unit projection: `npm test -- tests/unit/floor5-presentation.test.ts` passed
  (7 tests), including capture suppression.
- Real scene: `npm run test:e2e -- tests/e2e/main-game-scene-floor5-combat.test.ts -t sword`
  passed (1 test, 4 filtered). The live HUD showed the Field Hero active state
  and the deployment cue while retaining the existing 1280×720 and 960×540
  layout checks.
- `npm run typecheck:src`, Prettier, and `git diff --check` passed.
- `npm run scope` selected simulation, integration, and visual validation.
- `npm run verify:fast` and `npm run verify:pr-prereqs` were run before
  publication; pre-publish sync reported the branch already contains
  `origin/main`.
- Fresh local Ducky complete-diff review against `origin/main` reported no
  actionable findings; okay to check in.

## Review and risk

This is a routine, reversible projection through the already accepted
`ScenarioHudSnapshot` bridge. It is neither an architectural boundary change
nor a gameplay/determinism/security/data-loss/release-risk change, so no
additional independent review is required by the change-risk policy.

## Retrospective

### Lessons Learned

The Hero card already carried the display name, role, and lifecycle facts
needed for accessible presentation. Reusing that committed state avoided a
second Hero registry or a renderer-specific branch.

### Mistakes Made

The fresh-worktree dependency bootstrap initially left partial dependencies and
no executable links. An elevated preflight completed the locked install before
validation.

### Opportunities for Future Improvement

Later Slice 7 work can add authored visual/audio assets behind these stable cue
identities without changing deterministic siege state or the generic HUD bridge.
