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
 */

/** Discriminant for every announcement kind the banner can render. */
export type AnnouncementKind = 'spawnerArenaStart' | 'spawnerArenaEnd' | 'bossAbilityCast';

export interface AnnouncementEvent {
  /** Which announcement preset the HUD should render. */
  readonly kind: AnnouncementKind;
  /**
   * Archetype index into `SPAWNER_ARCHETYPES` (or a future analogous registry).
   * Core emits the index only; the engine/HUD resolves the display name so
   * `src/core` never imports from `src/game`.
   */
  readonly archetypeIndex: number;
  /**
   * Fallback display name, populated by the pusher when a resolvable name is
   * available (e.g. game-layer callers with the archetype in hand). Kept
   * optional so pure-core call sites can push without knowing the name — the
   * HUD falls back to a generic label.
   */
  readonly displayName?: string;
  /** How long the banner should be shown, in milliseconds. */
  readonly durationMs: number;
  /** Simulation timestamp at which the event was pushed (`world.elapsedMs`). */
  readonly elapsedMs: number;
  /**
   * Exact, verbatim banner text. Set by boss-ability casts (`bossAbilityCast`)
   * which carry a full authored announcement string that must render exactly
   * (never ellipsized or reconstructed from an archetype index). Optional so
   * spawner-arena events can keep using `archetypeIndex` + `displayName`.
   */
  readonly text?: string;
  /**
   * Optional stable event identity used by producers/consumers that need
   * cancellation semantics (e.g. mob-ability telegraphs canceled before
   * resolution). Non-cancelable announcement kinds may omit it.
   */
  readonly eventId?: string;
}

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
