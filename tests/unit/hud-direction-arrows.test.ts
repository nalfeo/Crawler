import { describe, expect, it } from 'vitest';
import {
  formatWaypointDistance,
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

function labelsOverlap(a: DirectionArrowState, b: DirectionArrowState): boolean {
  return (
    Math.abs(a.labelScreenX - b.labelScreenX) * 2 < a.labelWidth + b.labelWidth &&
    Math.abs(a.labelScreenY - b.labelScreenY) * 2 < a.labelHeight + b.labelHeight
  );
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

  it('keeps long objective labels from overlapping when targets share a direction', () => {
    const states = resolveDirectionArrowStates(
      [
        {
          ...waypoint('welcome', 100, 0),
          label: 'Find the distant Welcome Office proprietor',
        },
        {
          ...waypoint('shop', 100, 0.5),
          label: 'Return the disgusting Rat Tail to the merchant',
        },
        {
          ...waypoint('boss', 100, -0.5),
          label: 'Defeat the dangerous Slime Rat dungeon boss',
        },
      ],
      0,
      0,
      1,
    );

    expect(labelsOverlap(states[0]!, states[1]!)).toBe(false);
    expect(labelsOverlap(states[0]!, states[2]!)).toBe(false);
    expect(labelsOverlap(states[1]!, states[2]!)).toBe(false);
  });

  it('keeps wide labels inside the viewport at the left and right edges', () => {
    const states = resolveDirectionArrowStates(
      [
        {
          ...waypoint('right', 100, 0),
          label: 'Find the distant Welcome Office proprietor and ask for directions',
        },
        {
          ...waypoint('left', -100, 0),
          label: 'Return the disgusting Rat Tail to the merchant before leaving',
        },
      ],
      0,
      0,
      1,
    );

    for (const state of states) {
      expect(state.labelScreenX - state.labelWidth / 2).toBeGreaterThanOrEqual(8);
      expect(state.labelScreenX + state.labelWidth / 2).toBeLessThanOrEqual(1272);
    }
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

  it('fans arrows away from reserved HUD regions', () => {
    const reserved = [{ x: 1080, y: 0, width: 200, height: 340 }];
    const [state] = resolveDirectionArrowStates([waypoint('right', 100, -10)], 0, 0, 1, reserved);

    expect(state).toBeDefined();
    expect(state!.screenY).toBeGreaterThan(340);
  });

  it('compacts long distances and wraps labels into two bounded lines', () => {
    const [state] = resolveDirectionArrowStates(
      [
        {
          ...waypoint('far', 12_345, 0),
          label: 'A very long objective label that cannot fit beside an edge arrow',
        },
      ],
      0,
      0,
      1,
    );

    expect(formatWaypointDistance(12_345)).toBe("12k'");
    expect(state!.labelText).toContain("12k'");
    expect(state!.labelText).not.toContain('...');
    expect(state!.labelText.split('\n')).toHaveLength(2);
    expect(state!.labelText.split('\n').every((line) => line.length <= 36)).toBe(true);
    expect(Math.abs(state!.labelScreenY - state!.screenY)).toBeGreaterThanOrEqual(
      state!.labelHeight / 2 + 19,
    );
  });

  it('hard-splits an overlong single-token objective label', () => {
    const [state] = resolveDirectionArrowStates(
      [
        {
          ...waypoint('far', 12_345, 0),
          label: 'SUPERCALIFRAGILISTICEXPIALIDOCIOUSOBJECTIVETOKENWITHOUTBREAKS',
        },
      ],
      0,
      0,
      1,
    );

    expect(state!.labelText.split('\n').every((line) => line.length <= 36)).toBe(true);
  });
});
