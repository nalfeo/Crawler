# Session Handoff: Wounded Retreat Arbitration

## Date

2026-08-13

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

4🍎 estimated, 4🍎 actual

## What Was Done

- Reproduced the authoritative `30cb03d287de26863f5ca183715ff586f643ba5a`
  failures before editing: bow-35 died at frame 9,543 with 54 kills and 1.76%
  minimum HP; throwing-knife-29 died at frame 14,120 with 83 kills and 2.35%
  minimum HP.
- Ran controlled legacy-versus-`localSafetyFirst` decision-mode experiments at
  the baseline SHA. Scan-wide and critical-only recovery arms either remained
  lethal or timed out, while exact retreat-threat ownership recovered
  throwing-knife-29. Bow-35 remained lethal, refuting the proposed single shared
  cause.
- Added a pre-Progress `LocalThreatRecovery` behavior that owns only the enemy
  which triggered Retreat. Productive recovery refreshes its watchdog only when
  that enemy loses HP; 180 damage-free frames blacklist the target and restore
  progression.
- Added class-level arbitration, cleanup, progress-refresh, and abandonment
  tests plus an official 23,760-frame throwing-knife-29 headless regression.
- Confirmed open PR #2823 independently fixes bow-35's wounded ranged spacing
  but not throwing-knife-29. After the required pre-publish rebase, the combined
  final code wins bow-35 at frame 21,373 and throwing-knife-29 at frame 18,399
  without duplicating #2823's tuning.
- Ran the exact-baseline-plus-fix 180-case GitHub sample across six weapons and
  seeds 1-30: 179/180 wins versus the release baseline's 177/180. Bow-21 and
  throwing-knife-29 changed loss to win, no victory regressed, and
  baseball-bat-2 remained the sole loss. See
  `project:sweep-results-viewer runId=31738299642`.
- Repeated that panel after rebasing onto current main. The final branch scored
  179/180 (`project:sweep-results-viewer runId=31744276800`) versus matched main's
  178/180 (`project:sweep-results-viewer runId=31744723997`): bow-20 changed
  death to victory and no main victory regressed. Against the historical release
  baseline the rebased tree remains net +2, with three gains (bow-21,
  baseball-bat-2, throwing-knife-29) and one mainline-drift loss
  (baseball-bat-20).

Observed in the real `src/game/ai/headless-runner.ts` pipeline — before:
throwing-knife-29 died at frame 14,120; after the pre-publish rebase it won twice
at frame 17,403, and paired
event logs were byte-identical
(`0DD9890E510EF2F32B03548E5613FE4D90D6DB23180960B958DFCBC92730B35A`).

## Key Decisions Made

- Split the original shared-cause hypothesis: bow-35 is a wounded-spacing defect
  owned by #2823; throwing-knife-29 is an arbitration defect owned here.
- Recover only the exact retreat-triggering enemy. Scan-wide safety latches
  over-clear local rooms and consume the progression budget.
- Measure recovery progress by target HP loss, not distance. Retreat/engage
  movement naturally oscillates across hysteresis boundaries, while damage is
  the deterministic signal that the threat is actually being resolved.
- Reuse `NPC_APPROACH_THREAT_NO_PROGRESS_FRAMES` rather than add another tuning
  scalar. The fix remains structural and does not alter balance constants.

## What's Next / Blockers

PR #2823 must land alongside this change for the requested bow-35 victory.
This branch is independently net-positive and fixes throwing-knife-29; it does
not duplicate or conflict with #2823's weapon-aware wounded spacing.

## Retrospective

### Lessons Learned

The same visible retreat/progression alternation can have different underlying
causes. Exact threat ownership and an HP-progress watchdog preserved progression
better than any scan-wide or scalar threshold adjustment.

### Mistakes Made

The first recovery designs treated the two deaths as shared and suppressed
progression for the whole local swarm. Their timeout-heavy results were the early
signal that ownership was too broad. The first exact-threat version also lacked
an escape hatch; review correctly exposed the possible retreat/engage yo-yo
before publication.

### Opportunities for Future Improvement

The decision-mode A/B tooling should support recording named experimental arms
and their exact patch identity in one durable aggregate, reducing manual
reconstruction when several controlled variants are tested before the proof-only
mode is removed.
