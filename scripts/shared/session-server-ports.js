import path from 'node:path';

const SESSION_PORT_BLOCK_BASE = 4100;
const SESSION_PORT_BLOCK_SIZE = 20;
const SESSION_PORT_SLOT_COUNT = 1000;

const DEFAULT_OFFSETS = Object.freeze({
  game: 0,
  lab: 1,
  devtools: 2,
  sidecar: 10,
});

function parsePort(rawValue) {
  if (rawValue == null || rawValue === '') {
    return null;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    return null;
  }
  return parsed;
}

function getProcessCwd() {
  return globalThis.process?.cwd?.() ?? '.';
}

function getProcessEnv() {
  return globalThis.process?.env ?? {};
}

export function normalizeWorkspaceKey(cwd = getProcessCwd()) {
  // Always normalize to Windows-style paths for consistent port derivation across platforms
  return path.win32.normalize(cwd).toLowerCase();
}

export function hashWorkspaceKey(key) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function deriveSessionPortBlock(cwd = getProcessCwd()) {
  const key = normalizeWorkspaceKey(cwd);
  const slot = hashWorkspaceKey(key) % SESSION_PORT_SLOT_COUNT;
  return SESSION_PORT_BLOCK_BASE + slot * SESSION_PORT_BLOCK_SIZE;
}

export function getSessionServerPorts(options = {}) {
  const cwd = options.cwd ?? getProcessCwd();
  const env = options.env ?? getProcessEnv();
  const block = deriveSessionPortBlock(cwd);

  const gamePort = parsePort(env.CRAWLER_DEV_PORT) ?? block + DEFAULT_OFFSETS.game;
  const labPort = parsePort(env.CRAWLER_LAB_PORT) ?? block + DEFAULT_OFFSETS.lab;
  const devtoolsPort = parsePort(env.CRAWLER_DEVTOOLS_PORT) ?? block + DEFAULT_OFFSETS.devtools;
  const sidecarPort = parsePort(env.SPRITES_SIDECAR_PORT) ?? block + DEFAULT_OFFSETS.sidecar;

  return {
    gamePort,
    labPort,
    devtoolsPort,
    sidecarPort,
    gameBaseUrl: `http://localhost:${gamePort}`,
    labBaseUrl: `http://localhost:${labPort}`,
    devtoolsBaseUrl: `http://localhost:${devtoolsPort}`,
    sidecarBaseUrl: `http://127.0.0.1:${sidecarPort}`,
  };
}

export function getVitePortForMode(mode, options = {}) {
  const ports = getSessionServerPorts(options);
  switch (mode) {
    case 'lab':
      return ports.labPort;
    case 'devtools':
      return ports.devtoolsPort;
    default:
      return ports.gamePort;
  }
}
