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

### Review-harness fixes (adversarial plan review + code review round 1)

Both an adversarial plan review and a code-review pass surfaced the same root
cause from two angles plus five other concerns, all resolved before PR:

- **`stopAll()`/`clearAllVoices()` now does a graceful ramped release**
  (`cancelScheduledValues` + a `GRACEFUL_RELEASE_SEC = 0.02`s linear ramp to
  near-silence + a deferred `osc.stop()`) instead of a hard `osc.stop(0)`. This
  is provably why `handleSkip()`'s synchronous `render()` (plays the
  `reward:summary` cue) immediately followed by `hooks.onSkip?.()` (calls
  `stopAll()`) never produces an audible click or an audible `summary` cue:
  since both calls run in the same JS tick, `audioCtx.currentTime` cannot
  advance between them, so the graceful cancellation always lands before the
  cue's attack envelope rises above its near-silent floor. Locked in by a new
  regression test in `tests/unit/audio-cue-engine.test.ts`.
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

**Real-artifact observation**: Observed via the E2E suite driving the real
`MainGameScene`/`RewardOpeningUI` pipeline (not lab-only) — before this
session, `RewardOpeningUIHooks` fired with no audio side effect at all
(silent reward-opening); after, `rewardAudioCueLog` on the real scene records
the exact deterministic cue sequence per phase transition, confirmed
`reward:anticipation → reward:reveal×N → reward:summary → reward:close` on
full walkthrough and `reward:anticipation → reward:summary → reward:skip →
reward:close` (zero reveal cues) on immediate skip. `npm run verify:fast` is
green; `VERIFY_FULL=1 npm run verify` run for this handoff since
`npm run scope` reported `gameplay_safe=false` (real `MainGameScene.ts`
changed).

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

No blockers. Recommended follow-ups (not required for this PR):

- When an `equipment`-type achievement or rarity-varying boss chest ships
  through real content (not just the generator-level calculator), extend the
  E2E suite to cover the rarity axis directly through gameplay — today that
  axis is proven only at the integration-test layer, as documented inline in
  that file's header comment and in ADR 0071's "Consequences" section.
- `audio-cue-engine.ts` is intentionally generic; a future session adding a
  second engine-layer sound (combat hits, UI chrome) should reuse it rather
  than growing a second `AudioContext`/no-audio-fallback implementation.

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
