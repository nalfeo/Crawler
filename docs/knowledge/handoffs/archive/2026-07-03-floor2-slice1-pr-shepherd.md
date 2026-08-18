# Session Handoff: PR #694 shepherd — Floor 2 Slice 1 review feedback

## Date

2026-07-03

## Persona(s) adopted

Producer. Cross-layer review-feedback pass (core system relocation, shared
data, tests, an agent script) plus merge orchestration — no single specialist
owned the whole surface, so Producer was the right umbrella.

## Routing verdict

✅ right persona — the work spanned `src/core`, `src/shared/data`, `tests/`, and
`scripts/agent/`, and the deliverable was "drive one PR to a clean squash-merge",
which is coordination-shaped rather than deep single-system design.

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 3
Verdict: 🎯 Exact — the five review threads were surgical, but the file
relocation tripped the lab-gate naming convention and the branch had been
force-rebased onto a newer `main` (Slice 2 + sprite caching) mid-flight, so the
"easy" fixes carried real integration work (mapping registration + rebase-onto).

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

ci-policy

## Review Harness

No new ledger required — this session addressed review threads on an
already-open PR and did **not** re-trigger `create_pull_request`. The existing
3-apple ledger `docs/knowledge/review-ledgers/2026-07-03-floor2-slice1.review-ledger.json`
still covers the change.

## What Was Done

Addressed all open `copilot-pull-request-reviewer` threads (the sole merge
blocker; CI was already green, `required_conversation_resolution` ON):

1. **Public-helper rename** — `speedMultiplierForHate` → `effectiveSpeedForHate`
   in `src/core/faction-relations.ts`. The function returns an _absolute
   effective speed_ bracketed by `[baseSpeed, playerSpeed]`, not a dimensionless
   multiplier; the old name was misleading for a helper Slice 3 will consume.
   Updated the doc comment and all callers/tests.
2. **System relocation + barrel** — `git mv`'d `familyRelationshipSystem.ts`
   from `src/core/` root into `src/core/systems/`, re-exported it (plus
   `FamilyRelationshipSystemOptions`) via the `src/core/systems/index.ts`
   barrel, and dropped the direct export from `src/core/index.ts`. Matches the
   29-system convention. Wiring unchanged — `check:wired-systems` green
   (referenced in `floor-main-scene-options.ts` and `game/ai/simulation-step.ts`).
   Registered `family-territory-lab` coverage in `scripts/agent/lab-gate-check.sh`
   (`[familyrelationship]="family-territory-lab"`); the system previously escaped
   lab-gate entirely by living in core root, which only scans `src/core/systems`.
3. **Boss data transcription** — `families.json` beetlefolk & snailfolk bosses
   were `title:"The"/name:"Broodfather"` etc., stuffing the article into the rank
   slot. Fixed to `title:"Broodfather"/name:"The Broodfather"` and
   `title:"Godfather"/name:"The Gastropod Godfather"`, matching the content bible
   and the existing myconids precedent (bare rank in `title`, full moniker in
   `name`). No runtime consumer concatenates these today.
4. **Testable passive decay** — added `FamilyRelationshipSystemOptions` with an
   injectable `passiveDecayPerSecond` read **per-call** (no longer captured at
   module load), moved per-world decay timing from a module-level `WeakMap` onto
   a new serializable world field `world.factionRelationDecayLastMs`, and added
   unit coverage exercising decay with a non-zero rate. Behavior preserved
   (intended for a later slice); shipped tuning default stays `0`.
5. **Test taxonomy** — moved the `*System` drain/decay tests to
   `tests/ecs/familyRelationshipSystem.test.ts` (via `createTestWorld()`);
   pure-helper tests stay in `tests/unit/family-relationship*.test.ts`.

## Observe-before-done

Behavior is unchanged by design: the rename is pure, the relocation keeps
identical wiring and call signature (new optional param defaults to the tuning
value `0`), the decay branch is byte-identical when disabled, the new world
field is inert unless a caller injects a non-zero rate, and the boss title/name
fields have no runtime consumer. To keep the faction/AI-feeding `src/core` change
honest I ran the **real** headless Floor-1 win-rate gate, not just the lab:
`VERIFY_FULL=1 npm run verify` → green (Integration/Headless project: 6 files,
32 tests, 554s), plus typecheck, lint, format, dead-code, guards
(`check:wired-systems`, lab-gate), unit tests, `verify:pr-prereqs`, and build.

## Merge

- Committed `refactor(floor2): address Slice 1 review feedback` with the
  `Co-authored-by: Copilot` trailer.
- Branch had been **force-rebased** on the remote onto a newer `main` (Slice 2
  #693 + sprite caching #690); rebased the single review-fix commit
  `--onto origin/floor2-slice1-relationships` (clean, no conflicts) and
  re-ran `verify:fast` green before pushing.
- Replied `✅ Addressed in d0de00f5: …` on all 9 threads and resolved each as PR
  owner via GraphQL `resolveReviewThread` (copilot-reviewer threads are
  `viewerCanResolve:false` for the auto-resolve bot). 0 unresolved remaining.
- Armed `gh pr merge 694 --auto --squash`.

## Next / Watch

- Auto-merge armed; completes once the re-run `ci` aggregate + `commit-lint` go
  green. Verify `state=MERGED` + non-null `mergeCommit.oid`.
- Slice 3 will consume `effectiveSpeedForHate` and can flip on passive decay by
  passing `passiveDecayPerSecond` (and should persist/restore
  `factionRelationDecayLastMs` with the rest of world state).
