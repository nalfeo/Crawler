import { FLOOR2_BOSS_ABILITY_CATALOG } from '../../shared/boss-abilities.js';
import type { MobAbilityRuntimeDefinition } from './types.js';
import { createBambooFedBerserkDefinition } from './bamboo-fed-berserk.js';
import { createClockworkKillSawDefinition } from './clockwork-kill-saw.js';
import { createDonPacoBigGobDefinition } from './don-paco-the-big-gob.js';
import { createRomanCandleCoronationDefinition } from './roman-candle-coronation.js';
import { createSovereignSporeBloomDefinition } from './sovereign-spore-bloom.js';
import { createTongueRepossessionDefinition } from './tongue-repossession.js';
import { createUndercityMobCallDefinition } from './undercity-mob-call.js';
import { createVerdigrisGlamourDefinition } from './verdigris-glamour.js';
import {
  createHellfireShiftLineDefinition,
  createHighwayRobberyDefinition,
  createScrapCartStampedeDefinition,
  createUndermineUnionDefinition,
} from './floor2-lane-abilities.js';
import {
  createAbuelaThornRingDefinition,
  createChitinTurnoverDefinition,
  createLongSqueezeDefinition,
  createMidnightResonanceDefinition,
} from './floor2-ring-abilities.js';
import {
  createOmertaHonkDefinition,
  createShellCompanyLockdownDefinition,
} from './floor2-utility-abilities.js';

/** Explicit approved roster: adding catalog content never silently enables code. */
const FACTORIES: Readonly<Record<string, () => MobAbilityRuntimeDefinition>> = {
  'nana-snaggle-scrap-cart-stampede': createScrapCartStampedeDefinition,
  'don-paco-the-big-gob': createDonPacoBigGobDefinition,
  'big-panda-wei-bamboo-fed-berserk': createBambooFedBerserkDefinition,
  'queen-mab-verdigris-glamour': createVerdigrisGlamourDefinition,
  'king-skritt-roman-candle-coronation': createRomanCandleCoronationDefinition,
  'sovereign-cap-spore-bloom': createSovereignSporeBloomDefinition,
  'big-mama-bufo-tongue-repossession': createTongueRepossessionDefinition,
  'overseer-fizzwick-clockwork-kill-saw': createClockworkKillSawDefinition,
  'plague-boss-squick-undercity-mob-call': createUndercityMobCallDefinition,
  'abuela-saguaro-thorn-ring': createAbuelaThornRingDefinition,
  'countess-vesper-midnight-resonance': createMidnightResonanceDefinition,
  'kingpin-molt-shell-company-lockdown': createShellCompanyLockdownDefinition,
  'broodfather-chitin-turnover': createChitinTurnoverDefinition,
  'foreman-grubbs-undermine-the-union': createUndermineUnionDefinition,
  'boss-bandit-rocco-highway-robbery': createHighwayRobberyDefinition,
  'don-honkrado-omerta-honk': createOmertaHonkDefinition,
  'foreman-scorch-hellfire-shift-line': createHellfireShiftLineDefinition,
  'gastropod-godfather-long-squeeze': createLongSqueezeDefinition,
};

export function createFloor2BossAbilityDefinition(familyId: string): MobAbilityRuntimeDefinition {
  const matches = FLOOR2_BOSS_ABILITY_CATALOG.entries.filter(
    (ability) => ability.familyId === familyId,
  );
  if (matches.length !== 1) throw new Error(`Expected one Floor 2 boss ability for ${familyId}`);
  const ability = matches[0]!;
  const factory = FACTORIES[ability.id];
  if (!factory) throw new Error(`Missing Floor 2 boss handler for ${ability.id}`);
  const definition = factory();
  if (
    definition.abilityId !== ability.id ||
    definition.bossArchetypeKey !== ability.bossArchetypeId
  ) {
    throw new Error(`Mismatched Floor 2 boss handler for ${familyId}`);
  }
  return definition;
}
