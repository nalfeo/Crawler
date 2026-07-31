/**
 * Announcement-banner events queued by core/game systems and drained by the
 * engine-layer HUD banner. Data-only (no Phaser imports) so `src/core` stays
 * portable — same bridge pattern as `combat-events.ts` and `vfx-events.ts`.
 *
 * The queue lives on `world.announcements`; the HUD banner (`HudAnnouncementBanner`)
 * is the sole consumer and drains events as they are surfaced. Determinism-safe:
 * events carry `elapsedMs` (from `world.elapsedMs`) so their trigger tick is
 * inspectable in tests without touching wall-clock time.
 *
 * Extensible: `AnnouncementKind` is a string union so future features (boss
 * intros, floor transitions, quest reveals) can reuse the same banner slot.
 *
 * `AnnouncementEvent` is a discriminated union on `kind`. Each variant only
 * carries the fields its renderer actually needs, making invalid states
 * (e.g. a boss cast with no text, a spawner event with a mandatory eventId)
 * unrepresentable at the type level.
 */

/** Discriminant for every announcement kind the banner can render. */
export type AnnouncementKind =
  | 'spawnerArenaStart'
  | 'spawnerArenaEnd'
  | 'bossAbilityCast'
  | 'skillPassiveUnlocked';

/**
 * Spawner-arena announcement — signals the start or end of a combat-wave
 * arena. The HUD renders the archetype's display name plus a state verb.
 */
export interface SpawnerArenaAnnouncementEvent {
  readonly kind: 'spawnerArenaStart' | 'spawnerArenaEnd';
  /**
   * Archetype index into `SPAWNER_ARCHETYPES`. Core emits the index only;
   * the HUD resolves the display name so `src/core` never imports `src/game`.
   */
  readonly archetypeIndex: number;
  /**
   * Fallback display name, populated by game-layer callers with the archetype
   * in hand. The HUD falls back to a generic label when absent.
   */
  readonly displayName?: string;
  /** How long the banner should be shown, in milliseconds. */
  readonly durationMs: number;
  /** Simulation timestamp at which the event was pushed (`world.elapsedMs`). */
  readonly elapsedMs: number;
}

/**
 * Boss-ability cast announcement — carries a full authored announcement string
 * and a stable identity for cancellation. Both `text` and `eventId` are
 * required: a cast with no text would render as an empty banner, and a cast
 * with no `eventId` cannot participate in telegraph-cancel pruning.
 */
export interface BossAbilityCastAnnouncementEvent {
  readonly kind: 'bossAbilityCast';
  /** `-1` sentinel; boss-ability casts have no spawner archetype. */
  readonly archetypeIndex: number;
  /**
   * Exact, verbatim banner text. Must render as authored — never ellipsized
   * or reconstructed from an archetype index.
   */
  readonly text: string;
  /**
   * Stable event identity used for cancellation semantics. The HUD prunes
   * local-queue entries whose `eventId` is no longer present in
   * `world.announcements` (e.g. telegraphs canceled before resolution).
   */
  readonly eventId: string;
  /** How long the banner should be shown, in milliseconds. */
  readonly durationMs: number;
  /** Simulation timestamp at which the event was pushed (`world.elapsedMs`). */
  readonly elapsedMs: number;
}

/**
 * Skill-passive-unlock announcement — fired exactly once, from the level-5
 * skill-milestone grant site (`skillSystem.ts`), when a passive ability is
 * granted. Fires for both general (no-prerequisite) and weapon-gated passive
 * grants alike — this is a one-time "you unlocked X" fact independent of
 * whether the passive's stat effects are immediately active.
 */
export interface SkillPassiveUnlockedAnnouncementEvent {
  readonly kind: 'skillPassiveUnlocked';
  /** `-1` sentinel; skill-passive unlocks have no spawner archetype. */
  readonly archetypeIndex: number;
  /** Exact, verbatim banner text, e.g. "Passive Unlocked: Combat Flow". */
  readonly text: string;
  /** How long the banner should be shown, in milliseconds. */
  readonly durationMs: number;
  /** Simulation timestamp at which the event was pushed (`world.elapsedMs`). */
  readonly elapsedMs: number;
}

/**
 * Discriminated union of every announcement variant the banner can render.
 * Narrow on `kind` to access variant-specific fields.
 */
export type AnnouncementEvent =
  | SpawnerArenaAnnouncementEvent
  | BossAbilityCastAnnouncementEvent
  | SkillPassiveUnlockedAnnouncementEvent;

/**
 * Hard cap on `world.announcements` — the HUD drains quickly under normal play
 * but headless / lab runs have no consumer, so growth is capped defensively
 * (oldest dropped). Announcement data is HUD-only, so dropping is harmless.
 */
const ANNOUNCEMENT_EVENT_CAP = 32;

/** Push an announcement, enforcing {@link ANNOUNCEMENT_EVENT_CAP}. */
export function pushAnnouncement(events: AnnouncementEvent[], event: AnnouncementEvent): void {
  events.push(event);
  if (events.length > ANNOUNCEMENT_EVENT_CAP) {
    events.splice(0, events.length - ANNOUNCEMENT_EVENT_CAP);
  }
}
