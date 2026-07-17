# Floor 2 Boss Difficulty Duel Checkpoint

## Summary

This is a reconciliation checkpoint for issue #1234 and existing draft PR #1237.
The user stopped this implementation because a separate session,
`Design boss abilities` (`04c75895-d312-4fbe-b58b-0e142d63f236`), is exploring
the same product space. Do not publish either implementation independently
without comparing them and selecting one coherent encounter design.

This branch replaces the documented temporary Floor 2 boss shortcut
(`3%` authored HP and `2` contact damage) with deterministic player-level
tuning:

| Player level at first den entry | Difficulty | Authored HP retained | Contact damage |
| ------------------------------- | ---------- | -------------------: | -------------: |
| 5 or below                      | Hard       |                 100% |             18 |
| 10                              | Medium     |                  60% |             12 |
| 12 or above                     | Easy       |                  30% |              8 |

Intermediate levels interpolate linearly; values clamp outside levels 5-12.
The tier locks when the unlocked den encounter first starts.

## Systems touched

enemies, boss-rooms, ai-combat-balance, ci-policy

## Persona routing

- Producer coordinated the bounded request, issue plan, and handoff.
- Game Designer owned the level anchors and encounter-tuning contract.
- QA owned the exact all-roster and real-pipeline evidence.

## Why tuning happens at encounter activation

All Floor 2 bosses spawn during scenario initialization, when direct Floor 2
starts at level 5, and remain `Invincible` inside sealed dens. Spawn-only scaling
would therefore freeze every later boss at the initialization level.

`spawnFamilyBoss` applies the current level for safe direct callers, then the
production `floor2ObjectiveTick` path reapplies an absolute value from the
immutable authored archetype exactly once, immediately before removing
`Invincible`. The `encounter.started` latch prevents retreat/re-entry from
healing or retuning the boss.

## Files in this checkpoint

- `src/game/floor2Scenario.ts`
  - Adds the pure level resolver.
  - Applies exact authored-HP scaling and contact damage.
  - Re-resolves once at the real den-entry activation point.
- `tests/unit/floor2-boss-spawn.test.ts`
  - Covers anchors, interpolation, clamping, and monotonicity.
  - Covers all 18 authored family bosses at levels 5, 10, and 12.
  - Drives the production den-entry path and proves re-entry does not heal or
    retune.
- `docs/knowledge/review-ledgers/2026-07-17-floor2-boss-difficulty.review-ledger.json`
  - Adversarial plan review is complete.
  - Single-model code review completed clean and is recorded.
  - Multi-model reviewers returned clean, but adjudication was interrupted by
    the user stop; the stage remains incomplete intentionally.

## Required issue plan

The detailed pre-code plan was posted before implementation:

`https://github.com/nalfeo/Crawler/issues/1234#issuecomment-4999276958`

The adversarial plan review considered and rejected:

1. Static authored HP only, because it does not guarantee three distinct
   requested tiers.
2. Effective-DPS/build scaling, because it couples boss balance to weapons and
   equipment instead of the explicit player-level contract.
3. Spawn-time-only scaling, because bosses initialize before later level gains.

The review changed hit counts from a hard gate to supporting evidence. Exact
all-roster HP/damage anchors are the deterministic gate; runtime time-to-kill and
survival are observation evidence because they depend on weapon, family AI, and
the level reached before each den.

## Before/after real-pipeline evidence

The real Floor 2 headless pipeline was run with seed 42 and the sword at starting
levels 5, 10, and 12. All six runs reached victory and completed the exit.

Before this change, every boss died in `0.2-1.4s`:

| Starting level | Per-boss durations     |
| -------------- | ---------------------- |
| 5              | 1.3s, 1.4s, 0.6s, 0.2s |
| 10             | 1.3s, 0.8s, 0.5s, 0.3s |
| 12             | 1.3s, 0.9s, 0.5s, 0.3s |

After this change:

| Starting level | Per-boss durations     | Minimum run HP | Exit     |
| -------------- | ---------------------- | -------------: | -------- |
| 5              | 6.3s, 5.2s, 3.4s, 2.0s |           5.9% | complete |
| 10             | 8.4s, 2.5s, 1.6s, 1.3s |           0.3% | complete |
| 12             | 2.9s, 2.5s, 1.5s, 1.5s |           9.5% | complete |

The starting-level runs level naturally before later dens; exact activation-level
stats are therefore guarded by the production-path unit tests rather than inferred
from whole-floor duration alone.

Scratch logs are in the originating session artifacts:

- `floor2-boss-baseline-l5.log`
- `floor2-boss-baseline-l10.log`
- `floor2-boss-baseline-l12.log`
- `floor2-boss-post-l5.log`
- `floor2-boss-post-l10.log`
- `floor2-boss-post-l12.log`

## Verification completed

- `npx vitest run tests/unit/floor2-boss-spawn.test.ts` - 16 tests passed.
- `npm run verify:fast` - 41 files / 495 tests passed.
- `npm run scope` - `gameplay_safe=false`.
- Real seed-42 Floor 2 runs at starting levels 5, 10, and 12 all completed.

No broad sweep was run; the request called for three deterministic level anchors,
and broad runs over 10 belong on GitHub infrastructure.

## Honesty caveat (reconciliation)

This PR only replaces the temporary `3%`-authored-HP/`2`-contact-damage
shortcut with deterministic first-den-entry anchors (L5 100% HP / 18 damage,
L10 60% HP / 12 damage, L12+ 30% HP / 8 damage; intermediate levels
interpolate linearly and clamp outside 5-12). It does **not** implement, or
stand in for, recurring boss abilities.

The ability-less seed-42 durations recorded above (2.0-6.3s at L5, 1.3-8.4s
at L10, 1.5-2.9s at L12) are base-stat time-to-kill observations only. They
are **not** recurring-cast proof and do **not** satisfy Queen Mab's later
two-resolved-cast gate (`docs/knowledge/game-design/floor2-families-and-resources.md`) —
no ability ever fires in these runs. The downstream ability slice (design
branch `nalfeo-design-floor-2-boss-abilities`, commit `71c27eeb`) owns
ability-active broad GitHub-backed TTK/win-rate evaluation once abilities
exist. Never tune a specific boss or seed to green that future gate.

Preserved for the downstream ability slice: future ability clocks must start
only on the one-time `floor2ObjectiveTick` den-activation / `encounter.started`
transition — the same point where this PR's tuning locks and `Invincible` is
removed — never at initialization spawn. Ability damage, effects, and
cooldowns remain catalog-defined and must **not** inherit this PR's
level-scaled contact `Damage` absent a new spec.

## Review state

- 4-apple adversarial plan review: complete.
- Code-review round (`claude-sonnet-4.6`): clean.
- Multi-model raw reviews (`gpt-5.3-codex`, `gemini-3.1-pro-preview`): both clean.
- Multi-model adjudication: complete. Independent `claude-opus-4.8` adjudication
  confirmed zero actionable findings across both raw reviews.
- Ledger validation / PR prerequisites: ledger is complete and validated
  (`npm run review:ledger -- validate`); `npm run verify:pr-prereqs` run.
- PR title/body update and ready-for-review confirmation: done (see
  Reconciliation resolution below). Push and merge remain gated by normal PR
  automation — no merge was performed by this reconciliation.

## Reconciliation resolution

**Retained**: this checkpoint's deterministic level-based base-stat tuning,
bounded to issue #1234, is the fix landed on PR #1237. Recurring boss
abilities are explicitly **out of scope** here and remain a separate
downstream slice on design branch `nalfeo-design-floor-2-boss-abilities`
(commit `71c27eeb`). That design work was not cherry-picked or implemented in
this reconciliation. See the Honesty caveat section above for the exact
boundary between what this PR proves and what the ability slice still owes.

## Reconciliation prompt

You own reconciliation for Crawler issue #1234 and existing draft PR #1237.
Compare this checkpoint with the work and design in session
`04c75895-d312-4fbe-b58b-0e142d63f236` on branch
`nalfeo-design-floor-2-boss-abilities`. Do not blindly stack both approaches.
Decide whether the product requirement is best met by deterministic level-based
durability/pressure tuning, distinct boss abilities, or a deliberately bounded
combination. Preserve unrelated Floor 2 balance and the existing real den-entry
pipeline.

If retaining this checkpoint, inspect/cherry-pick its commit, rebase it onto the
chosen reconciliation branch, and rerun the exact production-path tests plus
`npm run verify:fast`. Complete the interrupted multi-model adjudication and any
required follow-up review rounds, update or replace the incomplete ledger
honestly, run `npm run verify:pr-prereqs`, and synthesize the full PR #1237
title/body. Push only to the existing PR branch and mark that PR ready; do not
create a replacement PR and do not merge unless automation explicitly authorizes
it. Report the final PR/check state to session
`b877fb41-f1ec-4017-9010-99b939b6fa1b`.

## Apples

4 estimated, 4 actual (exact). The work required runtime-pipeline tracing,
adversarial plan review, deterministic tuning, production-path tests, and three
before/after headless observations; publication/reconciliation remains delegated.
