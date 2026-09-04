# Handoff: Floor 3 Studios quest and HUD

## Date

2026-09-04

## Session slug

floor3-studios-quest-hud

## Issue/PR

Issues #4208 and #4210; #4207 validated as already fixed by merged PR #4183.

## Persona

UX Designer

## Systems touched

quests, hud-ux, mobile-ux

## Apples

4🍎 estimated, 4🍎 actual.

## What was done

- Added the Floor 3 Studio quest pack and accepted the selected Studio's quest
  through the canonical quest log at unlock time.
- Resolved Studio defeat goals to deterministic room anchors in the core
  waypoint resolver and classified them as combat waypoints.
- Added a real-game regression proving the standard quest tracker exposes an
  active Studio objective and a rendered off-screen waypoint arrow.
- Moved the issue-report button to a permanent safe-area-aware bottom-right
  anchor and added no-overlap coverage across supported HUD surfaces and an
  open inventory panel.
- Preserved `HudFloor3League` as the aggregate scoreboard; no bespoke Studio
  objective surface was added.
- Reproduced the current-main AI Runner dialog path through public callbacks:
  the existing deterministic test passes, so #4207 is addressed by #4183 and
  is not included in this PR.

## Validation

- `npx vitest run --project e2e tests/e2e/floor3-studio-quest-waypoints.deterministic.test.ts`
  passed (1 test).
- Targeted unit tests passed (80 tests).
- `npm run review:visual:deterministic` passed (36 tests).
- `npm run typecheck` passed.
- `npm run verify:fast` passed.
- `npm run scope` reported `art_only=false`, `docs_only=false`,
  `gameplay_safe=false`.
- Independent post-diff code review found no significant issues.
- Visual-review geometry capture for the HUD reported zero deterministic
  blockers; Azure LLM scoring was unavailable because `AZURE_OPENAI_ENDPOINT`
  is not configured in this worktree.

## Remaining work

- Run PR prerequisite validation, publish one ready-for-review PR, and
  shepherd it through CI Recovery and the merge train without enabling
  auto-merge.
- Record the PR/merge-train intervention log and report progress and the final
  merged SHA to coordinator session `889bca24-17fc-4ae1-90a3-82005101201d`.
