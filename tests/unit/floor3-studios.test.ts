import { describe, expect, it } from 'vitest';
import {
  FINAL_FOUR_CANDIDATES,
  FLOOR3_FINAL_FOUR_SELECT_COUNT,
  FLOOR3_STUDIO_SELECT_COUNT,
  STUDIO_CANDIDATES,
  selectFloor3FinalFour,
  selectFloor3Studios,
} from '../../src/shared/data/floor3/studios.js';
import { getPetSpecies } from '../../src/shared/data/floor3/species.js';
import { SeededRandom, hashStringToSeed } from '../../src/shared/random.js';

describe('Floor 3 Studio + Final Four candidate data', () => {
  it('has a candidate pool larger than the selected count for both rosters', () => {
    expect(STUDIO_CANDIDATES.length).toBeGreaterThan(FLOOR3_STUDIO_SELECT_COUNT);
    expect(FINAL_FOUR_CANDIDATES.length).toBeGreaterThan(FLOOR3_FINAL_FOUR_SELECT_COUNT);
  });

  it('references only known Floor 3 species ids', () => {
    for (const studio of STUDIO_CANDIDATES) {
      for (const trainer of studio.trainers) {
        expect(trainer.companions.length).toBeGreaterThanOrEqual(2);
        for (const companion of trainer.companions) {
          expect(getPetSpecies(companion.speciesId)).toBeDefined();
        }
      }
    }
    for (const handler of FINAL_FOUR_CANDIDATES) {
      expect(handler.companions.length).toBeGreaterThanOrEqual(2);
      for (const companion of handler.companions) {
        expect(getPetSpecies(companion.speciesId)).toBeDefined();
      }
    }
  });

  it('has unique studioId/trainerId/handlerId keys', () => {
    const studioIds = new Set(STUDIO_CANDIDATES.map((s) => s.studioId));
    expect(studioIds.size).toBe(STUDIO_CANDIDATES.length);
    const trainerIds = new Set(
      STUDIO_CANDIDATES.flatMap((s) => s.trainers.map((t) => t.trainerId)),
    );
    expect(trainerIds.size).toBe(STUDIO_CANDIDATES.reduce((n, s) => n + s.trainers.length, 0));
    const handlerIds = new Set(FINAL_FOUR_CANDIDATES.map((h) => h.handlerId));
    expect(handlerIds.size).toBe(FINAL_FOUR_CANDIDATES.length);
  });
});

describe('Floor 3 Studio + Final Four seeded selection (spec R8 determinism)', () => {
  it('selects the configured count for both rosters', () => {
    const rng = new SeededRandom(hashStringToSeed('determinism-count'));
    expect(selectFloor3Studios(rng)).toHaveLength(FLOOR3_STUDIO_SELECT_COUNT);
    const rng2 = new SeededRandom(hashStringToSeed('determinism-count'));
    expect(selectFloor3FinalFour(rng2)).toHaveLength(FLOOR3_FINAL_FOUR_SELECT_COUNT);
  });

  it('same seed reproduces the identical Studio set AND order', () => {
    const seed = hashStringToSeed('floor3-determinism-seed-a');
    const a = selectFloor3Studios(new SeededRandom(seed)).map((s) => s.studioId);
    const b = selectFloor3Studios(new SeededRandom(seed)).map((s) => s.studioId);
    expect(a).toEqual(b);
  });

  it('same seed reproduces the identical Final Four set AND order', () => {
    const seed = hashStringToSeed('floor3-determinism-seed-b');
    const a = selectFloor3FinalFour(new SeededRandom(seed)).map((h) => h.handlerId);
    const b = selectFloor3FinalFour(new SeededRandom(seed)).map((h) => h.handlerId);
    expect(a).toEqual(b);
  });

  it('different seeds can reproduce a different Studio set or order', () => {
    const seeds = ['floor3-seed-1', 'floor3-seed-2', 'floor3-seed-3', 'floor3-seed-4'].map(
      hashStringToSeed,
    );
    const rosters = seeds.map((seed) =>
      selectFloor3Studios(new SeededRandom(seed)).map((s) => s.studioId),
    );
    const serialized = rosters.map((r) => r.join(','));
    expect(new Set(serialized).size).toBeGreaterThan(1);
  });

  it('never selects more than the candidate pool and rejects an over-large count', () => {
    const rng = new SeededRandom(hashStringToSeed('over-request'));
    expect(() => selectFloor3Studios(rng, STUDIO_CANDIDATES.length + 1)).toThrow();
  });
});
