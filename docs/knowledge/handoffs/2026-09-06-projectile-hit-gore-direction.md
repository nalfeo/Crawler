---
date: 2026-09-06
persona: Producer
systems: vfx,weapons
apples: 2🍎
---

## Systems touched

vfx,weapons

## Summary

Projectile-hit blood now resolves a normalized source-to-target direction and
uses it for deterministic directional momentum. Missing, non-finite, or
zero-length source vectors use the exact fixed fallback `{ x: 0, y: -1 }`;
random direction selection is no longer used for that fallback. Existing core
damage propagation already supplied projectile source coordinates and was left
unchanged.

## Validation

- `npx vitest run tests/unit/gore-vfx-partial-scene.test.ts tests/ecs/apply-damage.test.ts`
- `npm run verify:fast`

## Runtime observation

Before: the hit-gore path selected a random angle whenever source coordinates
were unavailable or coincident with the target, so repeated equivalent impacts
could have different fallback momentum. After: the real `createGoreVfx`
renderer test now spawns a projectile and enemy, runs the real
`collisionSystem` -> `damageSystem` path, consumes the resulting hit event, and
observes every spawned particle moving beyond the target along +X; the four
deterministic resolver fixtures cover east, diagonal, zero-length, and
unavailable vectors.

## Apples

Estimated 2🍎, actual 2🍎 — 🎯 Exact. The existing combat-event contract made
the implementation a focused engine helper plus regression coverage.
