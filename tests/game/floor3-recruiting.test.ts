import { describe, expect, it } from 'vitest';
import {
  Companion,
  PartySlot,
  Team,
  isPartyLocked,
  PARTY_MAX_SIZE,
  partyMembers,
} from '../../src/core/index.js';
import { hasComponent } from 'bitecs';
import { TeamId } from '../../src/shared/constants.js';
import { AI_TYPE } from '../../src/game/index.js';
import {
  aiTypeForSpecies,
  generateStarterOffer,
  generateTrainerPoachOffer,
  recruitCompanion,
  STARTER_OFFER_SIZE,
} from '../../src/game/floor3Recruiting.js';
import { loadPetSpecies } from '../../src/shared/data/floor3/species.js';
import { SeededRandom } from '../../src/shared/random.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('generateStarterOffer', () => {
  it('offers STARTER_OFFER_SIZE distinct species', () => {
    const offer = generateStarterOffer(new SeededRandom(1));
    expect(offer).toHaveLength(STARTER_OFFER_SIZE);
    expect(new Set(offer.map((s) => s.speciesId)).size).toBe(STARTER_OFFER_SIZE);
  });

  it('spans distinct affinities and styles for every seed — never one Temperament (spec §6.1)', () => {
    // Seed 2805 previously produced an all-`gloom` (single-Temperament) offer
    // under the old distinct-species-only sampler; the diversity constraint
    // must hold across an exhaustive seed sweep, not just for a lucky seed.
    for (let seed = 1; seed <= 3000; seed++) {
      const offer = generateStarterOffer(new SeededRandom(seed));
      expect(offer).toHaveLength(STARTER_OFFER_SIZE);
      const affinities = new Set(offer.map((s) => s.affinity));
      const styles = new Set(offer.map((s) => s.fightingStyle));
      // Full 7×7 grid guarantees the offer spans STARTER_OFFER_SIZE distinct
      // affinities AND styles, so it can never collapse to one Temperament.
      expect(affinities.size).toBe(STARTER_OFFER_SIZE);
      expect(styles.size).toBe(STARTER_OFFER_SIZE);
    }
  });

  it('is deterministic for the same seed', () => {
    const first = generateStarterOffer(new SeededRandom(42));
    const second = generateStarterOffer(new SeededRandom(42));
    expect(second.map((s) => s.speciesId)).toEqual(first.map((s) => s.speciesId));
  });

  it('differs across seeds (extremely likely for a 52-species roster)', () => {
    const a = generateStarterOffer(new SeededRandom(1));
    const b = generateStarterOffer(new SeededRandom(2));
    expect(a.map((s) => s.speciesId)).not.toEqual(b.map((s) => s.speciesId));
  });

  it('may include signature species (not excluded from the pool)', () => {
    const allSignatureIds = new Set(
      loadPetSpecies()
        .filter((s) => s.signature === true)
        .map((s) => s.speciesId),
    );
    // Sweep a range of seeds; at least one offer should include a signature line.
    let sawSignature = false;
    for (let seed = 1; seed <= 200; seed++) {
      const offer = generateStarterOffer(new SeededRandom(seed));
      if (offer.some((s) => allSignatureIds.has(s.speciesId))) {
        sawSignature = true;
        break;
      }
    }
    expect(sawSignature).toBe(true);
  });
});

describe('generateTrainerPoachOffer', () => {
  it("offers that Trainer's COMPLETE validated roster so the player can choose any of them (spec §6.2)", () => {
    const trainerRoster = ['ember-charger', 'bloom-bruiser', 'stone-slinger'];
    const offer = generateTrainerPoachOffer(new SeededRandom(7), trainerRoster);
    // All 2–3 fielded Companions are offered, not a random subset.
    expect(offer).toHaveLength(trainerRoster.length);
    expect(new Set(offer.map((s) => s.speciesId))).toEqual(new Set(trainerRoster));
    for (const species of offer) {
      expect(trainerRoster).toContain(species.speciesId);
    }
  });

  it('drops only unknown species ids and still offers the rest of the roster', () => {
    const offer = generateTrainerPoachOffer(new SeededRandom(7), [
      'ember-charger',
      'not-a-real-species',
      'stone-slinger',
    ]);
    expect(offer.map((s) => s.speciesId).sort()).toEqual(['ember-charger', 'stone-slinger']);
  });

  it('silently drops unknown species ids', () => {
    const offer = generateTrainerPoachOffer(new SeededRandom(7), ['not-a-real-species']);
    expect(offer).toHaveLength(0);
  });

  it('collapses duplicate ids so the same species is never offered twice', () => {
    const offer = generateTrainerPoachOffer(new SeededRandom(3), [
      'ember-charger',
      'ember-charger',
      'stone-slinger',
    ]);
    expect(offer.map((s) => s.speciesId).sort()).toEqual(['ember-charger', 'stone-slinger']);
  });

  it('is deterministic for the same seed', () => {
    const trainerRoster = ['ember-charger', 'bloom-bruiser', 'stone-slinger'];
    const first = generateTrainerPoachOffer(new SeededRandom(9), trainerRoster);
    const second = generateTrainerPoachOffer(new SeededRandom(9), trainerRoster);
    expect(second.map((s) => s.speciesId)).toEqual(first.map((s) => s.speciesId));
  });
});

describe('aiTypeForSpecies', () => {
  it('maps every style to a valid AI_TYPE', () => {
    const validAiTypes = new Set<number>(Object.values(AI_TYPE));
    for (const species of loadPetSpecies()) {
      expect(validAiTypes.has(aiTypeForSpecies(species))).toBe(true);
    }
  });
});

describe('recruitCompanion', () => {
  const baseOptions = {
    x: 0,
    y: 0,
    hp: 100,
    speed: 0.1,
    aggroRange: 999,
    attackRange: 0,
    ownerTeam: TeamId.PLAYER,
  };

  it('recruits a Companion and assigns the next party slot', () => {
    const world = createTestWorld();
    const eid = recruitCompanion(world, 'ember-charger', baseOptions);
    expect(eid).toBeDefined();
    expect(hasComponent(world.ecs, eid!, Companion)).toBe(true);
    expect(hasComponent(world.ecs, eid!, PartySlot)).toBe(true);
    expect(hasComponent(world.ecs, eid!, Team)).toBe(true);
    expect(world.stores.partySlot.slot[eid!]).toBe(0);
    expect(world.stores.partySlot.locked[eid!]).toBe(0);
  });

  it('returns undefined for an unknown species id', () => {
    const world = createTestWorld();
    expect(recruitCompanion(world, 'not-a-real-species', baseOptions)).toBeUndefined();
  });

  it('locks the party once it reaches PARTY_MAX_SIZE and refuses further recruits', () => {
    const world = createTestWorld();
    const recruited: number[] = [];
    for (let i = 0; i < PARTY_MAX_SIZE; i++) {
      const eid = recruitCompanion(world, 'ember-charger', baseOptions);
      expect(eid).toBeDefined();
      recruited.push(eid!);
    }
    expect(partyMembers(world, TeamId.PLAYER)).toHaveLength(PARTY_MAX_SIZE);
    expect(isPartyLocked(world, TeamId.PLAYER)).toBe(true);
    expect(world.stores.partySlot.locked[recruited[recruited.length - 1]!]).toBe(1);

    const extra = recruitCompanion(world, 'ember-charger', baseOptions);
    expect(extra).toBeUndefined();
    expect(partyMembers(world, TeamId.PLAYER)).toHaveLength(PARTY_MAX_SIZE);
  });

  it("does not affect another team's party (locking is per-team)", () => {
    const world = createTestWorld();
    for (let i = 0; i < PARTY_MAX_SIZE; i++) {
      recruitCompanion(world, 'ember-charger', baseOptions);
    }
    expect(isPartyLocked(world, TeamId.PLAYER)).toBe(true);

    const rivalEid = recruitCompanion(world, 'ember-charger', {
      ...baseOptions,
      ownerTeam: TeamId.ENEMY,
    });
    expect(rivalEid).toBeDefined();
    expect(isPartyLocked(world, TeamId.ENEMY)).toBe(false);
  });
});
