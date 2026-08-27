# Character Select UX refresh

**Date:** 2026-08-27  
**Author:** Copilot App (UX Designer)  
**Session Branch:** nalfeo-character-select-refresh-1c8

## Summary

Refreshed the shipped `IntroScene` Character Select screen with a shared beveled
pixel panel, clearer title and Director hierarchy, improved form labels,
roomier native controls, and a more explicit primary action. Native HTML inputs,
keyboard submission, render scaling, cleanup, and the intro identity handoff
remain unchanged.

## Systems touched

engine, ux-baselines, visual-review

## A|B scenarios and evidence

Registered `character-select` in `docs/knowledge/ux-baselines/manifest.json` and
added the first-class capture setup at
`scripts/agent/review/setup/character-select.js`. The setup hides workspace
chrome, waits for the real game's native controls, declares panel/content/control
regions, and uses the Equipment baseline's dark pixel palette, beveled framing,
and primary-action hierarchy as its cross-surface reference.

The before/after lineage is stored under:

`files/visual-review/before/live-dev/character-select.png`

`files/visual-review/after/v1.0.4/character-select.{png,review.json}`

The final pixel-grounded visual review passed with 0 deterministic blockers, 0
evidence-backed blockers, 0 advisory taste notes, and an 80.0/100 anchored score.
Earlier iterations were judged and refined through v1.0.0-v1.0.3.

## Validation

- `npm run typecheck` — passed.
- `npm run lint -- --quiet` — passed.
- `npm run test:unit -- tests/unit/intro-scene-wiring.test.ts` — 18 passed.
- Real game capture completed before and after the refresh.
- `npm run review:visual:llm` with the Character Select setup — passed at 80.0/100.
- `npm run verify:fast` — blocked by six existing silent-merge-revert findings
  (three blocking) in unrelated files.
- `npm run review:visual` — blocked because its shared 5299 lab server was
  unavailable; failures were connection-refused in inventory/HUD scenarios.
- `npm run test:e2e -- tests/e2e/intro-scene-flow.test.ts` — one initial pass,
  then retries timed out while the real floor debug handoff was unavailable
  from the local Vite environment.
- `npm run docs:check` — blocked by the pre-existing stale
  `docs/guides/github-token-scopes.md` reference in `README.md`.

## Clean-main blocker comparison

To separate change regressions from shared infrastructure, the blocked commands
were rerun from a detached clean `origin/main` worktree at commit `46a00c9ce`.
`npm run verify:fast` passed cleanly there, confirming the feature-branch
silent-merge-revert findings are branch-state issues unrelated to Character
Select. `npm run docs:check` reproduced the same stale README path failure.
The intro E2E reproduced both timeouts waiting for `__introDebug` /
`__floor1Debug`, confirming a pre-existing runtime handoff or local-server
problem. `npm run review:visual` also reproduced the shared 5299 lab instability:
the inventory suite had navigation timeouts and the existing
`getInventoryMaxScrollRow` probe mismatch on clean main. These failures are
safe to track separately from this Character Select change.
