# Floor 4 achievement catalog

## Systems touched

achievements

## Persona

Content Designer with Producer coordination

## Apples

2🍎 estimated, 2🍎 actual — exact. The slice added a data-driven catalog and
extended the existing shared fact contract without introducing a new gameplay
system.

## Outcome

Added 30 Floor 4 achievements covering the timed arena's waves, Headliners,
acts, Green Room visits, overtime, act income, carried Companion co-stars, and
the Winner's Circle clear. Rewards use the standard 5/12/8/5 trash/common/
uncommon/rare ladder, with difficulty bands aligned to those tiers. Every
unlock rule references a measured fact emitted by the production
`collectCurrentFloorAchievementFacts` path. Green Room reach facts now use the
monotonic opened-visit index, so they unlock during the active visit rather
than after its retirement; act-income achievements explicitly describe
cumulative earnings.

## Evidence

- `npm run typecheck`
- `npx vitest run tests/unit/achievements.test.ts tests/unit/achievement-floor4-facts.test.ts tests/property/achievement-facts-properties.test.ts`
- `bash scripts/agent/verify-fast.sh`
- The deterministic Floor 4 fact test configures the real `floor4` scene
  options, populates production `Floor4ArenaState` telemetry and Green Room
  lifecycle state, then evaluates the production achievement system before and
  after the arena reaches its `VICTORY` phase.
- The same production-system test observes `floor4-commercial-break` unlocking
  during the first opened Green Room visit, before that visit is retired.
- The catalog test enforces the 2–4 / 4–8 / 8–12 / 12–20 Director-flavor
  sentence ranges for basic / standard / hard / brutal achievements.
