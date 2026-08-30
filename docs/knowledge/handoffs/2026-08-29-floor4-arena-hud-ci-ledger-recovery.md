# 2026-08-29 — Floor 4 arena HUD CI/ledger recovery

## Systems touched

floor4, hud, review-harness

## What happened

Recovered PR #3891 ("Add Floor 4 arena HUD feedback surfaces") from a dispatched
CI-recovery task with two blockers: the `Lightweight Checks` CI job failing (root
cause: `npm run review:ledger:branch` schema-rejecting the newly-added, still-stub
review ledger — all 2957+ unit/guard tests passed) and the review ledger itself being
invalid/incomplete for this declared 4-apple change.

Per the CI-recovery protocol ("complete non-ledger code and review-thread repair
first, then repair the ledger"), addressed every unresolved finding from the native
GitHub Copilot PR review before touching the ledger:

1. **Break summary reported cumulative, not per-act, metrics.** `buildFloor4HudState`'s
   `buildSummary()` diffed `playerGold`/`enemiesSpawned`/`enemiesCut` against nothing,
   so every non-final break re-reported the whole run's totals instead of the act just
   survived. Fixed by adding `actBaseline` to `Floor4ArenaState`, snapshotted at each
   act's `WAVES`-phase entry in `floor4Scenario.ts`, and diffed in `buildSummary()`.
2. **New encounter-stack HUD offset had no e2e coverage.** Added
   `pushTestAnnouncement()`/`getEncounterProbeBounds()` to the HUD lab probe API and a
   deterministic e2e case asserting the announcement banner renders below the Floor 4
   panel.
3. **Cut notice could render alongside "VICTORY LAP".** `cutNotice` was keyed only off
   `phase.kind === 'HEADLINE' && phaseElapsedMs <= 3000`, so a Headliner killed within
   that window still showed "CLEAR THE FLOOR" over the "ACT N VICTORY LAP" title. Fixed
   by adding `!state.phase.cleared` to the guard.
4. **Break-summary gold shrank in real time while shopping.** `buildSummary()`'s gold
   delta diffed against the _live_, continuously-mutating `input.playerGold`, so it
   would visibly decrease as the player spent gold at sponsors during the same break it
   was reporting. Fixed by adding `breakGoldSnapshot` to `Floor4ArenaState`, locked the
   instant `INTERMISSION` opens, and reading that instead of the live balance.

All four fixes carry regression tests, each verified to actually fail without the fix
(temporarily reverted, confirmed red, restored). `tests/unit/floor4-arena-director.test.ts`
gained a genuinely sim-driven integration test that drives the real
`arenaDirectorSystem`/`floor4Scenario` through two full acts (not a hand-authored
fixture) and proves both `actBaseline` and `breakGoldSnapshot` are captured from real,
sim-produced state — including spending gold mid-break to prove the snapshot is
genuinely locked against the live balance on the shipped sim path.

Then ran the review harness for this 4-apple change: two independent code-review
passes (`gpt-5.4`, `gemini-3.1-pro-preview`) over two rounds (round 1 surfaced the 3
findings above, split independently between the two models with no overlap; round 2
confirmed clean), an adjudication pass (`claude-opus-4.8`) confirming zero actionable
concerns, and an independent grade (`gpt-5.5`, distinct from every reviewer/adjudicator
model) recording verdict `pass`. Populated and validated
`docs/knowledge/review-ledgers/2026-08-29-floor4-arena-hud.review-ledger.json`
(`npm run review:ledger -- validate` passes with zero errors).

Also discovered via `npm run verify:pr-prereqs` that this PR (from its very first
commit) was missing the ADR its cross-layer diff (`src/game/` + `src/engine/`)
requires, and never had a handoff — this session adds both retroactively
(`docs/knowledge/adr/2026-08-29-floor4-arena-hud-projection.md` and this file).

## Key decisions

- **HUD state stays a pure `src/shared/` projection, not sim-owned.** See the new ADR
  for the full rationale; the short version is that keeping all formatting/derivation
  logic in `buildFloor4HudState()` lets the HUD lab and the real scene share identical
  logic without duplicating it, and keeps `Floor4ArenaState` limited to the minimal
  snapshots (`actBaseline`, `breakGoldSnapshot`) needed to make per-act deltas correct.
- **Populated the review ledger with real evidence, not stubs.** Followed the sibling
  `2026-08-28-floor4-green-room` ledger's precedent shape: one `code_review`/
  `multi_model_review` pass reused across both stages, with an `adjudicator_model`
  distinct from the two round-1 reviewers, and an `independent_grade` grader model
  distinct from every other stage's models.

## Verification

- `npx tsc --noEmit -p .` — clean.
- `npx eslint <touched files>` — clean.
- `npx prettier --check <touched files>` — clean.
- `npx vitest run tests/unit/floor4-hud.test.ts tests/unit/floor4-arena-director.test.ts
tests/unit/floor4-arena-waves.test.ts` — 34/34 pass.
- `npx vitest run tests/e2e/floor4-arena-hud.deterministic.test.ts --project=e2e` (after
  `npx playwright install chromium --with-deps`, not previously installed in this
  worktree) — 3/3 pass.
- Every new/changed regression test was confirmed to fail without its fix by
  temporarily reverting the fix, observing red, then restoring it.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-08-29-floor4-arena-hud.review-ledger.json`
  — valid.
- `npm run verify:pr-prereqs` — ADR + handoff gaps closed by this session; review-ledger
  check passes.

## Gotchas for the next session

- **Floor 4's `arenaDirectorSystem` phase transitions are wall-clock-boundary based and
  cascade.** A single large `advance(ms)` call can jump through multiple phase
  transitions (`WAVES` → `HEADLINE` → `INTERMISSION` → next act's `WAVES`) if the delta
  covers multiple phase durations, and this can retroactively update `actBaseline`
  mid-call if the cascade crosses into a new `WAVES` phase before your test reads the
  arena state. See `tests/unit/floor4-arena-director.test.ts`'s new test for the
  exact `advance()` sequence that lands precisely on an `INTERMISSION(N)` boundary
  without overshooting into `WAVES(N+1)`.
- **Wave releases within a `WAVES` phase require per-`cadence.intervalMs` ticks** — a
  single jump across the whole `waveWindowMs` skips all releases/cuts (telemetry stays
  at 0), matching the pattern in `tests/unit/floor4-arena-waves.test.ts`.
- **The HUD lab's announcement drain uses a strict `>` comparison** against the last
  drained `elapsedMs`; a pushed test event stamped with the _current_ `world.elapsedMs`
  (not `+1`) can be silently skipped if the natural per-frame loop already drained that
  exact value.
