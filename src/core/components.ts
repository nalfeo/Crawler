/**
 * ECS Components — defined using bitecs 0.4.x API.
 * Components are plain objects used as tags/keys for the ECS.
 * Data is stored via set()/get() on entities with component stores.
 *
 * IMPORTANT: bitecs component state persists across test runs.
 * Always call createGameWorld() in beforeEach to get a fresh world.
 */

// --- Transform ---
export const Position = { x: 0, y: 0 };
export const Velocity = { x: 0, y: 0 };
export const Rotation = { angle: 0 };

// --- Combat ---
export const Health = { current: 100, max: 100 };
export const Damage = { amount: 0, cooldownMs: 0, lastFireMs: 0 };

// --- Entity Tags ---
export const Player = {};
export const Enemy = {};
export const Projectile = {};
export const XpGem = { value: 1 };
export const DroppedItem = {};

// --- Rendering ---
export const Sprite = { textureId: 0, width: 0, height: 0 };

// --- Gameplay ---
export const BroadcastScore = { current: 0 };
