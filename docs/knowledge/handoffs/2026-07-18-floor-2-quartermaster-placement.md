# Handoff: Floor 2 Quartermaster Placement

## Date

2026-07-18

## Persona

Systems and Game Designer implementation coordinated through Producer, with
independent Reviewer passes.

## Systems touched

mapgen, inventory, ci-policy

## Apples

3 apples estimated, 3 apples actual (exact). The work combined deterministic
shop selection, settlement-capacity search, rollback-safe map mutation, real
runtime evidence, and the full 3-apple review harness.

## Stack

- Child issue: #1288
- Base branch: `nalfeo-floor-2-equipment-contracts`
- Dispatch and final verified remote base head:
  `4c11335a281842f82d206a4c42b23a28e2f40e91`
- Branch: `nalfeo-floor-2-quartermaster-placement`
- Canonical lifecycle remains `blocked`; this is speculative `STACKED-WORK`
  evidence only.
- No canonical PLAN or epic-state files were edited.

## Summary

- Removed the Quartermaster from the random Floor 2 shop candidate pool.
- Guaranteed exactly one Quartermaster plus the legacy seeded one or two
  non-Quartermaster shops.
- Preserved the legacy world-RNG shop inventory draw stream; only supplemental
  shop inventory uses a derived deterministic stream.
- Replaced greedy placement and silent door-buffer relaxation with a
  deterministic capacity-aware backtracking search over passable, reachable
  settlement tiles.
- Computes placement against the final sealed-door topology, enforces strict
  three-tile NPC spacing and a one-tile door buffer, and restores room roles,
  doors, terrain, and flags if capacity preflight fails.
- Added loader validation requiring exactly one configured Quartermaster.
- Added unit, generated-layout property, integration, headless, and browser
  coverage plus additive main-scene probe fields.

## Runtime evidence

The real `runHeadless(..., { floorId: "floor2", maxFrames: 1 })` pipeline was
captured for seeds 1-8 before and after the change.

- Before: seeds 3 and 6 spawned zero Quartermasters. Seed 6 had two settlement
  rooms and two non-Quartermaster shops.
- After: all eight seeds spawned exactly one Quartermaster plus one or two
  non-Quartermaster shops.
- After: all 21 shops were reachable from the player spawn and every shop was
  more than one tile from every final settlement door.
- After: seed 6 retained its two-room topology and fit three total shops.
- Evidence artifacts:
  `files/quartermaster-before.json` and `files/quartermaster-after.json` in the
  session artifact directory.

## Review

- Plan review, `gpt-5.4`: four concerns resolved with minor divergence,
  clarifying selection order, failure atomicity, RNG compatibility, and stressed
  real-pipeline layouts.
- Code review round 1, `claude-sonnet-5`: found placement was using the pre-seal
  door list and that coverage did not exercise final-door spacing. Fixed by
  seal-then-place with exact rollback and generated-layout final-door checks.
- Code review round 2, `claude-sonnet-5`: runtime logic clean; strengthened the
  property test from 8 to 60 valid generated layouts.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-17-floor-2-quartermaster-placement.review-ledger.json`

## Validation

- Targeted unit, property, integration, and headless tests: 20 passed.
- Browser `MainGameScene` Quartermaster test: passed.
- Generated-layout property gate: 60 valid layouts passed.
- Explicit ESLint over every changed TypeScript file: passed.
- `npm run verify:fast`: passed, including 515 unit tests.
- `npm run verify:pr-prereqs`: passed.
- `npm run epic:status -- floor-2-equipment --github --json`: valid schema,
  zero errors/warnings, expected blocked release lifecycle, no writes.
- Review ledger validation: passed.

## Follow-up

- Publish a ready, non-draft PR targeting
  `nalfeo-floor-2-equipment-contracts`.
- Do not merge or arm auto-merge while the canonical lifecycle is blocked.
- The Producer must reconcile the speculative stacked-work record when
  prerequisites validate.
