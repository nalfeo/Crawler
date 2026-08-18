/**
 * Shared constants for the e2e test suite.
 *
 * The global-setup module spawns a Vite lab server on E2E_LAB_PORT.
 * Test files use E2E_LAB_BASE_URL to construct lab page URLs.
 */

export const E2E_LAB_PORT = Number(process.env.CRAWLER_E2E_LAB_PORT ?? 5299);
export const E2E_LAB_BASE_URL = `http://localhost:${E2E_LAB_PORT}`;

/** Phaser game canvas dimensions as defined in src/shared/constants.ts */
export const GAME_W = 1280;
export const GAME_H = 720;
