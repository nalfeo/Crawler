/**
 * Floor 3 Companion League — party recruitment (spec R5, slice 6).
 *
 * `recruitPartyCompanion` spawns a new Companion entity for a team and
 * assigns it the next 0-based `PartySlot`, latching `PartySlot.locked` once
 * the party reaches `PARTY_MAX_SIZE` (starter pick + 5 poaches, spec R5). It
 * refuses to spawn anything once the party has already locked, so callers
 * (starter/poach offer flows) can call it unconditionally and check the
 * return value.
 */
import { addComponent, query, set } from 'bitecs';
import { Companion, PartySlot, Team } from '../components.js';
import type { GameWorld } from '../world.js';
import { spawnBehaviorEnemy } from './combatants.js';

/** Starter pick + 5 Trainer poaches (spec R5). */
export const PARTY_MAX_SIZE = 6;

/** Every recruited Companion currently on `ownerTeam`'s party roster. */
export function partyMembers(world: GameWorld, ownerTeam: number): readonly number[] {
  return Array.from(query(world.ecs, [Companion, PartySlot, Team])).filter(
    (eid) => (world.stores.team.id[eid] ?? -1) === ownerTeam,
  );
}

/** True once `ownerTeam`'s party has recruited to {@link PARTY_MAX_SIZE} and locked. */
export function isPartyLocked(world: GameWorld, ownerTeam: number): boolean {
  return partyMembers(world, ownerTeam).some(
    (eid) => (world.stores.partySlot.locked[eid] ?? 0) === 1,
  );
}

export interface RecruitPartyCompanionOptions {
  x: number;
  y: number;
  hp: number;
  aiType: number;
  speed: number;
  aggroRange: number;
  attackRange: number;
  speciesToken: number;
  level: number;
  ownerTeam: number;
}

/**
 * Recruits a new party Companion (starter pick or Trainer poach). Returns the
 * new entity id, or `undefined` without spawning anything if the party has
 * already locked at {@link PARTY_MAX_SIZE}.
 */
export function recruitPartyCompanion(
  world: GameWorld,
  options: RecruitPartyCompanionOptions,
): number | undefined {
  const members = partyMembers(world, options.ownerTeam);
  if (members.some((eid) => (world.stores.partySlot.locked[eid] ?? 0) === 1)) return undefined;
  if (members.length >= PARTY_MAX_SIZE) return undefined; // defensive; lock should already be set

  const eid = spawnBehaviorEnemy(
    world,
    options.x,
    options.y,
    options.hp,
    options.aiType,
    options.speed,
    options.aggroRange,
    options.attackRange,
  );
  addComponent(world.ecs, eid, set(Team, { id: options.ownerTeam }));
  addComponent(
    world.ecs,
    eid,
    set(Companion, {
      speciesToken: options.speciesToken,
      form: 0,
      level: options.level,
      xp: 0,
      ownerTeam: options.ownerTeam,
      knockedOut: 0,
    }),
  );
  const slot = members.length;
  addComponent(
    world.ecs,
    eid,
    set(PartySlot, { slot, locked: slot + 1 >= PARTY_MAX_SIZE ? 1 : 0 }),
  );
  return eid;
}
