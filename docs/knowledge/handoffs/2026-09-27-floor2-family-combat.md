# Floor 2 family combat authority

Date: 2026-09-27
Issue: #4693
Verdict: recommended — make existing family/feud decisions authoritative in shared combat.
Estimate: 3 apples. Actual: 3 apples.

## Systems touched

combat, enemies, ai-pathfinding, floor2, main-scene-probe-lab

## Scope and authorization continuity

The user authorized implementation of issue #4693, focused validation, and a local
commit. Do not push, publish a PR, modify the issue, or merge: the deterministic
runner owns those stages. These grants and limits transfer unchanged to the next
stage. No gameplay commands or manual control were added to the shipped game.

## Implementation plan and routing

1. Producer: read the supplied issue and hard gate; trace both real pipelines.
2. Systems Engineer: authorize core damage using existing family relation bands;
   resolve rival contacts in the existing collision/damage system; snapshot delayed
   attack family/owner identity; retain existing hit/death/relation consumers.
3. Game AI Engineer: extend durable defense signals to family victims and reuse
   the existing automatic feud prepass for friendly retaliation.
4. QA: deterministic eligibility/lifecycle regressions, full headless matrix,
   real MainGameScene Floor 2 probe with normalized parity and defensive hits.
5. Independent reviewers: inspect the complete diff, fix findings, validate the
   required fast and prerequisite gates, then commit locally for the runner.

Hard gate: all relation-combat cases agree across headless and real MainGameScene,
zero forbidden hits, exactly-once hit/death/relation processing, verify:fast and
verify:pr-prereqs pass. Tiebreakers: determinism, existing machinery, bounded scope.

## Changes

Core family eligibility runs before damage, RNG, corpse, cooldown, and projectile
side effects. Family rivals override the generic shared enemy team. Family contact
hits use the existing 250 ms contact interval and reject dead combatants. Delayed
attacks retain family identity, while generation checks prevent recycled owners
from receiving attribution. Friendly mobs defend the player or their own family
using durable signals that survive the renderer's combat-event drain.

ADR 0113 records the decision. No new ECS system or library was introduced; the
existing registered MainGameScene probe lab exercises the shipped pipeline.

## Validation and runtime observation

Initial deterministic regression run reproduced 10 failures among 16 tests,
including neutral/friendly contact damage, same-family projectile hits, absent
rival contact, and absent family defense. The early canonical pipeline matrix also
reproduced missing rival contact and family defense. Final validation passed:

- `npm run preflight`.
- Focused combat regressions: 22 family cases, including AoE snapshot persistence,
  impact-time relation changes, forbidden collision cooldown, lethal contact,
  exactly-once death, durable family defense, and recycled player attackers.
- `npm run scope`: simulation, coverage, integration, and real visual checks selected.
- `npm run verify:fast`: typecheck, changed-file lint, 312 test files / 3,965 tests,
  and data-contract, integrity, and coverage checks passed.
- `npm run verify:pr-prereqs`: passed (final PR-title validation belongs to runner).
- Fresh post-review TypeScript and focused retaliation regressions passed.
- Independent reviewer reran unit/integration coverage: 36/36 passed.
- `FAMILY_COMBAT_EVIDENCE_DIR=files/family-combat-after npx vitest run --project e2e
tests/e2e/main-game-scene-family-combat.test.ts --reporter=dot`: passed in 75.50 s.

All 14 real MainGameScene outcomes match the headless pipeline. Both defense
cases move automatically, select the attacker, and land damage. Normal victim
hits occur exactly once; forbidden hits remain zero; relation values remain
unchanged. The lethal unit regression separately verifies one death and no
repeated corpse contact or queued relation effects.

Runtime artifacts: `files/family-combat-after/observations.json` and one screenshot
per matrix case. Personally inspected `rival-contact.png`: real Floor 2 cave/HUD,
family relation panel, and a visible -7 combat hit. The probe isolates combatants
and unequips auto abilities while retaining the real cave, AI, movement,
collision, damage, and scene frame loop. It asserts exact frame advancement to
prevent modal pauses from yielding vacuous no-damage results.

## Review

Independent design review recommended the approach with required snapshot,
pre-side-effect filtering, live-target, and generic-team compatibility safeguards.
The installed review-agent skill was not present in the available skill roots;
read-only independent agent review follows the repository review-harness procedure.
Independent risk review passed after fixing stale player-attacker generation
and removing out-of-scope beam metadata. The reviewer stated the implementation
is okay to check in after validation. Fresh complete-diff review also passed: no blocking or medium findings;
the reviewer explicitly stated the change is okay to check in.

## Residual risk

Rival contact changes Floor 2 encounter outcomes as requested. This session checks
combat semantics and pipeline parity; it does not claim a new broad balance sweep.

## Environment notes

Preflight passed. The token-budget command could not read runner telemetry because
`/root/.codex/sessions` does not exist; it did not report an exceeded threshold.
No `files/guard-telemetry.jsonl` was present to capture. Browser verification uses
Playwright Chromium with its Linux runtime dependencies installed in this runner.

## Local-gate repass (2026-09-27)

Verdict: recommended. Estimate: 1 apple. Persona: DevOps Engineer.
The attached complete-diff review passed; the only local-gate finding was
missing `tsx` in a separate fresh worktree. This repass ran `npm run preflight`,
which installed 470 packages and passed, without changing gameplay or gates.
Plan: inspect the existing implementation and review evidence, bootstrap the
worktree, rerun focused combat and required gates, and commit this handoff locally.

Inspected implementation commit `5c33067ca46975aaee544d4eb1660814195a310d`,
including shared damage permissions, contact dispatch, durable defense signals,
and the deterministic and MainGameScene tests. Repass results:

- Focused unit/integration combat tests: 36/36 passed.
- `npm run scope`: simulation, coverage, integration, and visual checks selected.
- `npm run verify:fast`: passed; its changed-test phase selected no tests in the
  already-committed tree, so the explicit focused run supplies regression coverage.
- `npm run verify:pr-prereqs`: passed, except final PR-title validation owned by
  the publication stage.
- Real MainGameScene parity test: passed in 65.58 seconds across all 14 cases.
  Fresh observations and screenshots: `files/family-combat-repass/`. Personally
  inspected `rival-contact.png`: real Floor 2 HUD, family panel, and a -7 hit.

The failed gate previously stopped before verification; after bootstrap both
required commands complete successfully. Dependencies are local to each worktree:
the deterministic local-ci stage must run `npm run preflight` in any new worktree
before invoking `verify:fast`. This repass does not alter the external runner.
No guard telemetry file was present. The existing review pass still covers all
gameplay code; this repass adds handoff evidence only. Authorization remains
local commit only; no push, PR, issue mutation, or merge is authorized here.
Residual risk remains encounter balance, as above; no new runtime code changed.
An additional handoff-lint check reported three pre-existing missing retrospective
subsections in `2026-09-26-merge-train-synchronize-reevaluation.md`; it reported
no finding in this handoff. The unrelated document was left unchanged.

## Second local-gate repass (2026-09-27)

Verdict: recommended. Estimate: 1 apple. Persona: DevOps Engineer.
The second attached failure repeats the same missing-tsx error in the local-CI
worktree. Installing dependencies in an implementer or reviewer worktree cannot
repair that separate stage. The workflow definition is owned by this repository:
its local-ci task invoked verification directly, while push-branch and the
remediation workflow already install their own dependencies.

Plan: trace the failing stage, bootstrap its own worktree using the existing
remediation pattern, add executable ordering/failure regressions, rerun combat
and required gates, obtain complete-diff review, and commit locally.

The feature workflow now runs `npm ci --ignore-scripts` before `verify:fast`,
with `set -eu` preserving installation and verification failures. Base sync and
gate routing are unchanged. No gameplay or verification requirement is weakened.
The execution regression stubs npm to check fresh-stage installation ordering,
installation failure stopping verification, and verification failure propagation.

Systems touched in this repass: Goobers feature local-CI workflow and regression
coverage. The existing gameplay implementation remains unchanged.

Validation: preflight passed; 36 focused combat tests and 58 workflow tests passed;
the real MainGameScene probe passed all 14 visual/headless cases in 73.38 seconds.
Evidence is in `files/family-combat-repass-2/`; personally inspected the
rival-contact screenshot showing Floor 2, the family panel, and a -7 hit.
`npm run scope`, `npm run verify:fast`, and `npm run verify:pr-prereqs` passed
(final PR-title validation remains the publication stage's responsibility).
Repository contract validation passed all 9 workflow schemas and 39 fixtures.
Executing the exact revised local-ci script also passed: it installed 470
packages with lifecycle scripts disabled, then completed `verify:fast` successfully.
Optional `goobers validate --source-tree .goobers` cannot validate this source
with the installed CLI: it rejects the unchanged coder `codex.sandbox` option.
That config has no diff against the base and is outside this repass.

Fresh read-only complete-diff review found no blocking or medium findings and
stated the change is okay to check in after required gates pass. No guard telemetry
file was present. Remaining operational risk: the runner may retain the workflow
snapshot loaded at run creation; recovery must load this revised local-ci task,
or install dependencies in its own gate worktree before retrying. This session
does not claim to have changed a running orchestrator's in-memory workflow.
Authorization transfers unchanged: local edits, checks, and commit only; no push,
PR publication, issue modification, or merge.

## Runtime matrix results (reconfirmed on second repass)

| Case                   | Victim hits | Ally moved and damaged attacker | Visual/headless match |
| ---------------------- | ----------: | ------------------------------- | --------------------- |
| friendly-contact       |           0 | n/a                             | yes                   |
| neutral-contact        |           0 | n/a                             | yes                   |
| hostile-contact        |           1 | n/a                             | yes                   |
| hate-contact           |           1 | n/a                             | yes                   |
| friendly-projectile    |           0 | n/a                             | yes                   |
| neutral-projectile     |           0 | n/a                             | yes                   |
| hostile-projectile     |           1 | n/a                             | yes                   |
| hate-projectile        |           1 | n/a                             | yes                   |
| rival-contact          |           1 | n/a                             | yes                   |
| same-family-contact    |           0 | n/a                             | yes                   |
| rival-projectile       |           1 | n/a                             | yes                   |
| same-family-projectile |           0 | n/a                             | yes                   |
| defend-player          |           1 | yes                             | yes                   |
| defend-family          |           1 | yes                             | yes                   |
