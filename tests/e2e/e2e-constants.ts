/**
 * Shared constants for the e2e test suite.
 *
 * The global-setup module spawns a Vite lab server on E2E_LAB_PORT.
 * Test files use E2E_LAB_BASE_URL to construct lab page URLs.
 *
 * The port is derived per workspace (`scripts/shared/session-server-ports.js`)
 * rather than hardcoded: a fixed machine-global port let a second worktree —
 * or a leftover server from an earlier run — own the port first, in which case
 * `--strictPort` killed our own Vite and the suite silently ran against another
 * checkout's code (stale lab probes, wedged navigations). Set
 * `CRAWLER_E2E_LAB_PORT` to pin the port explicitly.
 */

import { getSessionServerPorts } from '../../scripts/shared/session-server-ports.js';

export const E2E_LAB_PORT = getSessionServerPorts().e2eLabPort;
export const E2E_LAB_BASE_URL = `http://localhost:${E2E_LAB_PORT}`;

/** Phaser game canvas dimensions as defined in src/shared/constants.ts */
export const GAME_W = 1280;
export const GAME_H = 720;
