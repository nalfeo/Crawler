# Session Handoff: Scoped handoff retrieval

## Date

2026-09-11

## Persona

DevOps Engineer

## Systems touched

docs-tooling

## Apples

2🍎 estimated, 3🍎 actual (📉 under — hardened the Windows bootstrap and removed the CLI's unnecessary TypeScript-runner dependency).

## What Was Done

- Added `npm run handoffs:find -- <system-or-topic>`, a deterministic Node-only index-backed lookup that ranks exact system hits before topic matches and emits path, system, date, summary, and compact excerpt.
- Kept the default output budget hard-capped at 2,000 characters; callers cannot raise it with `--budget`. The CLI ranks from index metadata first and reads bodies only for its top ten candidates.
- Added fixture coverage for exact and topic matching, deterministic ranking, header and entry cap behavior, and the explicit no-match `rg` fallback. Preflight now stops with an actionable error if `npm ci` returns without installing `tsx`.

## Key Decisions Made

- Reused the generated index as the discovery source instead of rebuilding or editing it, preserving its deterministic CI ownership and avoiding a 64k-character bulk read by agents.
- Kept retrieval stateless: rollout telemetry is reported at handoff rather than persisted by every read command.

## What's Next / Blockers

- First-request telemetry: the checked-in index is 64,417 characters; a live `ai-pathfinding` request returned 1,931 characters, a 97.0% output-context reduction. The command guarantees at most 2,000 characters.
- Cumulative rollout telemetry at handoff: 1 local request, 1,931 returned characters. The `apples:record` command remains blocked by the desktop runtime's unrelated `tsx` `uv_os_get_passwd` ENOMEM error, so no calibration JSON was created manually.

## Retrospective

### Lessons Learned

The generated index provides enough structured metadata to rank before opening handoff bodies, which lets the CLI scope disk reads as well as its printed output; a small read-only CLI does not need the TypeScript runner at all.

### Mistakes Made

I started the required preflight while dependencies were absent; its install phase overlapped the manual install needed for validation, leaving `node_modules` transiently empty during final smoke commands. The repaired preflight now detects this state, but the broader desktop `tsx` user-profile error still prevents project-wide fast verification.

### Opportunities for Future Improvement

If real rollout telemetry becomes a decision gate, add an opt-in aggregate capture command rather than making every read mutate a local telemetry file.
