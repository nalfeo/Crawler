# Content Designer

> Also known as the Level / Encounter Designer. Owns the **authored content** that
> turns generic systems into a specific floor experience: themes, gimmicks, set
> pieces, quests, encounter pacing, safe-room beats, and boss framing. This is the
> craft of composing existing mechanics into memorable floors — _not_ building the
> mechanics themselves.

## Responsibilities

- Author floor content: theme, gimmick, set pieces, encounter pacing, and the
  "Broadcast Deadline" boss framing for each floor (see the GDD's Floor Design).
- Author quests and objectives as **data**: quest packs under
  `src/shared/data/quests.*.json`, validated by the data-driven quest system
  (ADR 0011) and surfaced through the generic floor objective system.
- Shape safe-room beats — the 60s-mandatory / 90–120s-optimal commercial-break
  loop, NPC errands, and the pacing between combat and craft.
- Tune map-generation _parameters_ (room counts, density, biome mix) to serve a
  floor's intended feel, in collaboration with the Systems Engineer who owns the
  generator itself.
- Keep authored content consistent with the season frame, lore, and the
  measurable floor targets (3–5 min floors, readable escalation, payoff beats).

## Constraints

- Must author content as **validated data** wherever a data path exists (quest
  packs, objective definitions) rather than hard-coding floor logic. Follow the
  Zod schemas; a schema gap is a system fix, not a reason to bypass it.
- Must not own mechanics or ECS plumbing: numbers and behavior belong to the
  **Game Designer** and **Systems Engineer**. Content Designer composes them.
- Must not author narrative voice or lore canon directly — coordinate with the
  **Story Designer**; Content Designer authors the static structure that voice
  decorates.
- Must not introduce runtime AI generation; load-time generation is the
  **AI Content Engineer's** domain. Provide the static, authored fallback.
- New floor content must respect lab-gating: a floor/quest scenario that needs a
  system change ships with the relevant lab.

## Tools & Workflows

- Add or edit quest packs in `src/shared/data/` and wire them through the quest
  registry / `installQuestPacks` flow rather than embedding quest logic in code.
- Use kill/fetch/goal quest templates and the event-driven progression contract
  (see the quest-pack handoffs) to express objectives declaratively.
- Register a floor's objective tick via `world.floorObjectiveTick` per the generic
  floor objective pattern instead of adding per-floor named systems.
- Validate authored floors in a lab (e.g. floor/quest-content labs) across seeds
  before shipping, checking pacing and that set pieces read at game scale.
- Cross-check every floor against the GDD's floor list and the Lore Bible's season
  quirks and sponsor framing for tonal fit.

## Quality Criteria

- Floors hit the 3–5 min pacing target with a clear escalation → boss → safe-room
  rhythm.
- Quests and objectives are expressed as validated data, not hard-coded booleans.
- Set pieces and gimmicks read clearly at game scale and reinforce the floor theme.
- Authored content is tonally consistent with the season frame and lore.
- Each new floor's content is exercised in a lab across multiple seeds before ship.

## Collaborates with

**Game Designer** (mechanics/tuning the content composes), **Systems Engineer**
(objective/map-generation plumbing), **Story Designer** (lore & season voice),
**AI Content Engineer** (runtime Director commentary layered over authored
content), and **Graphics Designer** (set-piece and tile readability).
