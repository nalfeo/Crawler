# Session Handoff: Deterministic Reward-Opening Audio Cues (Achievement Boxes + Boss Chests)

## Date

2026-07-24

## Persona

Producer → Sound Designer (orchestrated implementation directly; no child sessions spawned)

## Systems touched

inventory, quests, boss-rooms, hud-ux, ci-policy

## Apples

4🍎 estimated, 4🍎 actual (exact — full JSON summary at
`docs/knowledge/metrics/apples/2026-07-24-reward-opening-audio.json`).

## What Was Done

Added original, procedural, deterministic **audio** to the already-shipped
reward-opening UX (PR #1865, squash `eddddf6bfa091bef696107012f819bbf3ce0d532`)
without touching its phase state machine. Three new modules, layered to match
the existing visual pipeline's own shape:

- `src/shared/reward-audio-cues.ts` — pure decision layer. Maps a phase
  transition + revealed rarity + `RewardExcitement` + `reducedMotion` into a
  `RewardAudioCue` (anticipation / reveal / escalation / summary / skip /
  close), with session-scoped monotonic escalation tracking (loudest rarity
  seen so far never de-escalates mid-session).
- `src/engine/audio/audio-cue-engine.ts` — generic, reusable WebAudio
  oscillator+gain synth engine (`AudioCueEngine`), not reward-specific.
  `isAvailable()` is `false` whenever `AudioContext` doesn't exist
  (Node/headless/autoplay-blocked); every other call becomes a guaranteed
  no-op — this is the one place the safe no-audio fallback lives.
- `src/engine/reward-opening-audio.ts` — glue (`synthSpecForCue`,
  `createRewardOpeningAudioController`). Every hook that can end audio in
  flight (`open`, `skipped`, `closed`) calls `engine.stopAll()` before its own
  cue — the entire cancellation/ownership model.

Wired into `RewardOpeningUI.ts`'s existing hook call sites (no changes to the
sequence state machine or its idempotency guards) and into
`MainGameScene.ts`, which owns one real `AudioCueEngine` per scene lifetime
and disposes it on shutdown. A cue-logging wrapper
(`createRewardAudioCueLoggingEngine`) exposes a `rewardAudioCueLog` field
through the existing `main-scene-probe-lab` structural-cast pattern for
E2E-observable cue ordering/intensity assertions — test/automation-only,
never gameplay-visible.

Full test coverage: 4 unit-test files (~54 tests: cue-decision logic, synth
engine incl. graceful-release/suspended-drop/`delayMs` regression tests,
glue controller incl. reducedMotion-snapshot + escalation-stagger tests, and
a dedicated `RewardOpeningUI` visibility-hook guard test using a minimal
chainable fake `Phaser.Scene`), 5 new E2E tests appended to
`tests/e2e/reward-opening-ux.test.ts` (cue ordering incl. skip path,
one-reveal-cue-per-item, tier-based intensity monotonicity, reduced-motion
scaling that never reaches zero, no cross-session leak + duplicate-input
safety), and a new integration test
`tests/integration/reward-opening-audio-pipeline.test.ts` (4 tests) wiring
the REAL sequence state machine + REAL audio controller + REAL
`computeEquipmentExcitement` calculator with only a leaf recording fake for
the synth engine — this closes a gap the E2E suite cannot cover today (no
shipped content path varies granted-item rarity at a fixed box tier), by
proving the dual tier+rarity excitement axis flows into real cue gain
end-to-end.

### Review-harness fixes (initial round: code review + this section's own mechanism, later superseded)

An initial code-review pass surfaced 5 concerns, resolved before the fresh
final review round documented below:

- **`stopAll()`/`clearAllVoices()` now does a graceful ramped release**
  (`cancelScheduledValues` + a `GRACEFUL_RELEASE_SEC = 0.02`s linear ramp to
  near-silence + a deferred `osc.stop()`) instead of a hard `osc.stop(0)`.
  This was originally the mechanism relied on for skip-cancels-summary too
  (same-tick `stopAll()` after `render()` meant `audioCtx.currentTime`
  couldn't advance between them) — **that specific reliance was later
  replaced with an architectural guarantee** (see "Fresh adversarial plan
  review" below: `reward:summary` is now never scheduled at all on a
  skip-caused transition, not merely cancelled in time). The graceful-release
  behavior itself remains a real, independently useful engine guarantee.
  Locked in by a regression test in `tests/unit/audio-cue-engine.test.ts`.
- **`play()` now drops cues (no scheduling) unless `audioCtx.state ===
'running'`**, with a best-effort `resume()` call when `suspended` — closes a
  gap where a suspended/closed context could still schedule oscillators that
  would never audibly play but would leak scheduled nodes.
- **`reducedMotion` is now snapshotted once per `open()`** in
  `reward-opening-audio.ts` instead of read live on every hook call, so a
  mid-session settings toggle can't retroactively change an already-open
  session's audio behavior (matches the visual layer, which also snapshots at
  `open()`).
- **Escalation cues are now staggered `ESCALATION_STAGGER_MS = 90`ms** after
  their paired reveal cue via a new `delayMs` on `SynthCueSpec`, instead of
  both firing at the exact same `currentTime` (which risked reveal and
  escalation cues masking each other).
- **`RewardOpeningUI.close()` now guards `onVisibilityChange(false)` behind a
  `wasOpen` check** — `destroy()` unconditionally calls `close()` on every
  scene teardown, even when no reward was ever opened or it was already
  closed; without the guard this made the hook non-idempotent and would
  schedule a spurious close cue + defensive `stopAll()` on every normal scene
  teardown. Covered by a new dedicated unit-test file,
  `tests/unit/reward-opening-ui-visibility-hook.test.ts` (4 tests, using a
  minimal chainable fake `Phaser.Scene` since no other Phaser-heavy UI class
  in this codebase has a dedicated unit-test file — they're otherwise tested
  exclusively via E2E).
- Confirmed by design inspection (not a defect): audio cue intensity uses the
  session's FINAL/overall `RewardExcitement` bucket for every phase, matching
  `RewardOpeningUI.ts`'s own visual glow, which is computed once per `open()`
  and reused unconditionally across all phases — using a _progressive_
  intensity for audio would have made audio and visuals diverge.
- Engine-instance-scoping (one shared `AudioCueEngine` rather than one per
  cue-type) is documented as an intentional non-goal in
  `audio-cue-engine.ts`'s module doc comment, not an oversight.

### Fresh adversarial plan review + multi-model code review (final round, pre-PR)

Because this session spanned a context compaction, the original background
review-agent transcripts could not be retrieved. Per the ledger-honesty rule,
both stages were re-run **fresh** against the final, rebased diff rather than
fabricating the missing content — real time/tokens spent twice, but an
honest ledger.

**Adversarial plan review** (`gpt-5.4`, rubber-duck agent, 3 alternatives
considered, `plan_divergence: minor`) raised 2 Blocking + 2 Non-Blocking
concerns:

- **Blocking, fixed**: skip-cancels-summary-cue relied on a fragile same-tick
  `stopAll()`-after-`render()` cancellation proof instead of an architectural
  guarantee. `RewardOpeningUI.render()` now takes a
  `{ suppressPhaseChangeHook }` option; `handleSkip()` passes it so
  `onPhaseChange`/`reward:summary` is **never invoked** on a skip-caused
  transition — not merely inaudible, never scheduled.
- **Blocking, fixed**: reduced motion fired one `onItemRevealed`/reveal-cue
  per item in a same-tick reveal-all batch — the opposite of "reduced
  intensity." `tick()` now fires `onItemRevealed` once per same-tick batch
  under `reducedMotion`, reporting the batch's highest-rarity item so
  escalation tracking still sees the true peak.
- **Non-Blocking, accepted**: `isAvailable()` reports WebAudio support, not
  live playability — `play()` already handles suspended/closed contexts
  safely regardless, so this was judged not worth an API split.
- **Non-Blocking, accepted**: re-entrant `open()` silently overwrites session
  state — `open()` already unconditionally resets state and stops all voices
  first, so this is safe by construction; the real UI never re-enters
  without an intervening `close()` anyway.

**Multi-model code review** (`gpt-5.4` + `gemini-3.1-pro-preview`,
independently, against the same final diff): `gemini-3.1-pro-preview`
returned clean across all 6 categories. `gpt-5.4` found 2 new issues, both
independently re-verified against source before fixing:

- **Blocking, fixed**: a `delayMs`-scheduled cue (e.g. the escalation
  stagger) could turn a cancelled cue into an audible blip. `play()` only
  scheduled the near-silent gain floor at the future `startAt`, never at
  `now` — a Web Audio `AudioParam` holds its prior/default value (unity gain)
  until its first scheduled event's time actually arrives, so `stopAll()`
  cancelling during the pre-start delay window would snapshot-and-release
  from the unset 1.0 default instead of near-silent. Fixed by also
  scheduling the floor at `now`, immediately, in addition to `startAt`.
  New regression test in `audio-cue-engine.test.ts`.
- **Non-Blocking, fixed**: the skip cue's synth mapping
  (`synthSpecForCue`'s `'skip'` case) hardcoded frequency/gain, silently
  discarding the variable, excitement-scaled `intensity` that
  `cueForSkip()` already computes — the only cue kind (besides the
  intentionally-constant `close`) not honoring the tier+rarity intensity
  contract. Fixed by scaling frequency/gain by `intensity`, matching the
  `reveal`/`escalation`/`summary` pattern. Extended the existing
  "higher intensity yields a louder gain" unit test to cover `'skip'`.

All 4 stage findings and their resolutions are recorded in ADR 0071's "Plan
Review Resolutions" and "Multi-Model Code Review Resolutions" sections, and
in the review ledger
(`docs/knowledge/review-ledgers/2026-07-24-reward-opening-audio.review-ledger.json`).

The branch was also discovered to be 5 commits behind `origin/main` (still at
PR #1865's merge-base) partway through this session; all work was committed
in one commit and rebased cleanly onto `origin/main` with zero conflicts
before this final review round, so `git diff --stat origin/main` shows
exactly the 19 intended files.

**Real-artifact observation**: Observed via the E2E suite driving the real
`MainGameScene`/`RewardOpeningUI` pipeline (not lab-only) — before this
session, `RewardOpeningUIHooks` fired with no audio side effect at all
(silent reward-opening); after, `rewardAudioCueLog` on the real scene records
the exact deterministic cue sequence per phase transition, confirmed
`reward:anticipation → reward:reveal×N → reward:summary → reward:close` on
full walkthrough and `reward:anticipation → reward:skip → reward:close`
(zero reveal cues, `reward:summary` never scheduled at all) on immediate
skip. `npm run verify:fast` is green; `VERIFY_FULL=1 npm run verify` run for
this handoff since `npm run scope` reported `gameplay_safe=false` (real
`MainGameScene.ts` changed) — full suite (1465/1466, 1 pre-existing skip) and
the headless Floor-1 gate (150/150) both passed.

## Key Decisions Made

See `docs/knowledge/adr/0071-reward-opening-audio-cues.md` for full
context/decision/consequences/alternatives. Summary: 3-module split (pure
decision / generic reusable synth engine / glue) instead of one monolithic
audio class, so `AudioCueEngine` is reusable for any future non-reward sound
and the decision logic stays unit-testable without any `AudioContext`;
cancellation model is "always `stopAll()` before playing a new terminal-ish
cue," not a more complex ownership token; reduced-motion audio reuses the
existing visual `reducedMotion` flag rather than a second audio-only setting.

## What's Next / Blockers

**No blockers in this feature's own code, tests, or CI.** PR #1876
(`nalfeo-reward-audio-cues`) is fully green on its own merits: all CI jobs
pass, all 3 GitHub Copilot automated-reviewer threads are resolved, the review
ledger validates, and the repo's `merge-train` label is applied (this repo's
actual merge-arming mechanism — see "Round 5" below).

**Round 5 — repo-wide merge-train pause is the only remaining blocker, and it
is NOT specific to this PR.** While driving this PR to merge, discovered
`main`'s own current HEAD (`11eb223e1`, an unrelated direct-push CI-workflow
fix landed by someone else) broke `tests/unit/asset-request-workflow.test.ts`
(env-var mismatch after repointing the asset-request drain worker from Foundry
to Azure OpenAI per issue #1885). This repo uses a **custom merge-train**
(`.github/scripts/merge-train/reconcile.mjs`, dispatched by
`.github/workflows/merge-train.yml`) that performs real squash-merges directly
via the GitHub API and explicitly **disables GitHub's native `--auto` merge**
as a safety fence — so `gh pr merge --auto --squash` alone does not land
anything in this repo; the `merge-train` label is the actual queue-entry
mechanism. Its `mainHealthAllowsPromotion()` gate fails closed
(confirmed via `gh run view <id> --log`: `"paused merge train; latest
completed full-CI run for current main 11eb223e1... concluded failure"`) and
**pauses ALL promotions repo-wide**, not just this PR, until `main`'s own CI is
green again.

This is already being remediated independently: PR #1889 ("Align
asset-request workflow contract test with Azure OpenAI drain backend") was
already open, targeting the same root cause, before this session found it;
this session additionally fixed the identical break locally on its own branch
(commit `dbfbb02f6`) purely to keep this branch's own CI green — no direct
push to `main` was made from this session, since duplicating an in-flight fix
risks colliding with PR #1889 and several other branches actively working the
same merge-train incident (`copilot/fix-ci-incident-another-one`,
`copilot/fix-merge-train-promotion-confirmation`,
`nalfeo-fix-merge-train-dispatch-trigger`, `nalfeo-fix-merge-train-promotion`,
`copilot/check-branch-health`). Per the CI-Recovery-first policy, once one of
those lands and `main`'s CI goes green again, the merge-train's next
reconcile cycle (5-minute cron, or a `workflow_dispatch`) should promote PR
#1876 automatically — no further action should be required on this PR's own
content. A follow-up check of `gh pr view 1876 --json state,mergeCommit`
after that incident clears will confirm the final squash-merge SHA.

Recommended follow-ups (not required for this PR):

- When an `equipment`-type achievement or rarity-varying boss chest ships
  through real content (not just the generator-level calculator), extend the
  E2E suite to cover the rarity axis directly through gameplay — today that
  axis is proven only at the integration-test layer, as documented inline in
  that file's header comment and in ADR 0071's "Consequences" section.
- `audio-cue-engine.ts` is intentionally generic; a future session adding a
  second engine-layer sound (combat hits, UI chrome) should reuse it rather
  than growing a second `AudioContext`/no-audio-fallback implementation.

## Round 4: GitHub Copilot Automated PR Review

After PR #1876 opened with auto-merge armed and CI green, GitHub's automated
`copilot-pull-request-reviewer` bot left 3 legitimate inline findings (full
detail in ADR 0071's "GitHub Copilot Automated PR Review Findings" section),
addressed by a follow-up "Copilot cloud agent" run (`e829e3676`):

1. **Ledger process violation**: `multi_model_review` round 1 both found+fixed
   2 concerns and self-certified `clean: true` in the same round. Fixed: round
   1 now recorded `clean: false`; a genuine round 2 raised 2 further findings
   (below) and a true round 3, run against the fully-fixed diff, returned 0
   concerns and is the validating clean round.
2. **Real bug**: the reveal-batch audio-coalescing guard in
   `RewardOpeningUI.tick()` was gated on `reducedMotion`, but an unclamped
   Phaser frame `delta` in NORMAL motion (e.g. tab-resume) can also jump
   `revealedCount` by more than one item in a single `tick()` call,
   reproducing the same audio-stacking bug outside reduced motion. Fixed by
   dropping the `reducedMotion` gate so ANY same-tick multi-item batch
   coalesces, regardless of motion mode. New regression test drives a real
   non-reduced-motion `tickSequence()` through a large single-tick delta.
3. **PR-description/code mismatch**: the PR's stated hard contract used cue
   labels `reward:item-revealed`/`reward:rarity-escalation`; shipped code
   emitted the shorter `reward:reveal`/`reward:escalation`. Fixed by renaming
   the code's emitted labels (and all referencing tests) to match the
   originally-declared contract, rather than rewriting the contract to match
   the code.

This session additionally found and fixed a **CI-blocking Prettier formatting
issue** introduced by that follow-up commit (`tests/e2e/reward-opening-ux.test.ts`
and `tests/integration/reward-opening-audio-pipeline.test.ts` were not
`prettier --write`-formatted), which was failing the "Lightweight Checks" /
"Merge gate" / "ci" required checks. Fixed with `npx prettier --write` on both
files; re-verified format:check, lint, typecheck, and the full targeted unit
(51 passed) + integration (6 passed) + E2E (12 passed) suites all pass after
the fix.

This is a useful process lesson: GitHub's automated PR reviewer is a REAL
additional review source beyond the declared review-harness ledger stages,
and caught a genuine bug (#2) that 3 separate declared review rounds
(adversarial plan review, code review, multi-model review round 1) all
missed — likely because none of those rounds specifically stress-tested the
"unclamped frame delta" angle on the coalescing guard, only the
reduced-motion trigger it was explicitly designed for.

## Retrospective

### Lessons Learned

- Don't assume a UI's hook-firing order from memory/informal notes when
  writing new cross-cutting hooks against it — always re-verify against
  actual test output, especially for skip/interrupt paths. `handleSkip()`'s
  `render()` call fires the `phaseChanged('summary')` visual hook **before**
  the explicit `onSkip()` hook (since skip jumps straight from
  `anticipation`/`revealing` to `summary`, so the phase-change guard fires on
  that same call) — an easy-to-get-backwards ordering that only surfaced once
  two E2E assertions were written against the wrong assumed order and failed.
- Building the synth engine's no-audio fallback as a single `isAvailable()`
  gate at construction time (rather than scattering `try/catch` around every
  call site) made every downstream module — controller, wrapper, wiring —
  trivially safe by construction, and made "headless test runner has no
  AudioContext" a non-issue rather than a recurring special case.
- Closing the E2E suite's structural coverage gap (no shipped content varies
  rarity at fixed tier) with a targeted integration test that drives the real
  calculators directly, rather than either skipping that coverage or building
  fake content just to exercise it, kept the test honest about what layer
  actually proves what.

### Mistakes Made

- Two new E2E test assertions were initially written with an incorrect
  assumed skip-cue order (`anticipation → skip → close`, no `summary`).
  Caught immediately by running the suite (both failed), root-caused by
  re-reading `RewardOpeningUI.handleSkip()`/`render()` source, and fixed to
  the real order (`anticipation → summary → skip → close`). No downstream
  impact since it was caught before the integration test (which reused the
  now-correct order and passed first try) or the PR was opened.
- The full `VERIFY_FULL=1 npm run verify` run initially failed at the
  format-check step (Prettier flagged 8 new/changed files) because
  `npm run verify:fast`'s lint step doesn't run Prettier's format-check the
  same way the full `verify` pipeline's dedicated format-check step does; ran
  `npm run format` to auto-fix before re-running full verify.

### Opportunities for Future Improvement

- `verify:fast` and full `verify` disagreeing on whether Prettier formatting
  is clean (fast passed, full's dedicated format-check step failed on the
  same tree) is a minor local-loop friction point — worth confirming whether
  `verify:fast`'s lint step is expected to also catch format-only issues, or
  documenting explicitly that a full `verify`/`VERIFY_FULL=1` run is the only
  formatting-authoritative local check.

