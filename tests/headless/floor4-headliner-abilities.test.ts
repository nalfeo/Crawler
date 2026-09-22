import { entityExists, query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Health, Player } from '../../src/core/components.js';
import type { GameWorld } from '../../src/core/world.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import { AIState, type AIInputProvider, type AIDecision } from '../../src/game/ai/types.js';
import { GAME } from '../../src/shared/constants.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import { buildFloor4HeadlinerCard } from '../../src/shared/floor4-headliners.js';
import type { InputState } from '../../src/shared/input.js';
import authored from '../../src/shared/data/boss-abilities.floor4.json';

const config = getFloorManifest('floor4')!.floor4!;

function selection(archetype: string) {
  for (let seed = 42; seed < 142; seed++) {
    const entry = buildFloor4HeadlinerCard(config.headliners, seed).find(
      (card) => card.archetypeId === archetype,
    );
    if (entry) return { seed, entry };
  }
  throw new Error(`No selectable card found for ${archetype}`);
}

class SignatureObserver implements AIInputProvider {
  readonly trace: unknown[] = [];
  sawTelegraph = false;
  sawResolution = false;
  sawSecondTelegraph = false;
  cleanupObserved = false;
  maxOwned = 0;
  private staged = false;
  private defeated = false;
  private previous = '';
  private readonly ownedGenerations = new Map<number, number>();
  constructor(readonly archetype: string) {}
  poll(_input: InputState, world: GameWorld): void {
    const arena = world.floorExtendedState!.floor4Arena!;
    const player = query(world.ecs, [Player, Health])[0]!;
    world.stores.health.current[player] = 1_000_000;
    world.stores.health.max[player] = 1_000_000;
    if (!this.staged) {
      const card = arena.headlinerCard.find((entry) => entry.archetypeId === this.archetype)!;
      // Stage only the authored wave boundary. The production director spawns,
      // binds, activates and tears down the encounter on its next normal tick.
      arena.phase = { kind: 'WAVES', act: card.act };
      world.floorExtendedState!.floor4GreenRoom = {
        lastOpenedVisitIndex: card.act - 2,
        retiredVisitCount: card.act - 1,
        purchases: 0,
      };
      arena.arenaElapsedMs =
        (card.act - 1) * config.phase.actDurationMs + config.phase.waveWindowMs;
      const map = world.floorMap!;
      const center = map.tileToWorld(
        Math.floor(map.config.widthTiles / 2),
        Math.floor(map.config.heightTiles / 2),
      );
      world.stores.position.x[player] = center.x + 12;
      world.stores.position.y[player] = center.y;
      this.staged = true;
      return;
    }
    const boss = arena.activeHeadliner?.bossEid;
    if (this.defeated) {
      this.cleanupObserved =
        arena.activeHeadliner?.defeated === true &&
        world.mobAbilities.byEntity.size === 0 &&
        world.mobAbilities.cues.length === 0 &&
        world.mobAbilities.registrationTokens.size === 0 &&
        world.mobAbilities.activeProjectiles.length === 0 &&
        world.mobAbilities.activeZones.length === 0 &&
        world.mobAbilities.ownedZones.length === 0 &&
        world.mobAbilities.activeBuffsByEntity.size === 0 &&
        world.mobAbilities.recoveriesByEntity.size === 0 &&
        [...this.ownedGenerations].every(
          ([eid, generation]) =>
            !entityExists(world.ecs, eid) || world.entityRenderGeneration[eid] !== generation,
        );
      return;
    }
    if (boss === null || boss === undefined) return;
    world.stores.health.current[boss] = 1_000_000;
    world.stores.health.max[boss] = 1_000_000;
    const instance = world.mobAbilities.byEntity.get(boss);
    if (!instance) return;
    const key = `${instance.phase}:${instance.resolvedCasts}:${instance.announcementsEmitted}`;
    if (key !== this.previous) {
      this.trace.push({
        frame: world.frameCount,
        key,
        token: instance.registrationToken,
        geometry: structuredClone(instance.committedGeometry),
        owned: instance.ownedEntityGenerations.size,
      });
      this.previous = key;
    }
    this.maxOwned = Math.max(this.maxOwned, instance.ownedEntityGenerations.size);
    for (const [eid, generation] of instance.ownedEntityGenerations) {
      this.ownedGenerations.set(eid, generation);
    }
    if (
      instance.phase === 'telegraph' &&
      world.mobAbilities.cues.some((cue) => cue.casterEid === boss)
    ) {
      this.sawTelegraph = true;
      if (instance.resolvedCasts >= 1) this.sawSecondTelegraph = true;
    }
    if (instance.resolvedCasts >= 1 && instance.phase === 'cooldown' && instance.timerMs > 0) {
      this.sawResolution = true;
    }
    // End during a second pending cast: stale telegraphs and owned summons must
    // be removed by the real death/director path, not a test cleanup helper.
    if (this.sawSecondTelegraph) {
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
      reason: 'observe Headliner signature',
      npcInteraction: null,
      debug: null,
    };
  }
  reset(): void {}
}

async function observe(archetype: string) {
  const selected = selection(archetype);
  const ability = authored.entries.find((entry) => entry.bossArchetypeId === archetype)!;
  const observer = new SignatureObserver(archetype);
  await runHeadless(observer, {
    floorId: 'floor4',
    seed: selected.seed,
    maxFrames: Math.ceil(
      (ability.timing.firstEligibleAfterMs +
        ability.telegraph.durationMs +
        ability.timing.cooldownMs +
        3_000) /
        GAME.DELTA_MS,
    ),
  });
  return observer;
}

describe('Floor 4 authored signatures through the real headless pipeline', () => {
  it.each(config.headliners.pool)(
    '$archetypeId telegraphs, resolves, cools down and cleans up',
    async ({ archetypeId }) => {
      const result = await observe(archetypeId);
      expect(result.sawTelegraph, 'registered signature emitted its committed cue').toBe(true);
      expect(result.sawResolution, 'resolution entered an authored cooldown').toBe(true);
      expect(result.sawSecondTelegraph, 'cooldown permits another telegraph').toBe(true);
      expect(result.cleanupObserved, 'death removed bindings, cues and owned effects').toBe(true);
      if (archetypeId === 'floor4-showrunner') {
        expect(result.maxOwned).toBeGreaterThan(0);
        expect(result.maxOwned).toBeLessThanOrEqual(config.waves.concurrency.liveCap);
      }
      // One replay keeps this authored roster check at ten headless runs.
      if (archetypeId === 'floor4-showrunner') {
        expect((await observe(archetypeId)).trace).toEqual(result.trace);
      }
    },
  );
});
