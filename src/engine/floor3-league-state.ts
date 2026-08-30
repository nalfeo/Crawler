import type { GameWorld } from '../core/world.js';
import { formForLevel, getPetSpecies } from '../shared/data/floor3/species.js';
import {
  buildFloor3LeagueViewModel,
  type Floor3KeepCompanionOption,
  type Floor3LeagueViewModel,
} from '../shared/floor3-ux.js';
import { resolveFloor3PartyRows } from './floor3-party-state.js';

export function resolveFloor3LeagueView(world: GameWorld): Floor3LeagueViewModel {
  const state = world.floorExtendedState?.floor3Studios;
  return buildFloor3LeagueViewModel({
    floorId: world.floorId,
    worldState: world.state,
    victory: world.goalFlags.get('floor3-victory') === true,
    studiosDefeated: state?.studiosDefeatedCount ?? 0,
    studios: (state?.studios ?? []).map((studio, index) => ({
      id: studio.id,
      name: studio.name,
      affinity: world.floorExtendedState?.floor3BiomeAffinities?.[index],
      unlockLevel: studio.unlockLevel,
      unlocked: studio.unlocked,
      defeated: studio.defeated,
    })),
    finalFourUnlocked: state?.finalFour.unlocked ?? false,
    finalFourRoundIndex: state?.finalFourRoundIndex ?? 0,
    rounds: (state?.finalFourRounds ?? []).map((round) => ({
      handlerId: round.handlerId,
      handlerName: round.handlerName,
      defeated: round.defeated,
    })),
  });
}

/** Live, valid player-party choices for the required Best in Show picker. */
export function resolveFloor3KeepCompanionOptions(
  world: GameWorld,
): readonly Floor3KeepCompanionOption[] {
  return resolveFloor3PartyRows(world)
    .filter((row) => !row.knockedOut)
    .map((row) => {
      const species = getPetSpecies(row.speciesId);
      return {
        eid: row.eid,
        speciesId: row.speciesId,
        currentName: row.formName,
        ultimateName: species ? formForLevel(species, Number.MAX_SAFE_INTEGER).name : row.formName,
        level: row.level,
        affinity: row.affinity,
        fightingStyle: row.fightingStyle,
      };
    });
}
