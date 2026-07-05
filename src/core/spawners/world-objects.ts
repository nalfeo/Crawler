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
} from '../components.js';
import { PHYSICS_BODIES, SHAPE_CIRCLE } from '../physics-defs.js';
import type { GameWorld } from '../world.js';
import { getNpcDef, type NpcInstance } from '../../shared/npc-types.js';
import {
  DECORATION_DEFS,
  DECORATION_DEF_INDEX,
  type DecorationDef,
} from '../../shared/decorationDefs.js';
import { ftToPx } from '../../shared/units.js';
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
      // NPCs use per-def dims for their body — round to the max half-extent
      // as the circle radius so they broadly match today's sprite footprint.
      radius: Math.max(def.widthFt, def.heightFt) * 0.5,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
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
