# Floor 3 companion-distance hostile aggro

**Date:** 2026-09-09

**Persona:** Producer

**Verdict:** RECOMMENDED — the existing wild-hostility and companion redirect
seam provides a localized fix without changing combat tuning.

**Estimate:** 3 apples

**Actual:** 3 apples (exact) — the fix stayed within the planned redirect
system and deterministic regression coverage.

## Systems touched

ai-combat-balance, ai-pathfinding

## Summary

Floor 3 wild enemies previously redirected to the nearest player companion
regardless of distance. That allowed an off-screen or lagging companion to
override the wild's normal hostile player target and pull the encounter away
from the player. Wild redirection now only selects a player companion within
the authored Floor 3 wild aggro range; otherwise it leaves the decision unset,
so the standard hostile player path remains active. Nearby companion
engagement remains unchanged.

Added direct enemy-AI coverage and a real `runHeadless` regression that injects
an off-screen companion and hostile wild into the production Floor 3 pipeline.
The headless case confirms no companion override is emitted while hostility is
preserved.

## Verification

- `npx vitest run tests/headless/floor3-companion-aggro.test.ts tests/game/floor3-companion-combat.test.ts --project unit --project headless --reporter=dot`
- `bash scripts/agent/verify-fast.sh`
- `git diff --check`
- Prettier check/write on changed files

## Observation

Before the change, the production redirect selected the distant companion and
stamped a bypass-player decision. After the change, the same deterministic
headless scenario leaves the wild without a companion override, preserving its
hostile player aggro, while the existing nearby-companion redirect test still
passes.

## Risk

The engagement cutoff reuses the existing authored wild aggro range, so
encounters with a nearby companion retain their prior behavior. A distant
companion is intentionally not pulled into combat; the generic enemy AI
continues to target the player.
