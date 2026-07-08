# AI Pathing Rework — Live Slice-Map

**Status:** active (S4b in-flight) · **Last verified:** 2026-07-08 against
`git`/`gh` · **Owner:** AI-Rework producer session

This is the single **source-of-truth** for the AI pathing/decision rework. It
replaces the per-PR + per-session-handoff tracking that lost the thread (the plan
previously lived only in a non-repo `plan.md` + scattered handoffs). When this
doc and a per-slice handoff disagree, **code wins** — the runtime defaults in
`src/game/ai/bt-ai-tuning.ts` and `src/game/ai/headless-runner-cli-lib.ts` are
ground truth; fix this doc and note the reconciliation.

---

## Goal (maintainer intent)

- Move to **navmesh** as the base pathing method.
- Integrate **danger / reward fields**, and **encourage the AI to travel the
  seams** — the danger-zone boundary, where the agent can farm while kiting.
- **Separate the two responsibilities**: the Behavior Tree (BT) decides the
  _goal(s)_; the pathing system decides _how_ to travel — reaching the goal,
  farming, and minimizing damage.
- Make **both pathing systems A/B-testable** so nothing is a one-way door.

---

## Architecture — two independent, A/B-testable axes

Everything is a toggle. Neither axis changes the default game.

- **Decision axis** (BT — _what_ goal): `LEGACY` | `SLACK_AWARE`
- **Pathing axis** (_how_ to travel):
  - `LEGACY` — the shipped grid pathing.
  - `RISK_REWARD_FUSED` — grid danger/reward candidate-fan scorer + seam-seeking.
  - `NAVMESH` — deterministic recast waypoint routing (plain shortest-path).
  - `NAVMESH_FUSED` — navmesh route first, then the tuned danger/reward fan
    deflects the heading at follow-level (implicit seam).
  - **+ explicit seam-following term** — S4b (in-flight).

The enum lives in `src/game/ai/` types; the scorer + follower live in
`src/game/ai/bt-ai-provider.ts`; recast/WASM is isolated under
`src/game/ai/navmesh/`.

---

## Invariants (non-negotiable, CI-enforced)

1. **Default `LEGACY` / `LEGACY` — main byte-identical.** Every new mode is
   **opt-in, default-OFF**, so it _cannot_ regress the live game or its score.
   Enforced by the headless Floor-1 collision-pair-parity gate + unit
   byte-identity tests.
2. **Deterministic.** `SeededRandom` only — never `Math.random`/`Date.now`.
   Each navmesh mode ships its own determinism golden, and the recast query is
   proven **cross-platform** (Windows ↔ Linux byte-identical, golden
   `75917f12`).
3. **Costs, not geometry** (the load-bearing Slice-3 lesson). Under the pinned
   deterministic recast config, **navmesh reachability is a fragile subset of
   4-connected grid reachability** at thin/door connectors — removing one
   connector tile severs the mesh but not the grid. Therefore danger / threat /
   door semantics are applied as **query- and follow-time costs, never navmesh
   geometry rebuilds**. The mesh is **static all-doors**, built once per floor.
4. **Wired + lab-gated + observed.** Every `*System` is wired into a real
   pipeline (ADR 0039); every system has a lab; and per rule #10 each behavior
   change is observed in a **real artifact** (the game or the headless runner),
   never lab-only.

---

## Slice status

| Slice   | What                                                                       | PR(s)                        | Status       |
| ------- | -------------------------------------------------------------------------- | ---------------------------- | ------------ |
| **S0**  | Two-axis A/B toggle + viz harness (LEGACY-default, byte-identical)         | **#851**                     | ✅ merged    |
| **S1**  | Navmesh determinism spike — recast deterministic + cross-platform GO/NO-GO | — (spike, consumed into S3)  | ✅ done      |
| **S2**  | `RISK_REWARD_FUSED` — grid danger/reward candidate-fan scorer + seam-seek  | **#897** (+ **#899** rename) | ✅ merged    |
| **S3**  | `AIPathingMode.NAVMESH` — deterministic recast waypoint pathing            | **#913** (+ **#914** lock)   | ✅ merged    |
| **S4a** | `NAVMESH_FUSED` — danger/reward fan on the navmesh follow (implicit seam)  | **#918**                     | ✅ merged    |
| **S4b** | **Explicit seam-following term** (tangential-to-gradient + reachability)   | —                            | 🔄 in-flight |

- **#899** was a scanner false-positive test-file rename (the secret scanner's
  OpenAI-key regex matched `sk-reward-fused-` inside a lowercase filename); it
  carries no behavior.
- **#914** locked the NAVMESH follower invariants (LEGACY byte-identity /
  dormancy / partial-path-guard non-freeze) as a permanent CI regression net
  before S4.

### S4b design (fork resolved 2026-07-08)

The chosen seam philosophy is **(A) tangential-to-gradient + reward-reachability**:
reward candidate headings that are **perpendicular to the local danger
gradient** (travel _along_ the iso-danger contour = the seam), **gated by reward
actually reachable along that boundary** (so the agent _farms_ the seam rather
than orbiting a contour). Rejected alternatives: "declare the implicit danger
term sufficient" (that would quietly redefine the named feature — a rule-#12
weakening; S4a stands only as the A/B control) and "reward being _on_ the seam"
(rewards position, not travel).

Guardrails for the implementation:

1. **Additive** — `seamWeight = 0` reproduces S4a **byte-identically**, so S4a
   is the A/B control and the hard gate can't regress at zero.
2. **Reward-reachability gate is mandatory** — farm the seam, don't orbit it.
3. **Goal progress must still win** — anti-orbit: with no reachable seam-reward
   or under deadline pressure, the goal term dominates so the agent always
   completes.
4. **Instrument `navPartialPathFallbacks`** in the sweep — a spike means the
   tangential term is dragging the follower off-mesh into a recast⊊grid pocket
   (the Slice-3 failure mode at the fan layer); clamp it.

**Tuning is two-stage and human-gated:** the seam weight is _parameterized_, a
small candidate set (0 / low / mid / high) is swept on the 36-pair headless
sweep with the ai-runner seam viz captured, and only then is the **final weight
adjudicated** against the hard gate + ranked soft tiebreakers. No weight is
locked solo, and gameplay is never tuned to rescue individual seeds (rule #13).

**Feature-complete = S4b merged** — all four pathing modes × two decision modes,
danger/reward + explicit seams, all A/B-testable.

---

## The graduation gate (human-gated) — where score actually moves

Flipping the runtime **default** away from `LEGACY` to a proven-superior mode is
a deliberate, **human-gated gameplay decision**. It happens only after a
large-N, per-mode, 3-weapon Floor-1 winrate sweep proves the candidate mode is
**≥ LEGACY** on win rate with no per-weapon regression. This default-flip is the
real Goal-2 lever; until it happens the defaults stay `LEGACY` / `LEGACY` and the
rework is pure upside-only optionality.

### Winrate-sweep guidance

- A **LEGACY-mode** sweep measures **main's balance** — it is stable today and
  will _not_ shift with any rework slice (all slices are opt-in). Use it as the
  baseline (`npm run ai:weapon-sweep`).
- A **`NAVMESH_FUSED`** number is **not stable until S4b's seam weight locks** —
  defer the mode-comparison sweep until then, or it just re-shifts next slice.
- ⚠️ The current **LEGACY** Floor-1 baseline is **~81–86%**, below the rule-#13
  **90%** north-star. This is a **pre-existing main balance property**,
  independent of the rework. Closing it is the job of the graduation lever (a
  better default mode), not of any individual slice.

---

## Superseded / not on the critical path

- **PR #811** (`nalfeo-game-dev-tools-research`) — the original big-bang branch
  that would have flipped the default to `riskRewardFused` (violates invariant
  #1). Its fused pathing was re-landed the safe, opt-in way via #897 / #913 /
  #918. **Closed as superseded.** The only un-landed remnant worth salvaging is
  the live sweep-progress JSON in `scripts/agent/perf/weapon-sweep.ts` (optional
  tiny chore).

---

## Backing handoffs

Durable per-slice context (the auto-generated
[`handoffs/INDEX.md`](handoffs/INDEX.md) also indexes these under the
`ai-pathfinding` system):

- **S0** — [`2026-07-07-ai-ab-harness`](handoffs/2026-07-07-ai-ab-harness.md)
- **S2** — [`2026-07-08-fused-seam-pathing`](handoffs/2026-07-08-fused-seam-pathing.md)
- **S3** — [`2026-07-08-navmesh-pathing-mode`](handoffs/2026-07-08-navmesh-pathing-mode.md)
  - [`2026-07-08-navmesh-follower-tests`](handoffs/2026-07-08-navmesh-follower-tests.md)
- **S4a** — [`2026-07-08-navmesh-fused-pathing`](handoffs/2026-07-08-navmesh-fused-pathing.md)
