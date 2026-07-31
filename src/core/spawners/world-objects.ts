import { addComponent, set } from 'bitecs';
import {
  BossChestEntity,
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
import { PHYSICS_BODIES, SHAPE_BOX, SHAPE_CIRCLE } from '../physics-defs.js';
import type { GameWorld } from '../world.js';
import { getNpcDef, type NpcInstance } from '../../shared/npc-types.js';
import {
  DECORATION_DEFS,
  DECORATION_DEF_INDEX,
  type DecorationDef,
} from '../../shared/decorationDefs.js';
import { ftToPx } from '../../shared/units.js';
import type { SetPiecePropRender } from '../../shared/set-piece-render.js';
import type { SpriteRef } from '../../shared/set-piece-types.js';
import { type HarvestableDef, HARVESTABLE_DEFS } from '../../shared/harvestableDefs.js';
import { hashStringToSeed, SeededRandom } from '../../shared/random.js';
import { createEntity } from './entity-core.js';

export interface SpawnNpcOptions {
  /** Optional per-instance dialogue that overrides the static NPC def. */
  readonly dialogueOverride?: readonly string[];
  /** Optional borrowed appearance key (e.g. family elite sprite for a neutral NPC). */
  readonly appearanceKey?: string;
  /** Optional fallback borrowed appearance key when the preferred key has no art. */
  readonly appearanceFallbackKey?: string;
  readonly spriteOverride?: SpriteRef;
  readonly widthFt?: number;
  readonly heightFt?: number;
  readonly flipX?: boolean;
  readonly flipY?: boolean;
  readonly rotationDeg?: number;
  readonly z?: number;
}

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
export function spawnNpc(
  world: GameWorld,
  x: number,
  y: number,
  defId: string,
  options: SpawnNpcOptions = {},
): number {
  const def = getNpcDef(defId);
  if (def === undefined) {
    return -1;
  }
  if ((options.widthFt === undefined) !== (options.heightFt === undefined)) {
    throw new Error('spawnNpc requires widthFt and heightFt to be provided together.');
  }
  if (
    options.widthFt !== undefined &&
    (!Number.isFinite(options.widthFt) ||
      !Number.isFinite(options.heightFt) ||
      options.widthFt <= 0 ||
      (options.heightFt ?? 0) <= 0)
  ) {
    throw new Error('spawnNpc requires widthFt and heightFt to be finite positive numbers.');
  }
  const widthFt = options.widthFt ?? def.widthFt;
  const heightFt = options.heightFt ?? def.heightFt;

  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(Sprite, { textureId: def.textureId, width: widthFt, height: heightFt }),
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
      halfWidth: widthFt * 0.5,
      halfHeight: heightFt * 0.5,
      shape: SHAPE_BOX,
    }),
  );
  addComponent(world.ecs, eid, set(Npc, { defIdIndex: 0 }));
  addComponent(world.ecs, eid, Invincible);

  const instance: NpcInstance = {
    defId,
    ...(options.spriteOverride !== undefined ? { spriteOverride: options.spriteOverride } : {}),
    ...(options.flipX !== undefined ? { flipX: options.flipX } : {}),
    ...(options.flipY !== undefined ? { flipY: options.flipY } : {}),
    ...(options.rotationDeg !== undefined ? { rotationDeg: options.rotationDeg } : {}),
    ...(options.z !== undefined ? { z: options.z } : {}),
    dialogueIndex: 0,
    quests: def.quests.map((q) => ({ questId: q.questId, status: 'available' })),
    dialogueOverride: options.dialogueOverride,
    appearanceFallbackKey: options.appearanceFallbackKey,
    nearbyPlayer: false,
  };
  world.npcs.set(eid, instance);
  if (options.appearanceKey !== undefined) {
    world.enemyAppearanceKeys.set(eid, options.appearanceKey);
  }

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
 * Append a render-only set-piece prop layer to `world.setPieceProps` at a
 * world-space position (feet).
 *
 * Unlike {@link spawnProp}, this creates NO ECS entity — it records a plain
 * {@link SetPiecePropInstance} the engine renders in its dedicated set-piece
 * pass. Set-piece dressing (rugs, banners, desks, bookcases, clutter) is purely
 * cosmetic and must not affect gameplay or balance, and creating an entity per
 * layer would allocate entity ids ahead of the run's gameplay spawns — shifting
 * ambient-mob/drop ids and thereby perturbing collision-pair enumeration order
 * and the global RNG. Keeping props off the entity space guarantees the headless
 * simulation and the rendered game stay byte-for-byte identical no matter how
 * much dressing a floor carries (see `set-piece-render.ts` for the rationale).
 *
 * The `render` instructions (resolved sprite, straddling depth, footprint, tint)
 * are stored alongside the position; the PhaserBridge set-piece pass consults
 * this list. One instance is appended per flattened set-piece draw layer, in
 * draw order, so composites (e.g. rug + banner, or a table with an item on top)
 * render correctly layered.
 */
export function addSetPieceProp(
  world: GameWorld,
  x: number,
  y: number,
  render: SetPiecePropRender,
): void {
  world.setPieceProps.push({ x, y, render });
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

  // Cosmetic-only: seed a deterministic per-node appearance roll so node types
  // with multiple approved art variants (e.g. azure-mushroom) spread across
  // them instead of every node picking variant 0. Mirrors
  // initializeEnemyAppearance (combatants.ts): a LOCAL SeededRandom hashed from
  // the world seed + entity + spawn context — it never draws from the shared
  // gameplay RNG stream, so it cannot perturb simulation determinism or
  // win-rate. `variantRoll` is read render-side only (texture-variant pick;
  // corpse-shard VFX is enemy-only and never reached by harvestable nodes).
  const appearanceSeed = hashStringToSeed(
    `harvestable-appearance:${world.seed}:${eid}:${world.frameCount}:${world.elapsedMs}:${x}:${y}`,
  );
  world.stores.sprite.variantRoll[eid] = new SeededRandom(appearanceSeed).next();

  return eid;
}

/**
 * Spawn a physical boss-chest entity at the given world-space position.
 *
 * The chest renders as a world object the player can walk near to open.
 * `bossChestPickupSystem` detects player proximity, calls `openBossChest`,
 * and removes the entity once the chest transitions to `revealed`.
 *
 * The `chestId` → `eid` reverse-lookup is stored in `world.bossChestEids`
 * so the pickup system can match the ECS entity back to the lifecycle record
 * without scanning the entire entity list.
 *
 * @param chestId - The canonical chest ID (e.g. `boss-chest:serpents`)
 * @returns The new entity id
 */
export function spawnBossChestEntity(
  world: GameWorld,
  x: number,
  y: number,
  chestId: string,
): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 2, height: 2 }));
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: PHYSICS_BODIES['boss-chest'].radius,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: PHYSICS_BODIES['boss-chest'].weight }));
  addComponent(world.ecs, eid, BossChestEntity);

  world.bossChestEids.set(chestId, eid);

  return eid;
}
