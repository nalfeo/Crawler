# ADR 0036: Wire spawnerSystem into the real pipelines + placeholder tint

## Status

Accepted

## Date

2026-07-02

## Estimated Complexity

🍎 x 4 — a small root-cause fix (one missing `spawnerSystem` call per pipeline)
that nonetheless spans `bootstrap`, `engine`, and `game`, changes gameplay
balance, and required the full 4-apple review harness plus real-pipeline runtime
validation.

## Context

The generic spawner mob-type (Rats Nest, Slime Pool) and its juice —
`spawnerPulse` world VFX and `SpawnAnim` child pop-in — were built and
lab-proven in prior work (ADR 0034). But `spawnerSystem` was **never called** in
either real game pipeline. It ran only inside `spawner-lab`, which imports and
invokes `spawnerSystem` directly. As a result:

- In the actual game and headless runner, spawners were inert: no trickle
  children, no pulse, no pop-in. The entire feature shipped turned off.
- ADR 0034 explicitly chose to "validate the behavior with gameplay tests plus
  the existing `spawner-lab` runtime flow rather than adding a new lab" — but the
  lab force-calls the system under test, so a green lab could never reveal that
  the game does not call it. "Observe before done" was satisfied in the wrong
  artifact.

Two further facts shaped the fix:

1. There are **two** hand-maintained simulation pipelines — a visual one
   (`src/engine/sim/simulation-step.ts`, wired via
   `src/bootstrap/floor-main-scene-options.ts` `preSystems`) and a headless one
   (`src/game/ai/simulation-step.ts`, executed by the win-rate gate and
   `headless-runner`). They are **not** byte-identical: the enemy director runs
   pre-core in visual but post-core in headless; the weapon system runs
   pre-movement in visual but post-movement in headless.
2. Placeholder spawner sprites were visually indistinguishable from real art, so
   it was not obvious which spawners are still placeholders.

## Decision

Turn the feature on in the real game, make placeholders obvious, and keep balance
neutral — without over-claiming pipeline equivalence.

1. **Wire `spawnerSystem` into both real pipelines.** Add the call to the visual
   `preSystems` (`…enemyAISystem, spawnerSystem, floor1EnemyDirectorSystem`) and
   to the headless `runSimulationStep` (pre-movement). In both pipelines
   `spawnerSystem` runs **before** `floor1EnemyDirectorSystem` in the same frame,
   so the director's population cap counts this frame's freshly-spawned children.
2. **Shade placeholder spawners bright red.** Add
   `PLACEHOLDER_SPAWNER_TINT = 0xff3030` and a pure `placeholderSpawnerTint()`
   helper in `sprite-kind.ts`; apply the tint per-frame in `PhaserBridge`, gated
   to placeholder spawner enemy sprites. The tint is pure render-path with no
   wiring dependency.
3. **Tune spawner rates/caps down** in `src/game/spawners/registry.ts` so
   newly-live spawners keep Floor 1 win-rate neutral (measured, not guessed).
4. **Validate wiring in the real pipeline, not the lab.** Add an integration test
   that drives the real visual + headless Floor 1 pipelines and asserts children
   spawn, plus an ordering-contract test. The lab remains valid only for
   observing the pure render-path tint.
5. **Document, don't hide, the pipeline divergence.** Comments claim only the true
   shared invariant (spawner-before-director in both; adjacent only in visual) and
   reference tracking issue **#663** (pipeline unification). No
   "byte-identical / mirrors / provably-conservative" language.

## Consequences

### Positive

- The spawner feature (children, pulse, pop-in) is actually live in the real game
  and headless runner for the first time.
- Placeholder spawners are unmistakable (bright red), reducing the chance a
  placeholder is mistaken for shipped art.
- Win-rate stays at the pre-existing baseline (75% over seeds 1–20), so the fix is
  balance-neutral and verifiable.
- The visual↔headless divergence is now written down and tracked (#663) instead of
  silently assumed away.

### Negative

- Spawner wiring now lives in two places (visual `preSystems` and headless
  `runSimulationStep`) until #663 unifies the pipelines; the ordering contract
  must be kept in sync in both.
- Placeholder tint adds a per-frame render-path branch for spawner enemy sprites.

### Risks

- The two pipelines can drift again (a feature correctly ordered in one, subtly
  mis-ordered in the other). Mitigated by the ordering-contract test and #663.
- The Floor 1 win-rate target (90%+) remains **unmet** at 75%, but this is
  pre-existing (baseline is also 75%) and dominated by an AI-runner EXPLORE-timeout
  bug (#652), not spawner deaths. Mitigated by filing #652 as the real lever;
  spawner balance was deliberately **not** bent to chase the number.

## Alternatives Considered

- **Move the headless pipeline order to match visual (make spawner→director
  adjacent everywhere).** Rejected as out-of-scope for this fix — it is a broader,
  riskier change to a gate-critical pipeline; tracked in #663 instead.
- **Rely on `spawner-lab` for validation (as ADR 0034 did).** Rejected: the lab
  force-calls `spawnerSystem`, so it cannot prove the real game calls it. This is
  the exact failure this ADR corrects; wiring is validated in the real pipelines.
- **Skip the red tint / use a subtler marker.** Rejected: the explicit ask was to
  make placeholders obvious, and a saturated tint is the least ambiguous signal.
- **Raise spawner output for more pressure.** Rejected: measurement showed the
  conservative rates keep win-rate neutral; increasing output risked bending
  balance against the seeds (Rule #13).
