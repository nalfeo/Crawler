#!/usr/bin/env node
// Portable launcher for the official @modelcontextprotocol/server-memory.
//
// Why this wrapper exists: the memory server resolves a *relative*
// MEMORY_FILE_PATH against its own npx-cache install dir (not the repo), so it
// needs an *absolute* path — but a hard-coded absolute path in .mcp.json is
// machine-specific and Copilot worktrees rotate per session. This script keeps
// .mcp.json free of any user-specific path by resolving a stable per-user live
// graph file at launch, seeding it once from the committed snapshot, then
// handing off to the real server with MEMORY_FILE_PATH set.
//
// The Copilot CLI does NOT expand ${env:...}/${workspaceFolder} in .mcp.json,
// which is why resolution happens here in code. See docs/guides/agent-memory.md.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoSnapshot = join(scriptDir, '..', '..', 'docs', 'knowledge', 'agent-memory.jsonl');

// Stable, per-user live graph file. Override with CRAWLER_MEMORY_FILE_PATH for
// custom setups (e.g. CI or a shared location).
const liveFile =
  process.env.CRAWLER_MEMORY_FILE_PATH ??
  join(homedir(), '.copilot', 'crawler-memory', 'agent-memory.jsonl');

function log(message) {
  process.stderr.write(`[mcp-memory] ${message}\n`);
}

// Create the live file's directory and seed it once from the committed
// snapshot. Never overwrite an existing live file — it may hold memory the
// agents have accumulated since the last commit.
function ensureLiveFile() {
  mkdirSync(dirname(liveFile), { recursive: true });
  if (existsSync(liveFile)) {
    return;
  }
  if (existsSync(repoSnapshot)) {
    copyFileSync(repoSnapshot, liveFile);
    log(`seeded live memory graph from snapshot -> ${liveFile}`);
  } else {
    log(`no snapshot at ${repoSnapshot}; server will start with an empty graph`);
  }
}

ensureLiveFile();

// `--ensure` lets session setup (preflight) create and seed the live file
// without starting the long-lived server.
if (process.argv.includes('--ensure')) {
  log(`live memory graph ready at ${liveFile}`);
  process.exit(0);
}

// `shell: true` lets the OS shell resolve `npx` -> `npx.cmd` on Windows and
// avoids the Node restriction on spawning `.cmd` files directly. The command is
// a fixed literal passed as a single string (no args array, no interpolation),
// so there is no injection surface and no DEP0190 warning. `stdio: inherit`
// makes this process transparent to the MCP stdio (JSON-RPC) stream.
const child = spawn('npx -y @modelcontextprotocol/server-memory', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, MEMORY_FILE_PATH: liveFile },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on('error', (error) => {
  log(`failed to start memory server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
