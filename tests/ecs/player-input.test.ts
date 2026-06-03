import { addComponent, addEntity, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Player, Velocity } from '../../src/core/components.js';
import { playerInputSystem } from '../../src/core/systems/playerInputSystem.js';
import { PLAYER_SPEED } from '../../src/shared/constants.js';
import type { InputState } from '../../src/shared/input.js';
import { createTestWorld } from '../helpers/world-factory.js';

function createInputState(overrides: Partial<InputState> = {}): InputState {
  return {
    moveX: 0,
    moveY: 0,
    action: false,
    pointerX: 0,
    pointerY: 0,
    ...overrides,
  };
}

describe('playerInputSystem', () => {
  it('sets player velocity from input direction', () => {
    const world = createTestWorld();
    const player = addEntity(world.ecs);

    addComponent(world.ecs, player, Player);
    addComponent(world.ecs, player, set(Velocity, { x: 0, y: 0 }));

    playerInputSystem(world, createInputState({ moveX: 1, moveY: 0 }));

    expect(world.stores.velocity.x[player]).toBeCloseTo(PLAYER_SPEED);
    expect(world.stores.velocity.y[player]).toBeCloseTo(0);
  });

  it('normalizes diagonal input before applying speed', () => {
    const world = createTestWorld();
    const player = addEntity(world.ecs);

    addComponent(world.ecs, player, Player);
    addComponent(world.ecs, player, set(Velocity, { x: 0, y: 0 }));

    playerInputSystem(world, createInputState({ moveX: 1, moveY: 1 }));

    const diagonalSpeed = PLAYER_SPEED / Math.sqrt(2);

    expect(world.stores.velocity.x[player]).toBeCloseTo(diagonalSpeed);
    expect(world.stores.velocity.y[player]).toBeCloseTo(diagonalSpeed);
  });

  it('sets player velocity to zero when there is no input', () => {
    const world = createTestWorld();
    const player = addEntity(world.ecs);

    addComponent(world.ecs, player, Player);
    addComponent(world.ecs, player, set(Velocity, { x: 2, y: -2 }));

    playerInputSystem(world, createInputState());

    expect(world.stores.velocity.x[player]).toBe(0);
    expect(world.stores.velocity.y[player]).toBe(0);
  });

  it('affects only player entities', () => {
    const world = createTestWorld();
    const player = addEntity(world.ecs);
    const nonPlayer = addEntity(world.ecs);

    addComponent(world.ecs, player, Player);
    addComponent(world.ecs, player, set(Velocity, { x: 0, y: 0 }));
    addComponent(world.ecs, nonPlayer, set(Velocity, { x: 4, y: -5 }));

    playerInputSystem(world, createInputState({ moveX: 0, moveY: -1 }));

    expect(world.stores.velocity.x[player]).toBeCloseTo(0);
    expect(world.stores.velocity.y[player]).toBeCloseTo(-PLAYER_SPEED);
    expect(world.stores.velocity.x[nonPlayer]).toBe(4);
    expect(world.stores.velocity.y[nonPlayer]).toBe(-5);
  });

  it('preserves non-player velocity values', () => {
    const world = createTestWorld();
    const player = addEntity(world.ecs);
    const enemy = addEntity(world.ecs);

    addComponent(world.ecs, player, Player);
    addComponent(world.ecs, player, set(Velocity, { x: 0, y: 0 }));
    addComponent(world.ecs, enemy, set(Velocity, { x: -1.25, y: 2.5 }));

    playerInputSystem(world, createInputState({ moveX: -1, moveY: 0 }));

    expect(world.stores.velocity.x[player]).toBeCloseTo(-PLAYER_SPEED);
    expect(world.stores.velocity.y[player]).toBeCloseTo(0);
    expect(world.stores.velocity.x[enemy]).toBe(-1.25);
    expect(world.stores.velocity.y[enemy]).toBe(2.5);
  });
});
