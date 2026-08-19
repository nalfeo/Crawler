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

  it('omits an NPC 9 feet away at BASE_ZOOM (zoom=2, the real game zoom on a 1x display)', () => {
    // Regression: camera.zoom = BASE_ZOOM * renderScale; the sync() caller must
    // divide by renderScale so the on-screen check sees design-space pixels.
    // At zoom=2 (design-space), an NPC 9 feet above the player occupies
    // 360 - 9*16 = 216 design-px from the top — well within the safe zone.
    const states = resolveDirectionArrowStates(
      [waypoint('goon', 0, -9)],
      0,
      0,
      2, // BASE_ZOOM = 2.0
    );

    expect(states).toHaveLength(0);
  });

  it('fans arrows away from reserved HUD regions', () => {
    const reserved = [{ x: 1080, y: 0, width: 200, height: 340 }];
    const [state] = resolveDirectionArrowStates([waypoint('right', 100, -10)], 0, 0, 1, reserved);

    expect(state).toBeDefined();
    expect(state!.screenY).toBeGreaterThan(340);
  });

  it('keeps crowded right-side arrows pinned to the right edge through later fan attempts', () => {
    const states = resolveDirectionArrowStates(
      Array.from({ length: 8 }, (_, index) => waypoint(`right-${index}`, 100, 0)),
      0,
      0,
      1,
    );

    expect(states).toHaveLength(8);
    for (const state of states) {
      expect(state.screenX).toBeCloseTo(1280 / 2 + (1280 / 2 - 96), 0);
    }
  });

  it('never fans an arrow onto the opposite side of the screen from where it points', () => {
    // Regression: a strongly right-pointing target parked on the top/bottom
    // edge used to be fanned past screen centre by crowding/HUD avoidance and
    // ended up left of the player while still pointing right.
    const reserved = [{ x: 1000, y: 560, width: 280, height: 160 }];
    const states = resolveDirectionArrowStates(
      Array.from({ length: 6 }, (_, index) => waypoint(`se-${index}`, 60 + index, 100)),
      0,
      0,
      1,
      reserved,
    );

    expect(states).toHaveLength(3);
    for (const [index, state] of states.entries()) {
      // All targets are down-and-right: the arrow must stay right of centre.
      expect(state.screenX).toBeGreaterThanOrEqual(640);
      expect(state.screenX + 11 + 6).toBeLessThan(reserved[0]!.x);
      expect(state.labelScreenX + state.labelWidth / 2 + 6).toBeLessThan(reserved[0]!.x);
      for (const other of states.slice(index + 1)) {
        expect(
          Math.hypot(state.screenX - other.screenX, state.screenY - other.screenY),
        ).toBeGreaterThanOrEqual(48);
        expect(
          Math.abs(state.labelScreenX - other.labelScreenX) * 2 >=
            state.labelWidth + other.labelWidth + 12 ||
            Math.abs(state.labelScreenY - other.labelScreenY) * 2 >=
              state.labelHeight + other.labelHeight + 12,
        ).toBe(true);
      }
    }
  });

  it('omits an arrow when its direction-locked edge range is entirely reserved', () => {
    const reserved = [{ x: 640, y: 560, width: 640, height: 160 }];
    const states = resolveDirectionArrowStates(
      [waypoint('se-blocked', 60, 100)],
      0,
      0,
      1,
      reserved,
    );

    expect(states).toHaveLength(0);
  });

  it('keeps an arrow visible when only its label region is reserved', () => {
    const reserved = [{ x: 1000, y: 130, width: 160, height: 300 }];
    const states = resolveDirectionArrowStates(
      [
        {
          ...waypoint('ne-label-blocked', 100, -36),
          label: 'Find the distant Welcome Office proprietor',
        },
      ],
      0,
      0,
      1,
      reserved,
    );
    expect(states).toHaveLength(1);
    const [state] = states;
    const [region] = reserved;
    expect(state!.screenX).toBeGreaterThan(region!.x + region!.width);
  });

  it('keeps a down-left arrow on the left half of the screen', () => {
    const states = resolveDirectionArrowStates(
      Array.from({ length: 6 }, (_, index) => waypoint(`sw-${index}`, -60 - index, 100)),
      0,
      0,
      1,
    );

    expect(states).toHaveLength(5);
    for (const state of states) {
      expect(state.screenX).toBeLessThanOrEqual(640);
    }
  });

  it('keeps a slightly up-right arrow in the upper half of the right edge', () => {
    const states = resolveDirectionArrowStates(
      Array.from({ length: 6 }, (_, index) => waypoint(`ne-${index}`, 100, -30 - index)),
      0,
      0,
      1,
    );

    expect(states).toHaveLength(3);
    for (const state of states) {
      expect(state.screenX).toBeCloseTo(1184, 0);
      expect(state.screenY).toBeLessThanOrEqual(360);
    }
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

  it('keeps an arrow on the same screen edge when the target angle varies slightly', () => {
    // Regression: with the old ellipse approach a target that is far to the
    // right but slightly above/below the player's y could produce arrows at
    // different x-positions as the player moved. The rectangle-edge approach
    // pins every arrow with |dy| << |dx| to the RIGHT boundary (x ≈ GAME.WIDTH
    // - RING_INSET).  All three targets are to the right; only their y-offset
    // differs by small amounts. All arrows must share the same side (x > CX).
    const RIGHT_EDGE_X = 1280 / 2 + (1280 / 2 - 96); // CX + RX = 1184
    const targets = [
      waypoint('t1', 100, 0.01), // almost horizontal right, tiny positive dy
      waypoint('t2', 100, -0.01), // almost horizontal right, tiny negative dy
      waypoint('t3', 100, 0), // exactly horizontal right
    ];
    const states = resolveDirectionArrowStates(targets, 0, 0, 1);

    expect(states).toHaveLength(3);
    for (const state of states) {
      // All arrows must be on the right half of the screen (x > CX = 640).
      expect(state.screenX).toBeGreaterThan(640);
      // All arrows must be within 1 px of the right boundary.
      expect(state.screenX).toBeCloseTo(RIGHT_EDGE_X, 0);
    }
  });

  it('pins arrows to the nearest screen edge not an intermediate ellipse position', () => {
    // A target at 45° should land on the BOTTOM edge (since RY < RX the
    // rectangle corner is at arctan(RY/RX) ≈ 25.9°, so 45° is on the bottom).
    const [state] = resolveDirectionArrowStates([waypoint('se', 100, 100)], 0, 0, 1);
    expect(state).toBeDefined();
    // screenY should be at or very near the bottom boundary (CY + RY = 360+264 = 624).
    const BOTTOM_EDGE_Y = 720 / 2 + (720 / 2 - 96); // CY + RY = 624
    expect(state!.screenY).toBeCloseTo(BOTTOM_EDGE_Y, 0);
  });

  it('places axial directions exactly on the correct screen edge', () => {
    // Straight right (angle=0): must land on right edge (x = CX+RX = 1184).
    const [right] = resolveDirectionArrowStates([waypoint('r', 100, 0)], 0, 0, 1);
    expect(right).toBeDefined();
    expect(right!.screenX).toBeCloseTo(1280 / 2 + (1280 / 2 - 96), 0); // 1184

    // Straight down (angle=π/2): must land on bottom edge (y = CY+RY = 624).
    const [down] = resolveDirectionArrowStates([waypoint('d', 0, 100)], 0, 0, 1);
    expect(down).toBeDefined();
    expect(down!.screenY).toBeCloseTo(720 / 2 + (720 / 2 - 96), 0); // 624

    // Straight up (angle=-π/2): must land on top edge (y = CY-RY = 96).
    const [up] = resolveDirectionArrowStates([waypoint('u', 0, -100)], 0, 0, 1);
    expect(up).toBeDefined();
    expect(up!.screenY).toBeCloseTo(720 / 2 - (720 / 2 - 96), 0); // 96

    // Straight left (angle=π): must land on left edge (x = CX-RX = 96).
    const [left] = resolveDirectionArrowStates([waypoint('l', -100, 0)], 0, 0, 1);
    expect(left).toBeDefined();
    expect(left!.screenX).toBeCloseTo(1280 / 2 - (1280 / 2 - 96), 0); // 96
  });
});
