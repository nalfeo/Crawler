# Session Handoff: Floor 3 companion progression CI recovery + review-ledger completion

## Date

2026-08-22

## Persona

CI Recovery

## Systems touched

companion-progression, ai-companion

## Apples

3🍎 (declared tier of the PR being recovered; recovery work itself was review/CI cleanup, not new design)

## What Was Done

Recovered PR #3243 (Floor 3 Slice 5: companion combat-XP attribution, leveling,
evolution, ability unlocks) from two rounds of CI/review-thread blockers:

- Fixed `TS6133` (unused `removeEntity`/`clearEntityStores` imports in the
  progression test) that failed the Lightweight Checks required job.
- Fixed `src/core/world.ts`'s `companionDamageContribution` doc comment, which
  incorrectly said the progression system runs "from `dropSystem`"; corrected
  it to say `runCoreSimulationStep` (after `dropSystem`), matching the actual
  wiring.
- Resolved the blocking `check:test-only-exports` CI failure for
  `companionLearnedAbilityIds` and `speciesTokenForId` by adding them to the
  repo's documented `TEST_SCAFFOLD_ALLOWLIST_ENTRIES` (dated entries with
  reasons) since no production Companion spawner or ability-selection UI
  exists yet (both land in later slices, 6-7 and 12-14 respectively) — this
  mirrors the existing precedent for other not-yet-consumed Floor 3 slice-1
  exports in the same file.
- Moved `tests/unit/floor3-companion-progression.test.ts` to
  `tests/ecs/floor3-companion-progression.test.ts` per the Core Layer test
  taxonomy (every `src/core` system's tests live under `tests/ecs`).
- Added `clearEntityStores` regression coverage in
  `tests/ecs/spawners/entity-core.test.ts` for `companionDamageContribution`
  cleanup on both the target side and the contributor side (a gap flagged by
  review).
- Completed the previously-incomplete 3-apple review ledger
  (`docs/knowledge/review-ledgers/2026-08-22-floor3-companion-progression.review-ledger.json`):
  ran a separate-model plan review (`gpt-5.4`), recorded the actual
  `copilot-pull-request-reviewer` findings/resolutions as the `code_review`
  stage, and ran the independent grader (`gemini-3.1-pro-preview`, distinct
  from every other stage's model) via `npm run review:grade`, which returned a
  clean `pass` (5/5 on all criteria, no findings). Verified with
  `npm run review:ledger -- validate` and `npm run verify:pr-prereqs`.

Verification run: targeted `vitest run` on the moved/added test files,
`tsc --noEmit`, `bash scripts/agent/lab-gate-check.sh`,
`scripts/agent/health/test-only-exports.ts` and
`check-allowlist-expiry.ts` (both with `GITHUB_BASE_SHA` set to the real PR
base so the branch-diff scoping matched CI), `npm run review:ledger --
validate`, `npm run verify:pr-prereqs`.

## Key Decisions Made

- Chose the allowlist route (option (c) from the review comment) over adding
  a real production caller for `companionLearnedAbilityIds`/
  `speciesTokenForId`, since no production Companion spawner or
  ability-selection consumer exists yet in this slice — inventing one would
  be out-of-scope scope creep for a CI-recovery pass. Both entries carry an
  `expiresOn` date and a reason naming the future consumer slice.
- The plan-review agent raised two "blocking" concerns (ledger-cleanup
  discipline relying on every removal path calling `clearEntityStores`; two
  sources of truth for team ownership, `Team.id` vs `Companion.ownerTeam`).
  Both were investigated and found to be already handled correctly by the
  existing code (every `removeEntity` call site for a Health-bearing entity
  already calls `clearEntityStores`; `Companion.ownerTeam` is documented as a
  mirror of the `Team.id` source of truth, which is what the progression
  system already reads) — recorded as resolved in the ledger notes rather than
  requiring further code changes.

## What's Next / Blockers

None outstanding for this recovery pass. Slices 6, 7, 10, and 12-14 (KO/
recruiting, overworld spawns, persistent-track wiring, ability-command UX)
remain future work per the epic spec.

## Retrospective

### Lessons Learned

`scripts/agent/health/test-only-exports.ts` and
`check-allowlist-expiry.ts` scope their "changed files" detection off a
merge-base with `origin/main`/`main`; on a shallow clone without those refs
locally, they silently fall back to treating the whole touched file's exports
as newly introduced (surfacing unrelated pre-existing findings). Set
`GITHUB_BASE_SHA=<the real PR base sha>` (from the CI job's own env) to get
identical scoping to CI when re-running these checks locally.

### Mistakes Made

Initially ran the test-only-exports/allowlist-expiry checks without
`GITHUB_BASE_SHA` set and without `origin/main` fetched, which surfaced two
unrelated pre-existing findings (`FloorExtendedState`, `CreateWorldOptions` in
`src/core/world.ts`) as if they were newly introduced by this branch's touch of
that file's doc comment. Fetching `origin/main` and setting `GITHUB_BASE_SHA`
to the CI-reported base sha reproduced the exact CI scoping and confirmed
those findings are pre-existing/out of scope.

### Opportunities for Future Improvement

Consider having `test-only-exports.ts`/`check-allowlist-expiry.ts` print a
warning when they fall back to "no base ref resolved" scoping, since that
silently changes which findings are "in scope" versus CI's `GITHUB_BASE_SHA`-
driven run and can mislead a local re-run into looking broader (or narrower)
than the actual CI gate.
