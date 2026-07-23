# Handoff: Starting Weapons Overhaul + Real Sprites

**Date:** 2026-06-21  
**Branch:** (current PR branch)  
**Persona:** Producer

## Systems touched

weapons

## What Was Done

Changed the starting weapon loadout from (sword, pistol, fireball) → (sword, bow, baseball-bat) and replaced vector-placeholder weapon rendering with real Kenney tiny-dungeon sprites.

## Key Changes

### Weapon Definitions (`src/shared/weaponDefs.ts`, `src/shared/data/weapons.json`)

- **baseball-bat** added: damage=20, cooldown=900ms, arc=120°, headRadius=1.75ft, knockback=5ft, type=MELEE
- **bow** updated: damage=16, cooldown=900ms, pierce=1 (was: no pierce, faster cooldown)
- Both use ft units for authored values; `ftToPx()` converts at store boundaries

### ECS (`src/core/components.ts`, `src/core/helpers.ts`)

- `meleeSwing` store gained `spriteId: new Uint8Array(maxEntities)`
- `spawnMeleeSwing` accepts optional `spriteId: number = 0` as last param
- No breaking changes — existing callers unaffected (default=0)

### Shared Constants (`src/shared/constants.ts`)

- `MeleeSpriteId` constant added: `{ SWORD: 1, BAT: 2 }`
- Used by both `weaponSystem.ts` (game layer) and `PhaserBridge.ts` (engine layer) to avoid cross-layer coupling

### Weapon System (`src/game/weaponSystem.ts`)

- `getMeleeSpriteId(weaponId)` maps weapon ID → `MeleeSpriteId` value
- Passed to `spawnMeleeSwing` so renderer knows which sprite to show

### Sprite Registry (`src/engine/sprites/registry.ts`)

- `weapon.sword` → Kenney tiny-dungeon frame 104 (row 8, col 8)
- `weapon.bat` → Kenney tiny-dungeon frame 117 (row 9, col 9)
- `weapon.arrow` → Kenney tiny-dungeon frame 131 (row 10, col 11)

### Renderer (`src/engine/PhaserBridge.ts`)

- `proj` entities (player projectiles) now use `weapon.arrow` sprite; auto-rotates to velocity direction
- `melee_swing` entities now show a weapon sprite (sword or bat) at the blade tip with faint arc trail behind it
- Sprite is created once on first tick, cleaned up via existing `activeEntities` lifecycle

### Loadout (`src/game/scenarios/floor1LoadoutScenario.ts`)

- `Floor1LoadoutChoiceId` type: `'sword' | 'bow' | 'baseball-bat'`
- Descriptions updated to reflect new weapons

## Invariants to Know

- `MeleeSpriteId` lives in `src/shared/constants.ts` so both engine and game layers can import it without violating layer rules
- Bow damage must remain < 18 (crossbow.baseDamage=18 constraint in existing tests)
- `canvas` npm package was accidentally added during sprite inspection — removed from `package.json`

## Tests Updated

- `tests/game/floor1-loadout-scenario.test.ts`: fireball→bow, added baseball-bat test

## What's Next (if desired)

- Melee swing animation (sprite could oscillate scale/alpha over arc progress)
- Bow draw animation (charge-up visual before shot)
- Baseball-bat knockback VFX (screen shake, particle burst)
- Hammer weapon (already handled by `MeleeSpriteId.BAT` → same sprite)
