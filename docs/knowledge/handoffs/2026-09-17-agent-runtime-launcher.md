# Handoff — Pinned agent runtime launcher

## Systems touched

agent command runtime, Windows preflight bootstrap, npm package scripts

## Summary

- Added a checked-in launcher that resolves the Node version pinned by
  `.node-version` before running TypeScript agent tools or npm.
- Added a Windows-only preload for managed execution tokens where
  `os.userInfo()` fails with libuv's misleading `uv_os_get_passwd ENOMEM`.
  The preload steers `tsx` away from that lookup without changing process
  identity or credentials.
- Routed every package script that directly invoked `tsx` through the launcher,
  including the canonical preflight entrypoint.
- Routed preflight's Bash-side dependency refresh through the launcher's npm
  mode so Git Bash PATH rewriting cannot fall back to system Node.
- Aligned direct `actions/setup-node` workflow steps with `.node-version` so CI
  provisions the exact runtime enforced by the launcher.
- Added unit coverage for pinned-runtime discovery, npm resolution, preload
  propagation, and the no-direct-`tsx` package-script invariant.

## Planning contract

- Hard gate: invoking the normal npm scripts from a host with a non-pinned Node
  and a restricted Windows token selects Node 22.23.2 and does not call the
  failing Windows user lookup from `tsx`.
- Gate status: READY.
- Routing: DevOps owns the launcher and package-script integration.
- Dependencies: runtime discovery -> identity preload -> TSX/npm child process.
- Human routing corrections: `uv_os_get_passwd ENOMEM` is a runtime/token
  mismatch, not memory pressure.

## Validation

- `node --test scripts/agent/run-tsx.test.mjs scripts/agent/preflight-bootstrap.test.mjs`
- `npm run preflight`
- `npm run telemetry:token-budget -- --help`
- `npm run verify:fast`

## Follow-up

- Use `node scripts/agent/run-tsx.mjs` for new TypeScript package scripts and
  `node scripts/agent/run-tsx.mjs --npm` for npm calls made from Bash tooling.
