/** Shared deterministic combat staging; damage and AI run only in shipped pipelines. */
import { addComponent, query, removeEntity, set } from 'bitecs';
import { Damage, Enemy, FamilyMembership, MeleeSwing, Projectile } from '../../core/components.js';
import { clearEntityStores } from '../../core/helpers.js';
import { spawnBehaviorEnemy } from '../../core/spawners/combatants.js';
import { spawnEnemyProjectile } from '../../core/spawners/projectiles.js';
import { asFamilyId, initializeFactionRelations } from '../../core/faction-relations.js';
import { isPointInSafeSpace } from '../../core/safe-space.js';
import { applyStatusEffect } from '../../core/status-effects.js';
import type { GameWorld } from '../../core/world.js';
import { AI_TYPE } from '../../game/enemyAISystem.js';
import { getFamilyAIDecision } from '../../game/systems/familyFeudSystem.js';

export const FAMILY_COMBAT_CASES = [
  'friendly-contact',
  'neutral-contact',
  'hostile-contact',
  'hate-contact',
  'friendly-projectile',
  'neutral-projectile',
  'hostile-projectile',
  'hate-projectile',
  'rival-contact',
  'same-family-contact',
  'rival-projectile',
  'same-family-projectile',
  'defend-player',
  'defend-family',
] as const;
export type FamilyCombatCase = (typeof FAMILY_COMBAT_CASES)[number];
export interface FamilyCombatObservation {
  playerDamaged: boolean;
  targetDamaged: boolean;
  playerHits: number;
  targetHits: number;
  deaths: number;
  allyTargetsAttacker: boolean;
  attackerDamaged: boolean;
  allyMoved: boolean;
  relations: number[];
}
interface Fixture {
  player: number;
  attacker: number;
  target: number;
  ally: number | null;
  allyStartX: number;
  initialPlayerHp: number;
  initialTargetHp: number;
  events: { targetEid?: number; type: string }[];
}
const fixtures = new WeakMap<GameWorld, Fixture>();
const families = [asFamilyId('goblins'), asFamilyId('kobolds')];

export function stageFamilyCombat(world: GameWorld, player: number, kind: FamilyCombatCase): void {
  for (const eid of new Set([
    ...query(world.ecs, [Enemy]),
    ...query(world.ecs, [Projectile]),
    ...query(world.ecs, [MeleeSwing]),
  ])) {
    clearEntityStores(world, eid);
    removeEntity(world.ecs, eid);
  }
  world.elapsedMs += 1000;
  world.floorId = 'floor2';
  world.floorExtendedState = {
    familyState: {
      presentFamilies: [...families],
      contestedResource: 'ore' as never,
      betrayerFlag: false,
    },
  };
  initializeFactionRelations(world, families);
  const relation = kind.startsWith('friendly')
    ? 90
    : kind.startsWith('neutral')
      ? 50
      : kind.startsWith('hate')
        ? 0
        : 25;
  world.factionRelations.set(families[0]!, relation);
  world.factionRelations.set(families[1]!, 90);
  world.factionRelationDeltas.length = 0;
  world.combatEvents.length = 0;
  world.lastPlayerHit = undefined;
  world.stores.health.current[player] = 50;
  const abilities = world.abilityStatesByEntity.get(player);
  if (abilities) abilities.equippedActiveAbilityIds = [];
  applyStatusEffect(world, player, {
    stat: 'attackSpeed',
    op: 'multiply',
    value: 0,
    durationMs: null,
    sourceType: 'ability',
    sourceId: 'family-combat-probe',
    stackRule: { mode: 'replace' },
  });
  const map = world.floorMap;
  if (map) {
    let found = false;
    for (let ty = 2; ty < map.height - 2 && !found; ty++) {
      for (let tx = 2; tx < map.width - 4; tx++) {
        const point = map.tileToWorld(tx, ty);
        if (isPointInSafeSpace(world, point.x, point.y)) continue;
        if (
          ![-1, 0, 1, 2, 3].every((dx) =>
            [-1, 0, 1].every((dy) => map.tileMap.isPassable(tx + dx, ty + dy)),
          )
        )
          continue;
        world.stores.position.x[player] = point.x;
        world.stores.position.y[player] = point.y;
        found = true;
        break;
      }
    }
    if (!found) throw new Error('Floor 2 combat probe requires an open unsafe arena');
  }
  const x = world.stores.position.x[player]!;
  const y = world.stores.position.y[player]!;
  const mob = (px: number, family: number): number => {
    const eid = spawnBehaviorEnemy(world, px, y, 1000, AI_TYPE.CHASE, 0, 999, 0);
    addComponent(world.ecs, eid, set(FamilyMembership, { familyId: family, isBoss: 0 }));
    addComponent(world.ecs, eid, set(Damage, { amount: 7, cooldownMs: 1000, lastFireMs: -10000 }));
    return eid;
  };
  const familyTarget =
    kind.startsWith('rival') || kind.startsWith('same-family') || kind === 'defend-family';
  const projectile = kind.endsWith('projectile');
  const targetX = familyTarget ? x + 6 : x;
  const attacker = mob(projectile ? targetX + 4 : targetX, 0);
  const target = familyTarget ? mob(targetX, kind.startsWith('same-family') ? 0 : 1) : player;
  if (familyTarget) world.stores.damage.amount[target] = 0;
  const ally = kind.startsWith('defend-') ? mob(x + 3, 1) : null;
  if (ally !== null) {
    world.stores.damage.amount[ally] = 7;
    world.stores.enemyBehavior.speed[ally] = 0.5;
  }
  if (projectile) spawnEnemyProjectile(world, targetX, y, 0, 0, 7, attacker);
  fixtures.set(world, {
    player,
    attacker,
    target,
    ally,
    allyStartX: ally === null ? 0 : world.stores.position.x[ally]!,
    initialPlayerHp: world.stores.health.current[player]!,
    initialTargetHp: world.stores.health.current[target]!,
    events: [],
  });
}

/** Appended to canonical postSystems, before the real renderer drains combat events. */
export function observeFamilyCombat(world: GameWorld): void {
  const fixture = fixtures.get(world);
  if (!fixture) return;
  for (const event of world.combatEvents) {
    if (event.timestamp === world.elapsedMs)
      fixture.events.push({ type: event.type, targetEid: event.targetEid });
  }
}

export function readFamilyCombat(world: GameWorld): FamilyCombatObservation | null {
  const fixture = fixtures.get(world);
  if (!fixture) return null;
  return {
    playerDamaged: world.stores.health.current[fixture.player]! < fixture.initialPlayerHp,
    targetDamaged: world.stores.health.current[fixture.target]! < fixture.initialTargetHp,
    playerHits: fixture.events.filter(
      (event) => event.type === 'hit' && event.targetEid === fixture.player,
    ).length,
    targetHits: fixture.events.filter(
      (event) => event.type === 'hit' && event.targetEid === fixture.target,
    ).length,
    deaths: fixture.events.filter((event) => event.type === 'death').length,
    allyTargetsAttacker:
      fixture.ally !== null &&
      getFamilyAIDecision(world, fixture.ally)?.targetEid === fixture.attacker,
    attackerDamaged: world.stores.health.current[fixture.attacker]! < 1000,
    allyMoved:
      fixture.ally !== null && world.stores.position.x[fixture.ally] !== fixture.allyStartX,
    relations: families.map((family) => world.factionRelations.get(family)!),
  };
}
