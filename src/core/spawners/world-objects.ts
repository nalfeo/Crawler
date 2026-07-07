import { addComponent, set } from 'bitecs';
import {
  Harvestable,
  Invincible,
  Npc,
  Owner,
  Position,
  Prop,
  PropLight,
  Size,
  Sprite,
  Team,
  Trap,
  Weight,
} from '../components.js';
import { PHYSICS_BODIES, IMMOVABLE_THRESHOLD, SHAPE_BOX, SHAPE_CIRCLE } from '../physics-defs.js';
import type { GameWorld } from '../world.js';
import { getNpcDef, type NpcInstance } from '../../shared/npc-types.js';
import {
  DECORATION_DEFS,
  DECORATION_DEF_INDEX,
  type DecorationDef,
} from '../../shared/decorationDefs.js';
import { ftToPx } from '../../shared/units.js';
import type { SetPiecePropRender } from '../../shared/set-piece-render.js';
import { type HarvestableDef, HARVESTABLE_DEFS } from '../../shared/harvestableDefs.js';
import { createEntity } from './entity-core.js';

/** Spawn a trap entity at a position. */
export function spawnTrap(
  world: GameWorld,
  x: number,
  y: number,
  explosionDamage: number,
  triggerRadius: number,
  explosionRadius: number,
  armDelayMs: number,
  ownerEid: number,
  teamId: number,
): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(Trap, {
      triggerRadius,
      explosionRadius,
      explosionDamage,
      armAtMs: world.elapsedMs + armDelayMs,
    }),
  );
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 1.5, height: 1.5 }));
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: PHYSICS_BODIES.trap.radius,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
  return eid;
}

/**
 * Spawn an NPC entity at the given position.
 * NPCs are non-hostile (no Enemy component) and invincible by default.
 * The defId must match a registered NpcDef in npc-types.ts.
 * Returns the entity id, or -1 if the defId is not found.
 */
export function spawnNpc(world: GameWorld, x: number, y: number, defId: string): number {
  const def = getNpcDef(defId);
  if (def === undefined) {
    return -1;
  }

  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(Sprite, { textureId: def.textureId, width: def.widthFt, height: def.heightFt }),
  );
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      // NPC defs are non-square (e.g. 2.5×3.5 ft), so we use a per-axis BOX
      // that byte-matches the legacy `sprite.width/2 × sprite.height/2`
      // collision footprint. A CIRCLE with `r = max(w,h)/2` would widen the
      // horizontal extent by ~40% and is a Slice-1 spec violation ("do not
      // change any numeric size value away from today's sprite half-extents").
      radius: 0,
      halfWidth: def.widthFt * 0.5,
      halfHeight: def.heightFt * 0.5,
      shape: SHAPE_BOX,
    }),
  );
  addComponent(world.ecs, eid, set(Npc, { defIdIndex: 0 }));
  addComponent(world.ecs, eid, Invincible);

  const instance: NpcInstance = {
    defId,
    dialogueIndex: 0,
    quests: def.quests.map((q) => ({ questId: q.questId, status: 'available' })),
    nearbyPlayer: false,
  };
  world.npcs.set(eid, instance);

  return eid;
}

/**
 * Spawn a static scene-dressing prop entity at the given world position.
 *
 * Creates Position + Sprite + Prop components. If the decoration def has a
 * `lightEmission` field, a PropLight component is added too. The radius is
 * converted from feet → render-pixels at this boundary so the engine layer
 * never has to do it.
 *
 * Returns the entity id, or -1 if the defId is not found.
 */
export function spawnProp(world: GameWorld, x: number, y: number, defId: string): number {
  const decorationDef: DecorationDef | undefined = DECORATION_DEFS.get(defId);
  if (decorationDef === undefined) {
    return -1;
  }

  const eid = createEntity(world);
  const defIdIndex = DECORATION_DEF_INDEX[defId] ?? 0;

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(Sprite, { textureId: 0, width: decorationDef.scale, height: decorationDef.scale }),
  );
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      // Props use per-def `scale` — the sprite is `scale × scale` so the
      // circumscribing radius equals `scale * 0.5`.
      radius: decorationDef.scale * 0.5,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
  addComponent(
    world.ecs,
    eid,
    set(Prop, {
      defIdIndex,
      isDestructible: decorationDef.isDestructible ? 1 : 0,
      isDestroyed: 0,
    }),
  );
  addComponent(
    world.ecs,
    eid,
    set(Weight, {
      // Weight comes from the decoration def (default 100 lb via `def(...)`).
      // Consumed by knockbackSystem to scale displacement per ADR 0044 /
      // Slice 2; check:weight-coverage enforces value > 0 in CI.
      value: decorationDef.weight ?? 100,
    }),
  );

  if (decorationDef.lightEmission !== undefined) {
    const { radiusFt, intensity, colorHex } = decorationDef.lightEmission;
    addComponent(
      world.ecs,
      eid,
      set(PropLight, {
        radiusPx: ftToPx(radiusFt),
        intensity,
        colorR: (colorHex >> 16) & 0xff,
        colorG: (colorHex >> 8) & 0xff,
        colorB: colorHex & 0xff,
      }),
    );
  }

  return eid;
}

/**
 * Spawn a VISUAL-ONLY set-piece prop layer entity at a world-space position (feet).
 *
 * Unlike {@link spawnProp}, this creates Position + Sprite + Prop + Weight but NO
 * Size — so the entity is picked up by the engine's prop render pass yet never
 * enters the collision grid, meaning it can never collide, be hit, be knocked
 * back, or block pathing. Set-piece dressing (rugs, banners, desks, bookcases,
 * clutter) is purely cosmetic and must not affect gameplay or balance.
 *
 * Weight is attached at an immovable tier (`IMMOVABLE_THRESHOLD`) because ADR 0044
 * / `entity-physics.md` R2 make positive Weight a universal invariant for EVERY
 * `Prop`-tagged entity (weight presence is universal; `knockbackSystem` divides by
 * it — a 0/unset weight is nonsense and trips `check:weight-coverage`). Since these
 * props carry no Size they are never knockback targets in practice, so the value is
 * inert for gameplay; the immovable tier simply makes the "fixed furniture" intent
 * explicit should Size ever be added.
 *
 * The `render` instructions (resolved sprite, straddling depth, footprint, tint)
 * are stored in the `world.setPieceProps` sidecar keyed by the new entity id;
 * the PhaserBridge prop pass consults that sidecar before the decoration-def
 * path. One entity is spawned per flattened set-piece draw layer, so composites
 * (e.g. rug + banner, or a table with an item on top) render correctly layered.
 *
 * @returns The new entity id.
 */
export function spawnSetPieceProp(
  world: GameWorld,
  x: number,
  y: number,
  render: SetPiecePropRender,
): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(Sprite, { textureId: 0, width: render.widthFt, height: render.heightFt }),
  );
  addComponent(world.ecs, eid, set(Prop, { defIdIndex: 0, isDestructible: 0, isDestroyed: 0 }));
  // Immovable-tier weight: satisfies the universal "every Prop carries positive
  // weight" invariant (ADR 0044) without giving the cosmetic prop any collision
  // footprint (no Size ⇒ never in the collision grid ⇒ never knocked back).
  addComponent(world.ecs, eid, set(Weight, { value: IMMOVABLE_THRESHOLD }));
  world.setPieceProps.set(eid, render);
  return eid;
}

/**
 * Spawn a harvestable resource node (mushroom, flower, lichen, etc.) at the
 * given world-space position (feet). The node has no health or velocity; it is
 * a static collectible the player activates by proximity.
 *
 * @param defIndex - Index into HARVESTABLE_DEFS registry
 * @returns The new entity id
 */
export function spawnHarvestableNode(
  world: GameWorld,
  x: number,
  y: number,
  defIndex: number,
): number {
  const def: HarvestableDef | undefined = HARVESTABLE_DEFS[defIndex];
  if (def === undefined) {
    throw new Error(`spawnHarvestableNode: unknown defIndex ${defIndex}`);
  }

  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  // Sprite dimensions in feet — nodes are roughly 1 ft wide/tall for collision sizing.
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 1, height: 1 }));
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: PHYSICS_BODIES['harvestable-node'].radius,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
  addComponent(
    world.ecs,
    eid,
    set(Harvestable, {
      defIndex,
      durationMs: def.durationMs,
      progressMs: 0,
      harvesterEid: 0,
    }),
  );

  return eid;
}
