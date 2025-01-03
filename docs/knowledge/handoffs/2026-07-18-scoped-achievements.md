# Handoff: Scoped Achievement Catalogs and Run-Global Facts

## Date

2026-07-18

## Persona

Systems Engineer.

## Systems touched

quests, inventory

## Apples

3 apples estimated, 3 apples actual (exact). The slice required a versioned
cross-floor fact lifecycle, backward-compatible carryover, real Floor 2 runtime
wiring, property coverage, and the full 3-apple review harness.

## Stack

- Child issue: #1290
- Base branch: `nalfeo-floor-2-equipment-contracts`
- Verified base and dependency head:
  `4c11335a281842f82d206a4c42b23a28e2f40e91`
- Branch: `nalfeo-scoped-achievements`
- Session: `790f9074-56d6-4f24-8cbc-c4d8b88f9437`
- Canonical lifecycle remains dependency-blocked; the issue comment is the
  authoritative speculative STACKED-WORK record.

## Summary

- Added explicit floor-scoped and current-run-global achievement contracts.
- Added deterministic per-floor catalogs, registry-wide authored ordering, and
  floor-aware lookup without changing the 103 existing Floor 1 definitions.
- Added typed fact snapshots with deterministic sum, max, union, OR, derived,
  and live-current-value aggregation semantics.
- Persisted completed-floor facts through the existing player carryover API.
  Legacy snapshots without carried facts migrate to an empty fact snapshot,
  while new runs initialize empty and cannot inherit prior-run progress.
- Evaluated floor-local definitions only against current-floor facts and
  current-run definitions only against carried-plus-current facts after their
  introduction floor is reached.
- Extended Floor 2 collection with player-attributed trash kills and floor-clear
  facts, and invoked `run_end_clear` evaluation from the real Floor 2 stair
  callback.
- Made the in-game achievement UI, lab, and art backlog consume the registry-wide
  ordered catalog view. The Floor 1 JSON editor remains intentionally scoped to
  its single existing source file until a Floor 2 catalog file exists.
- Kept the existing `achievementSystem`; no new exported system or lab was
  introduced.

## Compatibility

- Legacy Floor 1 JSON omits `scope`; parsing normalizes it to `{ type: "floor" }`
  without changing IDs or authored order.
- `PlayerCarryoverSnapshot.carriedRunFacts` is optional for old snapshots.
- Unlock, pending, and claimed state retain their existing persistence behavior.
- `playerGold` uses the current floor snapshot because it is a spendable live
  balance; cumulative facts sum, while monotonic facts retain max semantics.

## Review

- Plan review, `gpt-5.4`: five concerns resolved; minor divergence added explicit
  introduction-floor gating, completed-floor-only carryover, separate scope
  snapshots, floor identity facts, and stronger compatibility coverage.
- Code review round 1, `claude-sonnet-5`: four concerns resolved, including Floor
  2 run-end evaluation, kill aggregation, and registry-wide consumers.
- Code review round 2, `claude-sonnet-5`: two concerns resolved for branded test
  IDs and live wallet semantics.
- Post-fix validator, `gpt-5.4`: clean.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-17-scoped-achievements.review-ledger.json`

## Observation and validation

- Before: the base evaluator explicitly returned for every floor except Floor 1,
  and the Floor 2 stair callback had no `run_end_clear` evaluation seam.
- After: `tests/integration/floor2-victory-pipeline.test.ts` passed through the
  real Floor 2 objective, scene post-system, stair, quest, and safe-room pipeline.
  Focused tests also prove a Floor 2 run-end definition unlocks from the real
  stair callback and that the real Floor 2 post-system wiring executes the
  evaluator.
- Focused achievement/carryover/Floor 2 suite: 42 tests passed.
- Achievements extension adapter: 13 tests passed.
- Root `npm run typecheck` passed.
- `npm run verify:fast` passed after both review-fix rounds.
- `npm run epic:status -- floor-2-equipment` reported a valid schema/DAG, zero
  errors, zero warnings, and the expected dependency blockers.
- Review ledger validation passed.
- A1 was fetched immediately before publication preparation and remained exactly
  at the original verified dependency head; no rebase or contract drift occurred.
- Guard telemetry capture was not required because
  `files/guard-telemetry.jsonl` was absent.

## Follow-up

- Keep this PR targeted at `nalfeo-floor-2-equipment-contracts`.
- Rebase and retarget in dependency order when A1 advances or merges.
- Do not merge or arm auto-merge without explicit authorization.
