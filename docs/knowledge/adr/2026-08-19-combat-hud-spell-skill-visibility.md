# ADR: Combat HUD spell-skill visibility via HudSkillTracker extension

## Status

Accepted

- Date: 2026-08-19

## Context

Issue #3143 reported that the "combat skills" HUD (`src/engine/HudSkillTracker.ts`)
only surfaces the active weapon's class/type skill. Spell skills (e.g.
`spell-fireball`) level up silently in the background with **no UI anywhere
in the game** showing their level or progress. This diff spans two
architectural layers — `src/engine` (the HUD widget + new pure helper) and
`src/game` (the skill registry refactor) — so it needs an ADR per the
2+-system rule.

## Decision

Extend the existing always-visible `HudSkillTracker` widget with up to 2
additional rows for the player's currently-equipped spells' skills, instead of
building a new full-screen "Skills" overlay or extending the safe-room
abilities modal. Both alternatives were rejected because the issue explicitly
names the **combat** skills UX as the gap, and neither alternative is visible
during combat.

To keep `src/engine` free of `src/game` imports (layer rule), the one usage-
threshold curve shared by all 10 Floor 1 spell skills was hoisted from
`src/game/skills/registry.ts` into `src/shared/spell-skills.ts` as
`SPELL_SKILL_THRESHOLDS`, mirroring the existing
`CLASS_SKILL_THRESHOLDS`/`TYPE_SKILL_THRESHOLDS` pattern in
`src/shared/weapon-skills.ts`. `registry.ts` now consumes the same constant
instead of a duplicated literal, so there remains exactly one source of truth
for the curve.

The new spell rows are added to a **fixed-size** panel (`PANEL_H` grows by 2
row-heights unconditionally; unused rows are hidden via `setRowVisible`)
rather than a dynamically-resized one, because the panel's parent HUD group
(`bottomLeft` in `HudUI.ts`) measures its bounds exactly once at scene-load
(`getBounds()`), before the first `applyScale()`. A per-frame-resized panel
would break that one-time measurement.

Because the equipped-active-ability slot limit (`ACTIVE_ABILITY_SLOT_LIMIT =
10`) is larger than the 2 reserved rows, a `+N` overflow indicator was added
to the panel's title strip (computed via a new uncapped
`countMatchingSpellSkills` helper) so a player with more than 2 trackable
equipped spells sees the cap rather than having skills silently disappear.

## Consequences

### Positive

- Every spell skill's level/progress is now visible somewhere in the game,
  closing the issue's reported gap, without a new UI surface to build and
  maintain.
- All row-rendering and progress-bar math is reused unchanged from the
  existing weapon-skill rows — no new rendering logic to get wrong.
- The threshold curve has exactly one source of truth
  (`SPELL_SKILL_THRESHOLDS`), enforced by a new regression test
  (`tests/game/skill-registry.test.ts`) that fails if a future spell skill's
  `usageThresholds` ever diverges from it.

### Negative

- Only 2 of the player's equipped trackable spells get a full row at a time;
  the rest are only represented by the `+N` overflow count, not their own
  level/progress.
- The panel reserves fixed vertical space for 2 spell rows even when the
  player has equipped 0 or 1 spells, slightly taller than the pre-existing
  2-row weapon-only panel at all times.

### Risks

- If a future spell skill needs a divergent threshold curve, both
  `HudSkillTracker.ts` (which reads `SPELL_SKILL_THRESHOLDS` directly) and the
  registry test must be updated together. Mitigated by the added regression
  test failing loudly rather than silently rendering wrong progress bars.

## Alternatives Considered

- **New full-screen "Skills" overlay** (like `AchievementsUI`): comprehensive,
  but only accessible outside combat — doesn't address the issue's literal
  "combat skills ux" gap.
- **Extend the safe-room abilities modal**: same combat-inaccessibility
  problem as above.
- **Expandable/pageable tracker** (scroll or paginate through all equipped
  spell skills): would scale past 2 rows, but adds input/state complexity for
  a compact always-on combat HUD; rejected as unnecessary complexity for what
  is an edge case (3+ simultaneously equipped trackable spells) in current
  Floor 1 balance, especially once the `+N` overflow indicator makes the cap
  visible instead of silent.
- **Per-slot skill indicators on `HudAbilityBar`**: every equipped spell could
  show its own skill state directly on its ability-bar slot; rejected because
  ability-bar slots are already tight on space (icon, cooldown ring, key
  label) and adding skill-progress text risks clutter.
