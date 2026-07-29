# Handoff: Fix deprecated claude-sonnet-4.5 model references

**Date:** 2026-07-28  
**Session slug:** `fix-deprecated-models-in-sessions`  
**Apple estimate:** 1🍎 (tooling-only, capped)  
**Closes:** #2209

## Systems touched

ci-policy

## Summary

`claude-sonnet-4.5` was deprecated by GitHub on 2026-05-06. Any session or
`task()` call that requests it fails at `session.create` with
`Model "claude-sonnet-4.5" is not available`. This caused a wave of CI recovery
loop-incidents (#2196, #2140, and earlier documented in handoffs 2026-07-25-\*).

This PR removes the deprecated model from accessible configuration and adds a
prominent warning in the agent instructions so future sessions do not accidentally
request it.

## Files Changed

- **`.github/extensions/agent-perf-panel/analyzer.mjs`** — Removed
  `'claude-sonnet-4.5': 200_000` from the `MODEL_CONTEXT_WINDOW` exact-match table
  (display-only context window data). Also added `claude-opus-4.8` and
  `gemini-3.6-flash` to keep the table current. The prefix fallback
  `['claude-', 200_000]` continues to resolve any residual historical session data
  that carries the deprecated model name.

- **`AGENTS.md`** — Added a "Known Environment Quirks" entry warning agents NOT to
  use `claude-sonnet-4.5` and to use `claude-sonnet-4.6` or `claude-sonnet-5`
  instead.

- **`.github/copilot-instructions.md`** — Added a Critical Rules bullet with the
  same deprecation warning.

## Validation

- `node --test .github/extensions/agent-perf-panel/tests/analyzer.test.mjs` → 46/46 pass

## What This Does NOT Fix (requires platform action)

The **root cause** — sessions being dispatched with `claude-sonnet-4.5` as their
default model — must be fixed at the GitHub platform level:

1. **Repository Settings → Copilot → Coding Agent → Model**: Change to
   `claude-sonnet-4.6` (or `claude-sonnet-5`) via the GitHub repository settings
   UI.

2. **`.github/agents/*.agent.md` files**: These files are restricted from agent
   access per repository rules. If any agent file contains `model: claude-sonnet-4.5`,
   it must be updated manually by the repo owner to `model: claude-sonnet-4.6`.

## Recommended Next Steps

1. Repo owner (@nalfeo) should update the default Copilot model in GitHub repository
   settings to `claude-sonnet-4.6` or `claude-sonnet-5`.
2. Review `.github/agents/*.agent.md` files for any explicit `model: claude-sonnet-4.5`
   settings and update them.
3. Once the platform default is changed, the CI loop-incidents (#2196, #2140) should
   stop recurring.
