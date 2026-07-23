# Handoff: UX Consistency Pass

**Date:** 2026-06-22  
**Persona:** UX Designer  
**Branch:** current working branch  
**Apple estimate:** 🍎🍎 | **Actual:** 🍎🍎 | **Verdict:** on target

## What was done

Aligned three game surfaces — floor1-lab, main game (`src/main.ts`), and ai-runner-lab visual mode — so they render and behave identically.

### Files changed

**`src/labs/ai-runner-lab/index.ts`**

- `Phaser.WEBGL` → `Phaser.AUTO` — matches main game; avoids hard WebGL requirement on devices without it.
- Added `roundPixels: true` — was missing, causing pixel-art sprites to render with sub-pixel blurring (all other surfaces had this set).
- `backgroundColor: '#1a1a2e'` → `'#111111'` — matches main game letterbox color.
- Hardcoded `width: 1280, height: 720` → `GAME.WIDTH, GAME.HEIGHT` — uses the shared constant; added `GAME` import from `../../shared/constants.js`.

**`src/labs/floor1-lab/index.ts`**

- `backgroundColor: '#05070f'` → `'#111111'` — matches main game.
- Added `allocateStatPoints: (world, _playerEid, allocations) => spendPoints(world, allocations)` — was missing; the level-up modal opened but confirming allocations did nothing (MainGameScene guards the modal open on `options.allocateStatPoints` being set).
- Removed `npcSystem` from `preSystems` — `MainGameScene` calls `npcSystem` directly in its fixed-step loop (between core systems and postSystems). Having it in `preSystems` caused double execution every tick.
- Updated the subsystem status table note for `npcSystem` to document that it is called directly by the scene, not via the preSystems hook.
- Removed the now-unused `import { npcSystem } from '../../core/index.js'`.
- Added `spendPoints` to the import from `../../game/systems/index.js`.

## Notes for next agent

- The `isLocked` guards for `shopkeeper` and `spellQuestGiver` are intentionally absent from floor1-lab — they make these NPCs accessible from the start for direct testing without requiring tutorial completion. This is not an inconsistency; it's a deliberate lab affordance.
- `physics` (arcade) is present in `main.ts` and `ai-runner-lab` but absent from `floor1-lab`. Phaser arcade physics is not used by any engine system (the ECS handles all movement/collision), so this is harmless and not worth adding.

## Apples

- **Estimated:** 🍎🍎
- **Actual:** 🍎🍎
- **Verdict:** on target

## Systems touched

hud-ux
