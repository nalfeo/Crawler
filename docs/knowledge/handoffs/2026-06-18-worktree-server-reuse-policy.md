# Session Handoff: Worktree server reuse policy

## Date

2026-06-18

## Summary

Updated agent operating guidance to prevent duplicate dev/lab/devtools server launches within a single session. The new policy directs agents to reuse an existing healthy session server for hot reload, or stop the existing session-bound server before launching a replacement. Guidance now also requires launch output to include the URL every time.

## Files touched

- `AGENTS.md`
- `docs/agent-os/personas/devops-engineer.md`

## Verification run

- `npm run verify:fast` (pass)
- `npm run verify` (fail: dead-code gate reported 48 unused files)

## Unresolved issues

- Full verify currently fails at the dead-code step and must be fixed before this work can be considered fully green.

## Recommended next steps

1. Fix the dead-code findings (or dead-code gate configuration) so `npm run verify` passes.
2. Keep future server-launch automation aligned with the new single-server-per-session lifecycle rules.

## Apples

Estimated: 🍎🍎  
Actual: 🍎🍎  
Verdict: 🎯 Exact

Hello kitties: 0.40 🎀
