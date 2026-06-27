---
applyTo: 'src/engine/**'
---

# Engine Layer Instructions

The Phaser bridge. This layer **renders** the game and captures input — it is the
only place (besides `src/labs/`) where Phaser may be imported. It is replaceable:
swapping renderers should not touch `src/core/`.

## Rules

- Do NOT import from `src/game/` or `src/labs/` (enforced by `eslint.config.js`)
- Importing from `src/core/` and `src/shared/` IS allowed — read sim state, render it
- **Rendering only** — no game-logic mutations and no ECS system definitions here;
  systems live in `src/core/` / `src/game/`
- `src/engine/PhaserBridge.ts` is the seam between the renderer and the sim;
  scenes live in `src/engine/scenes/`, sprite plumbing in `src/engine/sprites/`
- **Pixels live in this layer only.** The sim is feet-based (ADR
  `docs/knowledge/adr/0023-feet-as-single-internal-spatial-unit.md`); convert at
  the boundary with helpers from `src/shared/units.ts`
- Rendering may read wall-clock/RAF time, but NEVER feed wall-clock back into the
  sim — systems receive `delta`/`frameCount` from the loop
- Visual/e2e coverage lives in `tests/e2e/`
- **Declare apple complexity** before starting: 🍎–🍎🍎🍎🍎🍎 per `docs/agent-os/policies/complexity-policy.md`

## Bridge Pattern

```typescript
// Engine reads sim state and draws it; it does not own game rules.
import { query } from 'bitecs';
import { Position } from 'src/core'; // read-only consumption
// world.stores.position.x[eid] is feet → multiply by PIXELS_PER_FOOT to draw
```

HUD widgets (`src/engine/HudUI.ts` and the `Hud*` components) and VFX
(`src/engine/CombatVfx.ts`, `src/engine/EffectsVfx.ts`,
`src/engine/CorpseShatterVfx.ts`) read sim/event state and render it; they must
not write back into component stores.

> Layer boundaries are enforced by `eslint.config.js`; see
> `docs/architecture.md` for the full layer model and `docs/README.md` for the
> governance source-of-truth registry.
