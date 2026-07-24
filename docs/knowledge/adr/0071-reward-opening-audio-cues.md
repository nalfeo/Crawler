# ADR 0071: Reward-Opening Audio as a Reusable, Deterministic Cue Layer

## Status

Accepted

## Date

2026-07-24

## Estimated Complexity

🍎🍎🍎🍎 — new engine-layer subsystem (first audio system in the codebase),
touches the shared reward-presentation state machine's hook surface, wired
into real gameplay (`MainGameScene.ts`), with unit + integration + E2E
coverage. Bounded to the reward-opening feature; does not touch core ECS
determinism or cross multiple unrelated systems, so it stays below the
🍎🍎🍎🍎🍎 "spans 3+ systems" band.

## Context

PR #1865 shipped the reward-opening UX (`RewardOpeningUI` +
`reward-opening-sequence.ts` + `reward-presentation.ts`): a deterministic,
Phaser-rendered phase state machine (`anticipation → revealing → summary →
claimed`) with tier+rarity-scaled "excitement" driving visual intensity. It
shipped with **no audio** — `RewardOpeningUIHooks` existed only for visual
callbacks (`onPhaseChange`, `onItemRevealed`, `onSkip`, `onVisibilityChange`).

This work adds sound to that already-shipped, already-deterministic sequence,
without touching its state machine, without introducing any new
nondeterminism, and without shipping any binary audio asset (Crawler has no
audio-asset pipeline and no licensed/copyrighted audio — everything must be
synthesized procedurally from oscillator primitives, same spirit as the
existing "no Math.random/Date.now" and "no copyrighted/generated asset"
constraints already enforced for sprites).

Key constraints from the hard contract:

- Reusable hooks for anticipation, per-item reveal, rarity escalation,
  summary, skip/fast-forward, and close.
- Excitement must scale by **both** box tier and actual item rarity,
  consistent with the visual bucket (`RewardExcitement.score`/`.bucket`).
- Reduced-intensity/reduced-motion-compatible mixing (quieter/shorter, never
  silent) reusing the same `reducedMotion` flag the visual layer already
  computes — no second, audio-only reduced-motion setting.
- Deterministic scheduling driven by the existing presentation state (no
  `Date.now`/`Math.random` — every cue decision is a pure function of the
  sequence phase, rarity weight, and excitement score already computed by the
  existing deterministic modules).
- Clean cancellation/ownership: duplicate input (double-skip, double-
  acknowledge) or a scene transition must never overlap/leak audio.
- Safe no-audio fallback: audio must never throw, never block gameplay, and
  degrade silently if `AudioContext` is unavailable (headless test runners,
  browsers without WebAudio, autoplay-blocked contexts).

## Decision

Layer three new modules under the existing `src/shared` → `src/engine`
boundary, mirroring the existing visual pipeline's shape exactly instead of
inventing a new pattern:

1. **`src/shared/reward-audio-cues.ts`** (pure, `src/shared/`-layer, no
   Phaser/WebAudio imports) — the deterministic **decision** layer. Given the
   current phase transition, revealed-item rarity, `RewardExcitement`, and the
   `reducedMotion` flag, decides which `RewardAudioCue` (a `{kind, intensity,
reducedIntensity}` value, not a sound) fires and at what escalation
   intensity. Escalation state (`RewardAudioSessionState`) tracks a
   monotonically-increasing "loudest rarity seen so far this session" so a
   Common→Rare reveal sequence escalates, never de-escalates mid-session, and
   is exhaustively unit-tested in isolation from any synth/engine concern.
2. **`src/engine/audio/audio-cue-engine.ts`** — a **generic, reusable** WebAudio
   synth engine (`AudioCueEngine`), not reward-specific. Takes a
   `SynthCueSpec` (waveform, frequency, optional pitch glide, duration, gain,
   a `label` for observability) and drives a plain `OscillatorNode` +
   `GainNode` graph with a scheduled linear-ramp release — no samples, no
   external audio files, 100% procedural. `isAvailable()` reports `false`
   whenever `window`/`AudioContext` doesn't exist (Node/headless/blocked
   autoplay); every other method (`play`, `stopAll`, `dispose`) is then a
   guaranteed no-op that never throws — the safe no-audio fallback lives here,
   once, for any future engine-layer sound (not just rewards).
3. **`src/engine/reward-opening-audio.ts`** — the glue. `synthSpecForCue` maps
   a decided `RewardAudioCue` to concrete oscillator parameters (pure,
   independently unit-testable without any `AudioContext`).
   `createRewardOpeningAudioController` binds one `AudioCueEngine` + a live
   `excitement`/`reducedMotion` getter pair into a small
   `RewardOpeningAudioController` (`open/phaseChanged/itemRevealed/
skipped/closed`) that mirrors `RewardOpeningUIHooks`'s own shape 1:1. Every
   method that can end a prior sound in flight (`open`, `skipped`, `closed`)
   calls `engine.stopAll()` **before** playing its own cue — this is the
   entire ownership/cancellation model: there is only ever one active
   session, and any transition that could leak audio scrubs first.
4. **`RewardOpeningUI.ts`** wires the controller into its existing hook call
   sites unchanged in shape — `onPhaseChange`/`onItemRevealed`/`onSkip`/
   `onVisibilityChange(false)` now also call the audio controller's matching
   method. No change to the sequence state machine, its phase-change guard
   (`lastRenderedPhase`), or its skip/acknowledge idempotency — audio rides
   entirely on hooks that already exist and are already proven deterministic.
5. **`MainGameScene.ts`** owns one real `AudioCueEngine` instance per scene
   lifetime, constructs the controller through a **cue-logging wrapper**
   (`createRewardAudioCueLoggingEngine`) whose sole job is to push every
   dispatched `SynthCueSpec` onto a `rewardAudioCueLog` field for
   E2E/automation observability, and disposes/clears both on scene shutdown.

## Consequences

- **Positive**: audio is fully deterministic and replay-stable — the same
  presentation-state timeline always produces the same cue sequence, with no
  wall-clock or RNG dependency, so it is exhaustively testable at the unit,
  integration, and E2E layers without flaking.
- **Positive**: `audio-cue-engine.ts` is a genuinely reusable primitive — any
  future engine-layer sound (combat hits, UI chrome, ambient stingers) can
  reuse the same synth engine instead of each feature growing its own
  `AudioContext` plumbing and no-audio fallback.
- **Positive**: zero new asset/licensing/pipeline surface — no
  `sprites:*`-style generation step, no Azure dependency, no binary checked
  into the repo. The entire audio surface is source code.
- **Trade-off**: procedural synth cues are necessarily simple (oscillator +
  gain envelope) compared to sampled/composed audio — acceptable for this
  iteration's scope (functional, deterministic, on-brand chiptune-style
  stingers), not a full sound-design pass.
- **Trade-off**: the E2E suite's own rarity-axis case is a documented gap (no
  currently-shipped content path grants a rarity-varying `equipment` reward
  through real gameplay) — closed instead by
  `tests/integration/reward-opening-audio-pipeline.test.ts`, which drives the
  real `computeEquipmentExcitement` calculator directly. When an
  `equipment`-type achievement or rarity-varying boss chest ships, extend the
  E2E suite too (noted inline in its file-level doc comment).
- **Follow-up-none-required**: the cue-logging wrapper in `MainGameScene.ts`
  is test/automation-only surface (never gameplay-visible), guarded by the
  same `MainSceneInternals` structural-cast pattern already used for every
  other probe-lab observability field — no new precedent, no new risk.

## Plan Review Resolutions

A fresh adversarial plan review (separate model, `gpt-5.4`, rubber-duck agent)
was run against the actual final diff, considering 3 alternative designs
before endorsing this one (`plan_divergence: minor`). It raised 4 concerns:

1. **Blocking — skip-cancels-summary-cue relied on a fragile same-tick
   `AudioContext.currentTime` cancellation proof.** The original design let
   `RewardOpeningUI`'s ordinary `onPhaseChange` hook fire `reward:summary` on
   the skip-caused `anticipation → summary` jump, then relied on `skipped()`'s
   `stopAll()` firing synchronously afterward, in the same JS tick, to cancel
   that cue's gain ramp before it could become audible. Correct, but fragile
   and non-obvious — a future refactor that reordered the two calls, or added
   an `await`/microtask between them, would silently make the cue audible.
   **Resolved architecturally**: `RewardOpeningUI.render()` now accepts a
   `{ suppressPhaseChangeHook }` option; `handleSkip()` passes it so
   `onPhaseChange` — and therefore `reward:summary` — is **never invoked at
   all** for a skip-caused transition. The cue is not merely inaudible, it is
   never scheduled. `reward-opening-audio.ts`'s doc comment and the
   integration/E2E suites were updated to assert `'reward:summary'` is absent
   from the skip path's cue log, not merely present-but-silent.
2. **Blocking — reduced motion stacked N simultaneous reveal cues instead of
   reducing intensity.** `reward-opening-sequence.ts`'s `tick()` reveals every
   remaining item in one tick under `reducedMotion`, but
   `RewardOpeningUI.tick()` fired one `onItemRevealed` call per item in that
   batch — the opposite of "reduced intensity" for a multi-item box.
   **Resolved**: when `reducedMotion` is true and more than one item is newly
   revealed in the same tick, `tick()` now fires `onItemRevealed` **once** for
   the whole batch, reporting the batch's **highest-rarity** item (so
   escalation tracking still sees the true peak). Non-reduced-motion behavior
   (one item per tick) is unchanged. Covered by a new integration test
   (`reward-opening-audio-pipeline.test.ts`) that proves the coalesced cue's
   gain matches a standalone single-item session at the batch's peak rarity.
3. **Non-blocking — `AudioCueEngine.isAvailable()` reports WebAudio
   _support_, not current _playability_.** A context that exists but is
   `suspended` (autoplay-blocked) or `closed` still reports `isAvailable():
true`. **Accepted as-is**: `play()` already checks `context.state` and
   silently no-ops on `suspended`/`closed` (the safe-no-audio-fallback
   contract only promises "never throws, never blocks gameplay, degrades
   silently" — it does not promise `isAvailable()` is a live playability
   oracle). Renaming/splitting the method for this nuance was judged not
   worth the API churn for a single caller.
4. **Non-blocking — re-entrant `open()` silently overwrites session state
   without a matching `close()`.** **Accepted as-is**: `open()` is already
   idempotently safe regardless of ordering — it unconditionally calls
   `engine.stopAll()` and resets `session = createRewardAudioSessionState()`
   before anything else, so a stray double-`open()` cannot leak a stale voice
   or stale escalation state. `RewardOpeningUI`'s own state machine also never
   re-enters `open()` without an intervening `close()` in practice. Adding an
   assertion/warning for a call pattern that cannot occur through the real UI
   and is already safe by construction was judged unnecessary ceremony.

A parallel code-review pass (`claude-sonnet-4.6`, code-review agent) ran
against the same diff across 7 categories (correctness, determinism,
cancellation/ownership, reduced-intensity mixing, no-audio fallback, testing,
wiring) and returned `clean` with no issues.

## Alternatives Considered

- **Bundle/ship pre-rendered short audio clips**: rejected outright — the hard
  contract explicitly forbids copyrighted audio, the asset-generation
  pipeline, and checked-in generated audio assets; procedural synthesis is the
  only compliant option.
- **Drive cues from wall-clock timers (`setTimeout`/`Date.now`) independent of
  the sequence state machine**: rejected — would reintroduce exactly the kind
  of nondeterminism the reward-opening UX was built to avoid, and would be
  unobservable/untestable deterministically in CI.
- **A single monolithic `RewardOpeningAudio` class owning both decision logic
  and WebAudio playback**: rejected in favor of the 3-module split above,
  because it would make `AudioCueEngine` non-reusable for future non-reward
  sounds and would force `reward-audio-cues.ts`'s pure decision logic to pull
  in Phaser/WebAudio just to be unit-tested.
