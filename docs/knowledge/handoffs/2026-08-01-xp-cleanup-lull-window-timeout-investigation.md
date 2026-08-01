# Handoff: XP-cleanup cooldown re-arm regression (issue #2585) — root cause proven, fix landed, seed 9 NOT fully resolved

**Date:** 2026-08-01
**Persona:** Game AI Engineer
**Apples:** 2 estimated, 2 actual
**PR:** none published (investigation task; explicit user instruction not to publish)
**Status:** Fix implemented and evidence-backed for seed 11. Seed 9 is **not** proven
guard-compliant — see "What is NOT resolved" below before merging/publishing.

## Systems touched

ai, bt-ai-provider, headless-runner (read-only, no changes)

## Problem

Branch `nalfeo-improve-ai-xp-collection` HEAD `45cd3d11b` ("hybrid cleanup": local
post-combat XP cleanup + exit marginal-detour cleanup) raises median Floor 2 XP
efficiency from 62.58% → 81.87% (paired seeds 1–20, control run `30697064173` vs.
implementation run `30696983019`), but regresses two control victories to
implementation timeouts — a direct violation of the user's explicit no-new-timeout
guard:

| Seed | Control (30697064173)                                                | Implementation (30696983019)                                             |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 9    | victory, 947,533 ms, eff 0.6765, L19, spawned 1326 / collected 897   | **timeout**, 1,200,017 ms, eff 0.7989, L20, spawned 1228 / collected 981 |
| 11   | victory, 1,008,783 ms, eff 0.6258, L18, spawned 1288 / collected 806 | **timeout**, 1,200,017 ms, eff 0.7085, L18, spawned 1084 / collected 768 |

(Seeds 1 and 5 improve timeout→victory under the implementation; aggregate
victories remain 9/20 either way.)

## Root cause (definitively proven, not speculative)

`findPriorityXpCleanupTarget()` in `bt-ai-provider.ts` runs a bounded "local
post-combat XP cleanup" sweep after combat: it opens a session, caps it at
`XP_CLEANUP_MAX_FRAMES` (240) or lets it complete early once no reachable
candidates remain, and then arms a `XP_CLEANUP_COOLDOWN_FRAMES` (180)
cooldown so it doesn't immediately re-fire.

Commit `45cd3d11b` (this branch's HEAD) added an unconditional block: on every
single `AIState.ENGAGE` tick, if a `'local'` cooldown is pending, clear it
immediately. This was a deliberate, reviewed change (see the existing test
"allows a new fight to open a fresh local cleanup session" and the review
ledger's "Round 2 fixed mode-coupled cooldowns and per-fight local cooldown
reset") intended to let a genuinely new, distinct fight get its own cleanup
chance rather than being blocked by a stale cooldown from an unrelated earlier
fight.

The defect: it clears the cooldown on **every** engagement, not just ones that
follow a genuine lull. On combat-dense floors (fights recurring far more often
than every 180 frames), this lets the local-cleanup mechanism re-open dozens of
times per run instead of the intended "once per genuine post-combat lull",
compounding into enough extra simulated time on marginal-budget seeds to blow
the 1,200,000 ms wall-clock budget.

### Causal proof (not inference)

A temporary diagnostic (monkey-patched `findPriorityXpCleanupTarget`, since
deleted) that could forcibly veto every local-cleanup candidate while leaving
all cooldown/session bookkeeping untouched flipped both regressed seeds from
`timeout` to `victory`:

| Seed | Variant                 | Outcome | gameTimeMs   | Notes                                                             |
| ---- | ----------------------- | ------- | ------------ | ----------------------------------------------------------------- |
| 9    | impl (HEAD, unmodified) | timeout | 1,200,016.67 | `localSessionOpens: 672`                                          |
| 9    | veto-local (diagnostic) | victory | 892,233.3    | proves local-cleanup _acting_ on candidates causes the regression |
| 11   | impl (HEAD, unmodified) | timeout | 1,200,016.67 |                                                                   |
| 11   | veto-local (diagnostic) | victory | 977,783.3    |                                                                   |

`git show 45cd3d11b` confirmed the unconditional-clear block is this branch's
own HEAD commit, introduced alongside (not before) the efficiency gain — i.e.
the same commit that improves median efficiency is the one that introduces the
timeout regression.

## Fix

`src/game/ai/bt-ai-provider.ts`, `findPriorityXpCleanupTarget()`: gate the
ENGAGE-triggered cooldown-clear on whether the _previous_ combat lull window
had already genuinely expired, checked **before** refreshing the window for
this tick:

```ts
const priorLullExpired = world.frameCount > this.xpCleanupCombatWindowUntilFrame;
this.xpCleanupCombatWindowUntilFrame = world.frameCount + XP_CLEANUP_COMBAT_LULL_WINDOW_FRAMES;
if (priorLullExpired && this.xpCleanupCooldownMode === 'local') {
  this.xpCleanupCooldownMode = null;
  this.xpCleanupCooldownUntilFrame = 0;
}
```

This is zero-new-constant: it reuses the existing
`XP_CLEANUP_COMBAT_LULL_WINDOW_FRAMES` (180) and `xpCleanupCombatWindowUntilFrame`
state that already existed for a different purpose (gating whether local
cleanup can _start_ at all). No tuning constants were added or changed —
`bt-ai-tuning.ts` is untouched.

Why this preserves the reviewed "new fight deserves a fresh chance" intent: a
session that completes via the 240-frame cap will _always_ already be past the
180-frame lull window by construction (240 > 180), so the gate is a no-op on
that completion path — exactly matching the existing reviewed test's timeline
(session opens frame ~1, force-completes frame ~241, next engage at frame
~242 > 180 → still forgiven). It only changes behavior for sessions that
complete **early** (ran out of nearby candidates), which can set a cooldown
well before the 180-frame window elapses — those are the case a close,
back-to-back re-engagement must not immediately re-open.

### New regression test

`tests/game/behavior-tree-ai.test.ts` — `does not re-arm a still-fresh local
cooldown for back-to-back engagements inside the same lull window`, inserted
directly after the existing "allows a new fight..." test in the `bounded
priority XP cleanup` describe block. Models: fight 1 opens a local session that
completes early (candidate collected, no more nearby) and arms a cooldown well
before the 180-frame window elapses; fight 2 breaks out almost immediately
(still inside the original lull window); asserts the priority-XP-cleanup
behavior specifically does not re-fire (`decision.reason` does not contain
`'local post-combat XP'`).

Verified as a genuine regression test, not just an assertion that happens to
pass: temporarily reverted the fix to the original unconditional clear and
confirmed the new test fails at exactly the intended assertion
(`expected 'Collecting local post-combat XP at di…' not to contain 'local
post-combat XP'`), then restored the fix and confirmed it passes again.

All 119 tests in `tests/game/behavior-tree-ai.test.ts` pass (118 pre-existing +
1 new), including the existing reviewed test the fix was designed not to break.

## Evidence: before/after per seed

All runs below are fresh Node processes (`--fresh-process`), floor2, weapon
forced to `sword`, combo `riskRewardFused+legacy` — the exact same config the
CI control/implementation artifacts used. The last two rows for each seed were
produced via `npm run ai:sweep-eval -- --stage xp-measure --combo
riskRewardFused+legacy --floor floor2 --weapons sword --fresh-process
--record-xp` (the same tool the CI workflow uses), with the fix applied, as
the real-pipeline confirmation:

| Seed | Variant                            | Outcome     | gameTimeMs   | finalLevel | xpEfficiency |
| ---- | ---------------------------------- | ----------- | ------------ | ---------- | ------------ |
| 9    | control (CI)                       | victory     | 947,533      | 19         | 0.6765       |
| 9    | implementation (CI, unfixed)       | **timeout** | 1,200,016.67 | 20         | 0.7989       |
| 9    | **fixed (local, `ai:sweep-eval`)** | **stalled** | 1,186,366.67 | 19         | 0.8147       |
| 11   | control (CI)                       | victory     | 1,008,783    | 18         | 0.6258       |
| 11   | implementation (CI, unfixed)       | **timeout** | 1,200,016.67 | 18         | 0.7085       |
| 11   | **fixed (local, `ai:sweep-eval`)** | **victory** | 1,078,100    | 20         | 0.8092       |

**Seed 11 is fully resolved**: victory, better level (20 vs. control's 18) and
better efficiency (0.809 vs. control's 0.626) than both control and the broken
implementation.

**Seed 9 is NOT fully resolved.** The fix converts the outcome from `timeout`
to `stalled` — a different, pre-existing, unrelated failure mode (a
`QuestProgressStallTracker` watchdog in `headless-runner.ts`, default 360s of
no objective/gold progress, entirely outside the XP-cleanup mechanism). The
`stallReason` for this run: `quest progress frozen for 360s — completed:
[floor2-find-settlement, floor2-den-pandas-unlock, floor2-den-raccoons-unlock,
floor2-den-faeries-unlock], stalled on: [floor2-den-llamas-unlock]`.

Read literally, the "no-new-timeout" guard is satisfied for seed 9 (it no
longer times out). Read as intended — seed 9 should return to a control-
equivalent-or-better outcome — it is **not** satisfied: `stalled` is still a
non-victory regression from control's victory, just a different failure mode
than the one named in the guard. `localSessionOpens` for this run dropped from
672 (unfixed) to 347 (fixed) — a ~48% reduction, not full elimination — so the
fix is a genuine, large, evidence-backed improvement, but it does not fully
suppress the mechanism's interference on this specific seed's trajectory.

Diagnostic note (not part of the confirmed evidence): an earlier local run of
seed 9 through a different, non-config-matched local tool (`ai:xp-sweep`,
which does not force `--weapons sword`) reported `victory` at 77.9% efficiency.
That tool's default weapon assignment differs from the CI config's forced
`sword`, so that result is **not comparable** to the table above and should not
be read as contradicting the `stalled` result — it is flagged here only so a
future investigator doesn't rediscover the same red herring.

## What is NOT resolved — exact next measurement needed

1. **Seed 9's guard status is unproven.** Whether `stalled` on
   `floor2-den-llamas-unlock` is a direct, causal consequence of the
   _residual_ 347 local-cleanup opens (i.e. still-too-frequent re-arming on
   this specific seed's fight cadence) or an unrelated, coincidental
   downstream trajectory shift (the sim is deterministic — any behavior change
   reshuffles all later RNG-driven state) has not been established. The
   veto-local diagnostic (full suppression → victory, no stall) is _consistent
   with_ residual interference being the cause, but is not proof, since full
   veto also changes the trajectory more broadly than the gated fix does.
2. **Recommended next step:** a targeted trace of the `floor2-den-llamas-unlock`
   objective for seed 9 specifically (what gates its progress; whether the
   AI's post-fix path ever satisfies that gate within the stall watchdog's
   360-frame-progress window) to determine whether this is a den/quest
   fragility that exists independent of this fix, or a second, narrower
   instance of the same "cleanup interferes with time-sensitive objectives"
   class of bug.
3. **Recommended broad measurement:** a full seeds 1–20 paired sweep with the
   fix applied, dispatched on GitHub infrastructure (required by AGENTS.md r15
   for any run count >10 — the local budget for this investigation is already
   exhausted at the ≤10-run ceiling), to get the complete guard-compliance
   picture (median efficiency delta, aggregate victory count, and whether any
   _other_ seed newly regresses under the gated fix that wasn't affected by
   the original unconditional-clear defect).

## Local fresh-process run budget (used: 10/10 — at ceiling, no further local runs without new authorization)

1–3: unmodified/veto-local causal reproduction, seeds 9 and 11.
4–6: real-fix reproduction, seeds 9 (x2, with/without `stallReason` capture)
and 11.
7–8: `ai:xp-sweep` seeds 9 and 11 (later found to be config-mismatched —
does not force `--weapons sword` — treated as non-authoritative; run 8 was
stopped mid-flight once the mismatch was identified).
9–10: `ai:sweep-eval --stage xp-measure` (CI-equivalent tool, `--weapons
sword` forced) seeds 11 and 9 — the authoritative, real-pipeline, config-
matched confirmations cited in the evidence table above.

## Verification run

- `npx vitest run tests/game/behavior-tree-ai.test.ts`: 119/119 passed.
- `npm run verify:fast`: passed (type check, lint, changed tests: 226 tests
  across 12 files, physics-defs/size/weight coverage checks all OK).
- `npm run check:wired-systems`: passed (49/49 systems wired).
- Real-pipeline observation: `npm run ai:sweep-eval -- --stage xp-measure
--combo riskRewardFused+legacy --floor floor2 --weapons sword
--fresh-process --record-xp` for seeds 9 and 11 — the same tool and config
  the CI control/implementation artifacts used, run against the fix in a fresh
  Node process. Not lab-only.

## Guard compliance summary (explicit, per the user's constraints)

- **≥75% median improvement guard**: unaffected by this fix (fix does not
  touch the efficiency-improving mechanism's normal operation, only its
  re-arm cadence on combat-dense floors). Not independently re-measured across
  all 20 seeds in this investigation — recommended as part of the broad sweep
  above.
- **Floor 1 ≥90% guard**: not touched by this fix (the gate only affects
  `xpCleanupCooldownMode === 'local'` state, which is Floor-2-relevant combat-
  density behavior; Floor 1's panic-beeline gate short-circuits before this
  code path per existing logic). Not independently re-measured in this
  investigation.
- **No-new-timeout guard**: satisfied literally for both regressed seeds (no
  more timeouts), but seed 9 substitutes a different non-victory outcome
  (`stalled`), so the deeper intent of the guard (control-equivalent-or-better
  outcomes) is **not yet proven** for seed 9. This should be treated as an
  open item, not a closed one, until the trace in step 2 above is done.

## Caveats

- No cap/threshold tuning was performed anywhere in this investigation —
  `bt-ai-tuning.ts` is untouched, per explicit user instruction.
- The fix is surgical and evidence-proven for the specific defect identified
  (unconditional cooldown-clear on every engagement); it is not a general fix
  for `floor2-den-llamas-unlock` quest-stall fragility, which is out of this
  investigation's scope and belongs to whoever owns Floor 2 quest-progression
  logic if the trace in step 2 finds it to be independent of this mechanism.
- `docs/knowledge/review-ledgers/2026-08-01-ai-xp-collection-efficiency.review-ledger.json`
  has a pre-existing uncommitted working-tree diff, not authored as part of
  this investigation. Left untouched.
- `npm run sync:main` was invoked once during this investigation and safely
  self-deferred (`deferred-dirty`) due to the uncommitted working tree; not
  re-attempted since the source changes here remain intentionally uncommitted
  pending the next-measurement decision above.
