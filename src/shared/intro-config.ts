/**
 * Shared constants for the player intro (name / gender) data flow.
 *
 * Placed in `src/shared/` so both the engine layer (IntroScene, MainGameScene)
 * and unit tests can import without pulling in Phaser.
 */

/** Phaser game-registry key used by IntroScene to hand off player identity. */
export const INTRO_DATA_REGISTRY_KEY = 'crawlerIntroData';

/** Player gender options accepted by the intro and stored on the world. */
export type PlayerGender = 'female' | 'male' | 'other';

/** Default player name when no intro screen is shown (headless / lab runs). */
export const DEFAULT_PLAYER_NAME = 'Rhea Vale';

/** Default player gender when no intro screen is shown. */
export const DEFAULT_PLAYER_GENDER: PlayerGender = 'female';
