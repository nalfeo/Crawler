import { entityExists, query } from 'bitecs';
import { describe, expect, it, vi } from 'vitest';
import { Health, Player } from '../../src/core/components.js';
import type { GameWorld } from '../../src/core/world.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIInputProvider, type AIDecision } from '../../src/game/ai/types.js';
import { denUnlockGoalId } from '../../src/game/floor2Scenario.js';
import { FLOOR2_BOSS_ABILITY_CATALOG } from '../../src/shared/boss-abilities.js';
import type { InputState } from '../../src/shared/input.js';

const selection = vi.hoisted(() => ({ families: [] as string[] }));
vi.mock('../../src/shared/floor-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/floor-registry.js')>();
  return {
    ...actual,
    getFloorManifest: (id: string) => {
      const manifest = actual.getFloorManifest(id);
      return id === 'floor2' && manifest
        ? {
            ...manifest,
            floor2: { ...manifest.floor2, familyPool: selection.families, presentCount: 4 },
          }
        : manifest;
    },
  };
});

interface Observation {
  family: string;
  cues: number;
  casts: number;
  cleaned: boolean;
}
class SignatureObserver implements AIInputProvider {
  debug: unknown;
  readonly results: Observation[] = [];
  private cursor = 0;
  private defeated = false;
  private boss: number | null = null;
  private owned = new Map<number, number>();
  poll(_input: InputState, world: GameWorld): void {
    const player = query(world.ecs, [Player, Health])[0]!;
    const encounters = [...world.floorExtendedState!.familyState!.bossEncounters!.values()];
    const encounter = encounters[this.cursor];
    if (!encounter) {
      // This is an observation cutoff, not a survival/victory assertion.
      world.stores.health.current[player] = 0;
      return;
    }
    world.stores.health.current[player] = 1_000_000;
    world.stores.health.max[player] = 1_000_000;
    if (this.defeated) {
      const boss = this.boss!;
      const result = this.results[this.cursor]!;
      result.cleaned =
        encounter.defeated &&
        !world.mobAbilities.byEntity.has(boss) &&
        !world.mobAbilities.registrationTokens.has(boss) &&
        !world.mobAbilities.cues.some((cue) => cue.casterEid === boss) &&
        !world.mobAbilities.activeProjectiles.some((effect) => effect.casterEid === boss) &&
        !world.mobAbilities.activeZones.some((effect) => effect.casterEid === boss) &&
        !world.mobAbilities.ownedZones.some((effect) => effect.casterEid === boss) &&
        !world.mobAbilities.activeBuffsByEntity.has(boss) &&
        !world.mobAbilities.recoveriesByEntity.has(boss) &&
        [...this.owned].every(
          ([eid, generation]) =>
            !entityExists(world.ecs, eid) || world.entityRenderGeneration[eid] !== generation,
        );
      if (result.cleaned) {
        this.cursor++;
        this.defeated = false;
        this.boss = null;
        this.owned.clear();
      }
      return;
    }
    const boss = encounter.bossEid!;
    this.boss = boss;
    world.stores.health.current[boss] = 1_000_000;
    world.stores.health.max[boss] = 1_000_000;
    // Only unlock and enter the den; the normal objective tick performs all
    // registration and activation. Never call ability factories/runtime here.
    world.goalFlags.set(denUnlockGoalId(encounter.familyId), true);
    const map = world.floorMap!;
    const room = map.roomGraph.get(encounter.roomId)!;
    const candidates = (room.interiorCells ?? []).map((tile) => map.tileToWorld(tile.x, tile.y));
    const bossX = world.stores.position.x[boss]!,
      bossY = world.stores.position.y[boss]!;
    const location = candidates.sort(
      (a, b) =>
        Math.abs(Math.hypot(a.x - bossX, a.y - bossY) - 12) -
        Math.abs(Math.hypot(b.x - bossX, b.y - bossY) - 12),
    )[0];
    world.stores.position.x[player] = location?.x ?? encounter.bossSpawnX! + 8;
    world.stores.position.y[player] = location?.y ?? encounter.bossSpawnY!;
    if (!this.results[this.cursor])
      this.results.push({ family: encounter.familyId, cues: 0, casts: 0, cleaned: false });
    const result = this.results[this.cursor]!;
    const instance = world.mobAbilities.byEntity.get(boss);
    this.debug = {
      started: encounter.started,
      boss,
      appearance: world.enemyAppearanceKeys.get(boss),
      phase: instance?.phase,
      timer: instance?.timerMs,
      x: world.stores.position.x[player],
      y: world.stores.position.y[player],
    };
    if (!instance) return;
    for (const [eid, generation] of instance.ownedEntityGenerations)
      this.owned.set(eid, generation);
    if (
      world.mobAbilities.cues.some((cue) => cue.casterEid === boss && cue.phase === 'telegraph')
    ) {
      result.cues = Math.max(result.cues, instance.announcementsEmitted);
    }
    result.casts = instance.resolvedCasts;
    if (result.casts >= 2) {
      world.stores.health.current[boss] = 0;
      this.defeated = true;
    }
  }
  getDecision(): AIDecision {
    return {
      state: AIState.EXPLORE,
      targetEid: null,
      targetX: null,
      targetY: null,
      reason: 'observe Floor 2 signature contract',
      npcInteraction: null,
      debug: null,
    };
  }
  reset(): void {}
}

const families = FLOOR2_BOSS_ABILITY_CATALOG.entries.map((entry) => entry.familyId);
const batches = Array.from({ length: 5 }, (_, index) => {
  const batch = families.slice(index * 4, index * 4 + 4);
  return batch.length === 4 ? batch : [...batch, ...families.slice(0, 4 - batch.length)];
});

describe('all eighteen Floor 2 signatures in the real headless pipeline', () => {
  for (const [index, batch] of batches.entries()) {
    it(`roster ${index + 1}: ${batch.join(', ')} casts twice and cleans owned state`, async () => {
      selection.families = batch;
      const observer = new SignatureObserver();
      const stats = await runHeadless(observer, {
        floorId: 'floor2',
        seed: 42,
        maxFrames: 10_000,
        questStallFrames: 10_000,
      });
      expect(
        observer.results.map((result) => result.family).sort(),
        JSON.stringify({
          debug: observer.debug,
          observations: observer.results,
          outcome: stats.outcome,
          frames: stats.totalFrames,
          stall: stats.stallReason,
        }),
      ).toEqual([...batch].sort());
      for (const result of observer.results) {
        expect(result.cues, `${result.family}: committed public telegraphs`).toBeGreaterThanOrEqual(
          2,
        );
        expect(
          result.casts,
          `${result.family}: actual signature resolutions`,
        ).toBeGreaterThanOrEqual(2);
        expect(result.cleaned, `${result.family}: normal death cleaned ability ownership`).toBe(
          true,
        );
      }
    }, 120_000);
  }
});
