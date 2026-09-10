# Windows preflight bootstrap

## Systems touched

- `scripts/agent/preflight.mjs` — Node-only Windows bootstrap for the canonical Bash preflight.
- `scripts/agent/preflight-bootstrap.test.mjs` — deterministic fixture coverage.
- `scripts/agent/preflight.sh` — recognizes bootstrap-owned dependency setup.
- `package.json` and setup docs — canonical `npm run preflight` entry point.

## What changed

Added `npm run preflight`, a Node-only bootstrap that finds Git Bash at its
standard Windows installation path even when it is absent from PATH. In a fresh
worktree it runs `npm ci --prefer-offline` once (with browser download deferred)
using a worktree-local npm cache, then transfers to the existing canonical Bash
preflight with a one-run signal that prevents a duplicate `npm ci`. This avoids
locked shared-cache failures and redundant setup work between Codex worktrees.

## Validation

- `node --test scripts/agent/preflight-bootstrap.test.mjs` — 7 passing tests.
- `node --check scripts/agent/preflight.mjs` — passed.
- Git Bash 5.3.15 is installed at the standard path the bootstrap resolves.
- A real fresh-worktree `npm run preflight` installed 461 packages in 15s,
  skipped the duplicate dependency phase, installed Playwright, typechecked,
  and completed in 27s (within the warm-cache target).
- `npm run verify:fast` — passed.
- `npm run scope -- --path scripts/agent/preflight.mjs` — completed.

## Telemetry

The original startup capture was blocked by the missing local `tsx` binary. The
new bootstrap removes that prerequisite; the completed run wrote
`files/preflight-timing.json` and `npm run telemetry:capture` found no guard
telemetry events to capture.

## Apples

Estimated 🍎🍎; actual 🍎🍎🍎 — 📉 Under. The scope changed from a diagnostic to
a canonical Windows setup fix plus migration of all agent/skill entry points.
