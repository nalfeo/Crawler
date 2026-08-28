# ADR: Keep quest navigation visibility separate from tracker focus

## Status

Accepted

- Date: 2026-08-27

## Context

Issue #3680 requires players to independently enable and disable navigation
arrows for individual quests. The existing `QuestState.tracked` flag identifies
exactly one focused quest, controls its expanded tracker objectives, and
highlights its minimap marker. Reusing it for arrow visibility would change that
single-focus contract.

The change spans quest state/waypoint resolution and engine HUD rendering, so it
requires an ADR under the multi-system policy.

## Decision

Add optional `QuestState.showArrow`. Only an explicit `false` hides a quest from
waypoint output; absent legacy state remains enabled. The HUD's per-quest control
invokes the core toggle helper, while `tracked` remains the independent
single-focused/expanded state.

Waypoint production uses the same visible active-quest cap as the tracker, so
each emitted navigation marker has a rendered toggle. The tracker is docked
below the minimap on all floors. The Floor 2 family panel uses its existing
avoidance mechanism against the tracker bounds.

## Consequences

### Positive

- Players can suppress navigation for one quest without changing the expanded
  quest or other quests' navigation.
- Old in-memory or fixture quest states retain their enabled navigation behavior.
- Tracker controls, full-screen arrows, and minimap waypoint output stay aligned.

### Negative

- `QuestState` has another UI-facing field.
- A disabled quest loses all waypoint projections, not only the full-screen
  arrow; the control is therefore labeled as navigation state.

## Alternatives Considered

- **Reuse `tracked`:** rejected because selecting a focused quest would
  unintentionally remove all other quest navigation.
- **Keep arrows enabled for tracker-hidden quests:** rejected because those
  arrows would not have a corresponding player control.
- **Move the family panel with new bespoke layout math:** rejected because the
  existing runtime avoidance hook already relocates it from the new tracker
  bounds without another layout contract.
