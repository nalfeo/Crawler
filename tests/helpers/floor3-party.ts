import { addComponent, set } from 'bitecs';
import { Companion, PartySlot, Team, spawnBehaviorEnemy } from '../../src/core/index.js';
import type { GameWorld } from '../../src/core/index.js';
import { TeamId } from '../../src/shared/constants.js';
import { speciesTokenForId } from '../../src/shared/data/floor3/species.js';

export interface Floor3TestCompanionOptions {
  speciesId: string;
  slot?: number;
  level?: number;
  x?: number;
  y?: number;
  hp?: number;
  maxHp?: number;
  teamId?: number;
  knockedOut?: boolean;
  /** Omit the `PartySlot` component (Trainer/Studio/wild roster Companions). */
  roster?: boolean;
}

/**
 * Spawn a Floor 3 Companion for HUD/roster/command tests.
 *
 * Deliberately mirrors what `recruitPartyCompanion`/`spawnRosterCompanion`
 * produce (Companion + Team, plus PartySlot only for recruited party members)
 * without pulling in the game-layer `AI_TYPE` enum, so engine-layer state
 * modules can be exercised from `tests/unit`.
 */
export function spawnTestCompanion(world: GameWorld, options: Floor3TestCompanionOptions): number {
  const {
    speciesId,
    slot = 0,
    level = 1,
    x = 0,
    y = 0,
    hp = 100,
    maxHp = hp,
    teamId = TeamId.PLAYER,
    knockedOut = false,
    roster = false,
  } = options;

  const eid = spawnBehaviorEnemy(world, x, y, maxHp, 0, 0.1, 999, 0);
  world.stores.health.current[eid] = hp;
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  addComponent(
    world.ecs,
    eid,
    set(Companion, {
      speciesToken: speciesTokenForId(speciesId),
      form: 0,
      level,
      xp: 0,
      ownerTeam: teamId,
      knockedOut: knockedOut ? 1 : 0,
    }),
  );
  if (!roster) {
    addComponent(world.ecs, eid, set(PartySlot, { slot, locked: 0 }));
  }
  return eid;
}
