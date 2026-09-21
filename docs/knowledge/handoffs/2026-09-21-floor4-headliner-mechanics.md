# Floor 4 Headliner mechanics runtime

## Date

2026-09-21

## Persona

Producer coordinating Systems Engineer, Game Designer, QA Engineer, and Reviewer concerns.

## Systems touched

enemies, ai-combat-balance, ai-behavior-tree, hud-ux

## Summary

Floor 4's nine authored Headliner abilities were schema-validated and then
discarded, so sampled bosses had zero runtime bindings. The catalog now builds
typed definitions on the existing deterministic mob-ability executor. The Floor
4 scenario registers the selected signature at physical spawn, activates it for
the Headline/Overtime encounter, and clears cues, effects, projectiles, buffs and
generation-owned Showrunner adds on defeat or phase exit.

Every authored signature has its distinct effect: locked luggage impact, mascot
cone lunge, three persistent pyro circles, contracting stunt ring/drop, applause
debuff aura, eight bounded radial projectiles, non-stacking sponsor defense,
full-range fine-print lane, and five capped finale summons. Cone and annulus
geometry are shared by resolution, rendering, and AI counterplay. Procedural VFX
cover all cues and persistent effects. No gear, shop-scoring, wave-density, or
unrelated-floor tuning changed.

## Decisions

- ADR 0109 records shared-runtime ownership, geometry, finale roster, and initial
  qualitative-effect mappings.
- The Showrunner roster is the five authored Act 5 wave archetypes, ordered by
  the continuation of the isolated Headliner RNG stream. Each committed mark is
  checked for full-footprint passability and live-cap capacity; blocked/capped
  marks are skipped without debt or relocation.
- Existing mob-ability owned-entity cleanup is opt-in, generation checked, and
  enabled for Showrunner summons. Floor 2 summon lifetime behavior is preserved.
- Camera bolts expire at the same 28-foot range shown by their committed spokes.

## Verification

- `npm run preflight` — passed with pinned Node 22.23.2.
- `npm run typecheck` — passed.
- Focused ECS/AI/VFX — 203 passed.
- `tests/headless/floor4-headliner-abilities.test.ts` — all nine passed through
  `runHeadless`, plus deterministic Showrunner replay.
- `tests/e2e/floor4-headliner-abilities.deterministic.test.ts` — all nine passed
  in real MainGameScene Chromium; nine telegraph screenshots captured.
- `npm run check:wired-systems` — passed.
- `npm run verify:fast` — passed: 322 files / 4,285 tests plus integrity gates.
- `npm run docs:check` is blocked by the pre-existing ADR 0043 reference to the
  removed `docs/agent-os/policies/complexity-policy.md`; no changed file causes it.
- Guard telemetry was unavailable (`files/guard-telemetry.jsonl` absent).

## Review

Independent review found the summon cleanup, full-range lane, and player-death
teardown hazards; all were addressed before final validation. Fresh Ducky review
reported no actionable regressions in the complete diff.

## Recommended next Floor 4 PR

Proceed to the separately scoped gear scoring / Green Room equipment work using
these now-real boss mechanics as encounter evidence. Keep wave-density tuning in
its later PR and measure it against the production ability-enabled pipeline.
