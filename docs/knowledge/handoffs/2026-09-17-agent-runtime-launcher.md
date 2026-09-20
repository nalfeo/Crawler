# Handoff — Pinned agent runtime launcher

## Systems touched

agent command runtime, Windows preflight bootstrap, npm package scripts, review
policy, CI Recovery admission, merge-train admission

## Summary

- Added a checked-in launcher that resolves the Node version pinned by
  `.node-version` before running TypeScript agent tools or npm.
- When neither the current runtime nor fnm supplies the pin, the launcher now
  provisions the official Node archive into the ignored worktree cache and
  verifies it against Node's published SHA-256 manifest before use.
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
- Preflight prints the selected Node executable and version before bootstrap
  work, and local agent shell entry points are guarded against direct `tsx` or
  `npx tsx` execution.
- Removed the merge-train requirement for a substantive GitHub Copilot review.
  Admission still requires green configured checks and resolved review threads.
- Made a fresh local Ducky pass (`codex review --uncommitted`) mandatory before
  every implementation PR, with all blocking and medium findings fixed.
- Allowed a Codex/Ducky pass statement in the PR description, a commit message,
  or a PR comment as human-readable evidence rather than a machine-parsed gate.

## Planning contract

- Hard gate: invoking the normal npm scripts from a host with a non-pinned Node
  and a restricted Windows token selects Node 22.23.2 and does not call the
  failing Windows user lookup from `tsx`.
- Gate status: READY.
- Routing: DevOps owns the launcher and package-script integration.
- Dependencies: runtime discovery -> identity preload -> TSX/npm child process.
- Human routing corrections: `uv_os_get_passwd ENOMEM` is a runtime/token
  mismatch, not memory pressure.
- Environment recovery is bounded to one retry; a repeated runtime-selection
  failure is reported as a blocker rather than entering a diagnosis loop.

## Validation

- `node --test scripts/agent/run-tsx.test.mjs scripts/agent/preflight-bootstrap.test.mjs`
- `npm run preflight`
- `npm run telemetry:token-budget -- --help`
- `npm run verify:fast`
- Focused CI Recovery admission/lifecycle tests and the review-policy guard.
- Local Ducky review found a blocking Unix npm-layout issue in the runtime
  launcher; the platform-aware npm path and its Windows/Linux coverage resolve it.

## Follow-up

- Use `node scripts/agent/run-tsx.mjs` for new TypeScript package scripts and
  `node scripts/agent/run-tsx.mjs --npm` for npm calls made from Bash tooling.
