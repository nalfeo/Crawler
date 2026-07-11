import { describe, expect, it } from 'vitest';
import {
  resolveDirectionArrowStates,
  type DirectionArrowState,
} from '../../src/engine/HudDirectionArrows.js';
import type { QuestWaypoint } from '../../src/core/systems/questWaypoints.js';

function waypoint(
  questId: string,
  x: number,
  y: number,
  kind: QuestWaypoint['kind'] = 'npc',
): QuestWaypoint {
  return { questId, x, y, kind, label: questId };
}

function distance(a: DirectionArrowState, b: DirectionArrowState): number {
  return Math.hypot(a.screenX - b.screenX, a.screenY - b.screenY);
}

describe('resolveDirectionArrowStates', () => {
  it('returns one distinct arrow state per off-screen quest waypoint', () => {
    const states = resolveDirectionArrowStates(
      [
        waypoint('welcome', 100, 0),
        waypoint('shop', 100, 1, 'item'),
        waypoint('boss', 100, -1, 'combat'),
      ],
      0,
      0,
      1,
    );

    expect(states.map((state) => state.questId)).toEqual(['welcome', 'shop', 'boss']);
    expect(distance(states[0]!, states[1]!)).toBeGreaterThanOrEqual(48);
    expect(distance(states[0]!, states[2]!)).toBeGreaterThanOrEqual(48);
    expect(distance(states[1]!, states[2]!)).toBeGreaterThanOrEqual(48);
  });

  it('omits waypoints whose targets are already on screen', () => {
    const states = resolveDirectionArrowStates(
      [waypoint('nearby', 1, 1), waypoint('far', 100, 0)],
      0,
      0,
      1,
    );

    expect(states.map((state) => state.questId)).toEqual(['far']);
  });
});
