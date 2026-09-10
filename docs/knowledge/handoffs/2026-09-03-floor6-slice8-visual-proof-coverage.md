# Session Handoff: Floor 6 Slice 8 — readability visual-proof coverage

## Date

2026-09-03

## Persona

Producer → QA Engineer

## Systems touched

quests, hud-ux, ci-policy

## Apples

2🍎 exact — test-only lab wiring and e2e assertions on top of already-merged production code;
no new production behavior.

## What Was Done

- Investigated issue #3980 (Floor 6 Slice 8) and found it already had an open, substantially
  complete PR (#4115, `copilot/floor-6-slice-8-quest-pack`) implementing the declarative quest
  pack, Director copy, and the generic `ScenarioPresentationContract.getHudSnapshot` HUD strip —
  a second parallel session on the same issue. Merged that branch into this one (clean merge, no
  conflicts) instead of re-implementing the same quest/HUD work, to avoid duplicate/competing PRs
  against the same issue.
- Confirmed `buildFloor6PresentationSnapshot`/`getFloor6HudSnapshot` (from the merged PR) already
  project every "Done when" readability dimension in the issue as literal text (not color-only
  meaning): route direction, buildable-vs-occupied sites, tower range/tier, Relay danger, loot,
  upgrade choices, break safety, and Deadline escalation. The existing real-scene e2e test only
  asserted the objective line, though, so the "deterministic real-game captures... prove [...]"
  acceptance criterion wasn't actually exercised for most of those dimensions.
- Added three test-only probe hooks to `main-scene-probe-lab` (`primeFloor6BreakPhase`,
  `primeFloor6OccupiedSite`, alongside the existing `primeFloor6FinaleVfxCue`) so an e2e spec can
  reach BREAK phase, an occupied build site with a live tower, and the Deadline FINALE phase
  without grinding a full run through the sim.
- Added a new e2e test (`main-game-scene-floor6-scenario-hud.test.ts`) that boots the real
  `MainGameScene`, reads the actual rendered HUD strip text, and asserts every listed readability
  dimension is present as words: `VACANT ... buildable maintenance plinth` → `OCCUPIED <site>:
<tower>` plus `<tower> at <site>: <N>ft, <tier>`; `Break safe: N live hostiles`; `Deadline
active: ... on ...`; loot/currency/upgrade lines. Captures a screenshot at each state when
  `FLOOR6_HUD_EVIDENCE_DIR` is set.
- Verified visually (see Runtime observation) that the rendered HUD strip genuinely displays this
  text on the real canvas, not just in test-harness state.

## Key Decisions Made

- Merged the sibling PR's branch rather than re-authoring equivalent quest/HUD/Director work,
  since GitHub only allows one PR per issue to actually close it and duplicating the effort would
  create merge-train contention between two PRs touching the same files.
- Did **not** attempt new sprite/tower/enemy art generation or set-piece dressing in this session:
  this sandbox has no Azure OpenAI/sidecar credentials (`AZURE_OPENAI_ENDPOINT` is empty), so the
  asset-forge pipeline cannot run here. Per the issue's own instruction ("follow the asset and
  set-piece pipelines rather than landing placeholders as final art") and repo rule #11 (never
  weaken an explicit human requirement to get green), I did not fabricate placeholder art to
  simulate completion. This PR does **not** close #3980.

## What's Next / Blockers

- #3980 remains open. Outstanding scope: original enemy/tower/production-set sprite assets and
  set-piece dressing, which require the `asset-forge`/`set-piece-designer` pipelines with working
  Azure sidecar connectivity — unavailable in this sandbox. A future session with Azure access
  should pick this up, then extend the e2e coverage added here to also capture the new art.
- Once art/dressing lands, close #3980 from that PR (not from this one).

## Retrospective

### Lessons Learned

- When an issue already has multiple open PRs referencing it (`closed_by_pull_requests` on the
  GitHub issue), check each one before writing new code — a sibling session may have already
  covered most of the ground, and merging its branch is far cheaper than re-deriving the same
  quest/HUD contract from scratch.
- The existing `primeFloor6FinaleVfxCue` pattern (pause sim, mutate `floorExtendedState` directly)
  generalizes cleanly to other phases/state (BREAK phase, occupied build sites) without needing a
  full economy/wave grind through the real simulation.

### Mistakes Made

- None significant; the merge was clean and the new probes/tests passed on first full run.

### Opportunities for Future Improvement

- Consider a documented, repo-wide policy note for "issue already has an open PR" detection at
  session start (e.g., surfaced by preflight) so a producer session doesn't need to manually query
  `issue_read`/`pull_request_read` to discover sibling in-flight work.
