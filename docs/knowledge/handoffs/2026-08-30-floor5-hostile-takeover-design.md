# Session Handoff: Floor 5 — Hostile Takeover design

## Date

2026-08-30

## Persona

Producer → Content Designer, Systems Engineer, Game Designer

## Systems touched

mapgen, quests, enemies, ai-pathfinding, ai-behavior-tree, ai-combat-balance, boss-rooms, hud-ux

## Apples

3🍎 estimated, 3🍎 actual (exact; docs-only design package for a separate 5🍎 epic)

## What Was Done

Authored the complete Floor 5 planning package. No runtime code, game data, or assets changed.

- `docs/knowledge/game-design/floor5-hostile-takeover.md` defines the lore, plot,
  Director voice, battlefield, field tasks, enemy Heroes, Ratings Ram, breach, throne
  finale, presentation, and player-facing failure/victory beats.
- `.specify/specs/floor5-hostile-takeover.md` defines the deterministic runtime contract,
  phase and same-tick terminal ordering, explicit teams, minion/Hero ownership boundaries,
  task/build state, engine lifecycle, atomic breach transaction, headless strategy, and
  human-gated balance targets.
- `docs/knowledge/adr/0094-floor5-hostile-takeover.md` records the cross-system decisions
  and rejected alternatives.
- `docs/knowledge/epics/floor-5-hostile-takeover/floor-5-hostile-takeover.epic.json`
  materializes eight dependency-ordered implementation slices after its exact-revision
  human review issue is approved.
- Canonical spec, GDD, lore, and ADR indexes now register Floor 5.

Runtime/real-artifact observation: design-only session; there is no changed runtime artifact
to observe. Every behavioral epic slice instead names a windowed or headless real-pipeline
done condition, and the presentation slice requires deterministic real-game captures.

## Key Decisions Made

- **One primary lane plus two task pockets** delivers MOBA push/pull without tripling
  autonomous pathing and camera complexity.
- `siegeDirectorSystem` owns only phase/latch/manifest authority;
  `siegeMinionSystem` and `siegeHeroSystem` own stable strategic decisions while existing
  systems retain navigation, attacks, and damage.
- The Command Post is a combat objective, not a safe room. Same-tick terminal loss resolves
  before breach or capture progress.
- Construction uses floor-scoped requisition milestones. MVP proves one full engine, the
  Ratings Ram, including destruction and deterministic rebuild.
- Breach is an atomic phase/navigation/collision transaction; missing wall art or entity
  absence is never authoritative.
- Regent defeat enables a separate throne-capture interaction instead of auto-completing the
  floor.
- Exact duration, completion rate, Hero pressure, recovery cost, and performance budgets
  remain HUMAN_GATE decisions backed by representative sweep evidence.

## What's Next / Blockers

- A human must review the epic revision and close its generated review issue as completed
  before any node materializes.
- During review, explicitly approve or amend the terminal rules, rebuild model, capture
  interaction, Hero cadence, duration/completion targets, and performance budgets.
- After approval, start slice 1 only. Slices 2 and 3 then branch in parallel; all later
  dependencies are encoded in the epic file.
- No implementation blocker is currently known, but allied objective pathing and the atomic
  breach transaction are the highest technical risks and must be proven headlessly before
  presentation or balance work.

## Retrospective

### Lessons Learned

The Floor 4 precedent was valuable, but reusing its high-level shape would have hidden Floor
5's new ownership seams. A separate plan review caught three concrete gaps before authoring:
presentation needed dependencies on every system it depicts, Hero behavior depends on field
tasks, and the wall breach needed an explicit cleanup/navigation handoff to the throne slice.

### Mistakes Made

The deterministic Producer decomposition did not recognize the confirmed prose hard gate and
reported `MISSING`; treating generated output as authoritative would have blocked a valid
design. The early signal was that the prompt literally contained “hard gate” while the parser
still omitted it. The session therefore used the human-confirmed condition as the contract
and manually validated the final DAG rather than weakening or inventing another gate.

### Opportunities for Future Improvement

The generic Producer decomposer could accept an explicit structured `--hard-gate` argument so
complex approved contracts are not lost to request-text heuristics. Epic authoring would also
benefit from a documented local validate-only command instead of relying on test-suite
knowledge of the internal loader.
