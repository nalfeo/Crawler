/**
 * Pure resolver for the boss-battle intro lore sheet.
 *
 * Answers one question per frame: "is there a boss battle that just started
 * and has not been introduced yet?". Split out of `MainGameScene` so the
 * trigger rules can be unit-tested without instantiating Phaser (mirrors the
 * `boss-health-bar-state.ts` pattern). No rendering imports live here.
 *
 * Covers BOTH boss sources so every boss mob gets an intro:
 *  - Floor 1's scripted `floorScenario.objective.bossBattles`
 *  - Floor 2's family den `floorExtendedState.familyState.bossEncounters`
 */
import { entityExists } from 'bitecs';
import type { GameWorld } from '../core/world.js';
import type { FloorBossEncounterState } from '../shared/floor-types.js';
import {
  fallbackBossIntro,
  familyBossIntroFor,
  floor1BossIntro,
  type BossIntroContent,
} from '../shared/boss-intro.js';

/** A boss whose intro should play right now. */
export interface PendingBossIntro {
  /** Sheet content to render. */
  readonly content: BossIntroContent;
  /** Boss entity the intro is about (used for portrait framing/logging). */
  readonly bossEid: number;
}

/**
 * True when this encounter is live: the battle has begun, the boss is not
 * already dead, and its entity still exists. Encounters that were latched as
 * started+defeated without ever spawning (the Floor 1 debug skip) never
 * qualify, so the shortcut path does not pop an intro for a boss that is
 * already gone.
 */
function isLiveEncounter(encounter: FloorBossEncounterState, ecs: GameWorld['ecs']): boolean {
  return (
    encounter.started &&
    !encounter.defeated &&
    encounter.bossEid !== null &&
    entityExists(ecs, encounter.bossEid)
  );
}

/**
 * Find the first live boss encounter whose intro has not been shown yet, or
 * `null` when there is nothing to introduce.
 *
 * `shownIntroIds` is owned by the caller (the scene) and holds the
 * `BossIntroContent.introId` of every intro already presented this run, so an
 * intro plays exactly once per boss even though the encounter stays `started`
 * for the whole fight.
 */
export function resolvePendingBossIntro(
  world: GameWorld,
  shownIntroIds: ReadonlySet<string>,
): PendingBossIntro | null {
  const ecs = world.ecs;

  const bossBattles = world.floorScenario?.objective.bossBattles;
  if (bossBattles) {
    for (const [bossKey, encounter] of bossBattles) {
      if (!isLiveEncounter(encounter, ecs)) {
        continue;
      }
      const content =
        floor1BossIntro(bossKey) ?? fallbackBossIntro(`boss:${bossKey}`, encounter.displayName);
      if (!shownIntroIds.has(content.introId)) {
        return { content, bossEid: encounter.bossEid as number };
      }
    }
  }

  const familyEncounters = world.floorExtendedState?.familyState?.bossEncounters;
  if (familyEncounters) {
    for (const [familyId, encounter] of familyEncounters) {
      if (!isLiveEncounter(encounter, ecs)) {
        continue;
      }
      const content =
        familyBossIntroFor(familyId) ??
        fallbackBossIntro(`floor2:${familyId}`, encounter.displayName);
      if (!shownIntroIds.has(content.introId)) {
        return { content, bossEid: encounter.bossEid as number };
      }
    }
  }

  return null;
}
