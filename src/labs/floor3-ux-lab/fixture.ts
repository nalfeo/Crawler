/**
 * Shared fixture for the Floor-3 UX labs (game-design §15 surfaces 4–8).
 *
 * Builds a synthetic Floor-3 world with a real recruited party (via
 * `recruitPartyCompanion`, so `PartySlot` assignment matches the game) plus a
 * rival Companion the matchup indicator can read. Each surface gets its own
 * lab; they all share this fixture so the sandboxes stay consistent.
 */
import { addComponent, set } from 'bitecs';
import {
  Companion,
  Team,
  createGameWorld,
  recruitPartyCompanion,
  spawnBehaviorEnemy,
  spawnPlayer,
  type GameWorld,
} from '../../core/index.js';
import { TeamId } from '../../shared/constants.js';
import { speciesTokenForId } from '../../shared/data/floor3/species.js';

const LAB_SEED = 31313;

export interface LabPartySpec {
  readonly speciesId: string;
  readonly level: number;
  readonly hpFraction: number;
  readonly knockedOut: boolean;
}

/** Default party: mixed affinities/styles so every HUD tag is exercised. */
const DEFAULT_PARTY: readonly LabPartySpec[] = [
  { speciesId: 'ember-charger', level: 12, hpFraction: 1, knockedOut: false },
  { speciesId: 'tide-warden', level: 7, hpFraction: 0.45, knockedOut: false },
  { speciesId: 'gloom-slinger', level: 25, hpFraction: 0.18, knockedOut: false },
];

export interface Floor3LabFixture {
  readonly world: GameWorld;
  readonly playerEid: number;
  readonly partyEids: readonly number[];
  readonly rivalEid: number;
}

/** Fresh Floor-3 world with a recruited party and one rival Companion. */
export function createFloor3LabFixture(
  party: readonly LabPartySpec[] = DEFAULT_PARTY,
  rivalSpeciesId = 'bloom-warden',
): Floor3LabFixture {
  const world = createGameWorld({ seed: LAB_SEED });
  world.state = 'playing';
  world.floorId = 'floor3';
  world.floor = 3;
  const playerEid = spawnPlayer(world, 0, 0);

  const partyEids: number[] = [];
  party.forEach((spec, index) => {
    const eid = recruitPartyCompanion(world, {
      x: 4 + index * 2,
      y: 0,
      hp: 100,
      aiType: 0,
      speed: 0.12,
      aggroRange: 999,
      attackRange: 0,
      speciesToken: speciesTokenForId(spec.speciesId),
      level: spec.level,
      ownerTeam: TeamId.PLAYER,
    });
    if (eid === undefined) return;
    world.stores.health.current[eid] = Math.max(1, Math.round(100 * spec.hpFraction));
    world.stores.companion.knockedOut[eid] = spec.knockedOut ? 1 : 0;
    partyEids.push(eid);
  });

  const rivalEid = spawnBehaviorEnemy(world, 10, 0, 100, 0, 0.12, 999, 0);
  addComponent(world.ecs, rivalEid, set(Team, { id: TeamId.ENEMY }));
  addComponent(
    world.ecs,
    rivalEid,
    set(Companion, {
      speciesToken: speciesTokenForId(rivalSpeciesId),
      form: 0,
      level: 10,
      xp: 0,
      ownerTeam: TeamId.ENEMY,
      knockedOut: 0,
    }),
  );

  return { world, playerEid, partyEids, rivalEid };
}
