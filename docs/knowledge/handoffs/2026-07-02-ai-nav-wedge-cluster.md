# Session Handoff: Fix Floor-1 nav-wedge cluster (safe-room-mouth detour thrash)

## Date

2026-07-02

## Persona(s) adopted

Producer → Game Designer / QA. The task spanned AI behavior-tree logic, tuning
constants, and deterministic headless validation, so a Producer framing routed the
root-cause + fix (Game Designer) and the repro/regression gate + sweep validation
(QA).

## Routing verdict

✅ right persona — single-layer (`src/game/ai`) behavioral fix with heavy
measurement discipline; QA framing kept the zero-flip win-rate mandate central.

## Apples

Estimated: 🍎 x 4
Actual: 🍎 x 4
Verdict: 🎯 Exact — repro + root-cause + dual-plan synthesis + plan review + full
code-review/multi-model loop + rebase-onto-merged-main + two authoritative sweeps
landed squarely in the 4-apple envelope.

Hello kitties: 4/5 = 0.80 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-fix-ai-nav-wedge-cluster.review-ledger.json`
Stages: plan_review ✅ · dual_plan_synthesis ✅ · code_review ✅ · multi_model_review ✅
`npm run review:ledger -- validate <path>` → pass.

- **dual_plan_synthesis**: plans from gpt-5.5 + gemini-3.1-pro; opus-4.8 judge.
- **plan_review**: gpt-5.4 (xhigh), 7 concerns, all adopted.
- **code_review**: round 1 (gpt-5.3-codex, gemini-3.1-pro, claude-sonnet-4.6,
  - security-review gpt-5.4) surfaced 3 gemini concerns; round 2 (all three
    reviewers re-run on the rebased diff) confirmed clean.
- **multi_model_review**: gpt-5.4 adjudicated the 3 gemini concerns — F2 (Block B
  eid-guard) + F3 (suppression hoist) VALID→fixed; F1 (re-commit thrash)
  PARTIAL→doc-comment correction (behavioral blacklist rejected as flip-risk under
  the zero-flip mandate, tracked as optional follow-up).

## What Was Done

Root-caused and fixed a Floor-1 "nav-wedge": the AI runner wedges ~tens of seconds
at the safe-room mouth and times out on a weapon-sensitive seed cluster
(13-sword/bow/bat, plus 5-bow). It is an **objective-selection limit cycle**, not
doorway geometry:

- `world.playerInSafeRoom` toggles frame-to-frame as the body straddles the mouth.
- `findNearestRelevantNpc` filters NPCs outside the safe space while in-safe.
- So `withQuestGiverDetour` flip-flops the travel target between the outside quest
  NPC (in-safe frames) and the far merchant objective (out-of-safe frames) →
  net-zero motion → timeout.

**Fix — detour-commitment hysteresis (floor-agnostic, tuning-only + logic in one
file):**

- `src/game/ai/bt-ai-tuning.ts`: `QUEST_GIVER_DETOUR_COMMIT_HYSTERESIS = 1.5`
  (relaxed cap for the already-committed path) and
  `QUEST_GIVER_DETOUR_ABANDON_FRAMES = 300` (~5s monotonic no-progress abandon
  valve). Base caps unchanged (`MAX_EXTRA_FT = 26`, `MAX_EXTRA_FRACTION = 0.6`).
- `src/game/ai/bt-ai-provider.ts`:
  - Fields `committedDetourNpcEid` / `committedDetourBestDistance` /
    `committedDetourNoProgressFrames`; cleared in `reset()`.
  - `withQuestGiverDetour` restructured into Block A (hard early-exits incl.
    **stall-recovery suppression hoist** that releases + returns target while
    `frame < progressGoalSuppressedUntilFrame`), Block B (fresh same-safe-room
    preemption, **guarded by `eid !== committedDetourNpcEid`** so an existing
    same-room commit falls through to the valve), Block C (honor commit via
    `getCommittedQuestGiverDetour`), Block D (fresh strict-cap selection).
  - `getCommittedQuestGiverDetour` re-derives the committed NPC's live position
    (bypassing the safe-room filter), applies the monotonic-min no-progress valve,
    relaxed cap, and interaction-eligible arrival release. New commitments are set
    ONLY after the strict base cap (Block D) or the stable same-room branch (B);
    the relaxed cap applies only on the committed path.

**Regression gates (user's explicit ask — "add regression tests to prevent the
wiggles from coming back"):**

- `tests/headless/nav-wedge-repro.test.ts`: RED→GREEN deterministic gate, now
  loops the full recovered cluster (13 sword/bow/bat), asserting
  `longestWiggleMs < 20000`, `wigglePct < 15`, `travelEfficiency > 0.85` per case.
- `tests/game/ai-detour-hysteresis.test.ts`: 3 unit tests (commit /
  hold-across-flicker / abandon-valve).

## Runtime / real-artifact observation

Observed in the REAL headless AI pipeline (`src/game/ai/headless-runner.ts` via
`npm run ai:winrate-sweep` and `npx vitest run --project headless`), NOT a lab:

- **Before**: seed 13/bow wedges ~182s at world (~388,364), outcome = loss;
  `nav-wedge-repro` red (sustained wiggle episode >20s, travelEfficiency <0.85).
- **After**: 13-sword/bow/bat recover to victory; repro green.
- **Aggregate** (authoritative post-merge sweeps, 48 combos, 1x, 21_600 frames):
  baseline `origin/main` **38/48 (79.2%)** → fix HEAD **42/48 (87.5%)**, **+4 wins**
  (13-sword, 13-bow, 13-baseball-bat, **5-bow**), **ZERO new win→loss flips** (every
  fix-fail — seeds 2 & 12 — is also a baseline-fail). Confirmed 5-bow LOSES on clean
  main (143s ENGAGE wiggle) and the fix recovers it, so the old 40/48 envelope was
  stale; 38→42 is the honest same-harness pair. Remaining fails are the seeds 2/12
  safe-room-exit thrash class (out of scope for this unbundled fix).
  Sweep artifacts: `files/postmerge-base.json`, `files/postmerge-fix.json`.

## What's Next

- Optional follow-up (recorded, NOT done here): a same-NPC re-commit **blacklist**
  so the abandon valve cannot be immediately defeated by Block D re-selecting the
  same base-cap NPC. Rejected for this PR because it changes steady-state detour
  selection and risks new win→loss flips (zero-flip mandate). Only revisit behind a
  full sweep proving no flips.
- Seeds 2/12-bat remain lost (safe-room exit thrash + merchant round-trip
  dominance) — a separate bug class (safe-room-exit latch) from the prototyped
  work; not attempted here to keep this fix unbundled.

## Blockers

None.

## Branch State

- Branch: `nalfeo-fix-ai-nav-wedge-cluster` (rebased `--onto origin/main`;
  `git log --oneline origin/main..HEAD` = only the nav-wedge commit).
- All tests passing: yes (typecheck, verify:fast, headless repro 9/9, unit 3/3,
  ai-damage-invariance 2/2).
- PR created: yes — https://github.com/nalfeo/Crawler/pull/680 (base `main`,
  auto-merge --squash armed).

## Agent-OS Telemetry

Guard telemetry captured via: none (no `files/guard-telemetry.jsonl` this session).

## Test Results

- `npm run verify:fast` → green.
- `npx vitest run --project headless tests/headless/nav-wedge-repro.test.ts` → 9/9.
- `npx vitest run tests/game/ai-detour-hysteresis.test.ts` → 3/3.
- `npx vitest run tests/game/ai-damage-invariance.test.ts` → 2/2.
- Authoritative sweeps: base 38/48 (79.2%) → fix 42/48 (87.5%), +4, zero flips.
- `VERIFY_FULL=1 npm run verify` → green (run pre-PR).

## Key Decisions Made

- **Ship the detour-hysteresis fix ALONE** (no safe-room-exit latch bundled): a
  prior session's bundle regressed the envelope; unbundling kept +4/zero-flip.
- **No blacklist** on the abandon valve for this PR (flip-risk vs zero-flip
  mandate) — documented honestly in the field/tuning comments instead.
- **Rebase via `--onto origin/main f6b07b92`** (the true fork point; the creator's
  suggested `1b81db58` was NOT an ancestor of HEAD) after PR #674 squash-merged.

## Retrospective

### Lessons Learned

- The wedge presented as a "doorway geometry" problem but was pure
  objective-selection thrash driven by a boolean (`playerInSafeRoom`) flickering on
  a body straddling a boundary. When an agent oscillates in place, suspect a
  frame-to-frame predicate flip in target selection before blaming local nav.
- A green **lab** proves nothing about wiring/behavior here; the repro and the win-
  rate gate both drive the REAL `headless-runner` pipeline — that is what makes the
  "observe before done" claim defensible (rule #10).
- After a squash-merge, verify the fork point with
  `git merge-base --is-ancestor <sha> HEAD` before trusting a hand-me-down SHA.

### Mistakes Made

- Early baseline discrepancy (40 vs 38 wins) traced to comparing against a stale
  envelope file rather than a freshly-measured clean-main tree. Fix: always
  re-measure base + fix on the same post-rebase harness; never cite a stale JSON.

### Opportunities for Future Improvement

- Promote a generic "objective-selection oscillation" headless detector (count
  target-eid flips/sec) so this bug class is caught deterministically without a
  per-seed repro.
- The safe-room-exit latch (seeds 2/12) is the next win-rate lever toward 90%+.
