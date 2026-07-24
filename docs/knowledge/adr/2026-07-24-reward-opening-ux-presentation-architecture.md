# ADR: Deterministic Reward-Opening UX (Anticipation → Reveal → Summary → Claimed)

## Status

Accepted

## Date

2026-07-24

## Estimated Complexity

🍎 x 5 — new cross-layer presentation system (core state machine + shared
excitement scaling + engine renderer) wired into two existing UIs
(achievements, boss chests) and the real game scene, with save/load-safe
resume and exact-once claim semantics.

## Context

Reward bundles (#1810), achievement content (#1824), and boss chest lifecycle
(#1823) landed independently and each resolve a reward bundle (gold +
items/equipment) at grant time, but none of them presented that resolution to
the player as an event — bundles were applied silently. The ask was a single,
reusable, Vampire-Survivors-inspired "reward-opening" UX (anticipation →
reveal(s) → summary → claimed/close) shared by both achievement boxes and boss
chests, where:

- Excitement intensity must scale independently by **box tier** and by the
  **actual highest item rarity** in the resolved bundle (a tier-2 box that
  happens to roll only commons should read as visually calmer than a tier-2
  box that rolls an uncommon+).
- The sequence must be **deterministic and headless-reproducible** — no
  randomness in presentation timing/branching, and no in-place generation of
  new rewards (presentation only renders an already-resolved, persisted
  bundle).
- Players must be able to **skip/fast-forward**, must get a **reduced-motion**
  path, and input must be **owned/locked** to the reward-opening UI while it
  is active (no accidental double-claims or scene interaction bleed-through).
- The presentation must be **save/load-safe**: if the game is closed mid
  anticipation/reveal, reloading must resume the same presentation from the
  persisted resolved bundle rather than re-rolling or silently dropping it.
- Claiming a reward bundle must be **exact-once** through the same shared
  grant APIs boss chests and achievements already used — presentation must
  never mutate canonical bundle contents, only observe and eventually call the
  existing claim/grant entry point.

## Decision

Introduce a single shared, pure, deterministic **phase state machine**
(`src/shared/reward-opening-sequence.ts`) with phases
`anticipation → revealing → summary → claimed`, driven by an explicit
`tick(deltaMs)` API. The state machine:

- Advances by exactly one `deltaMs` per call and performs **at most one**
  phase transition per tick (no chained transitions within a single call),
  making its behavior trivially reproducible frame-by-frame in both the real
  game loop and headless/E2E harnesses.
- Reveals items one at a time in normal mode (timed via
  `DEFAULT_PER_ITEM_REVEAL_MS`) or all-at-once in reduced-motion mode, but
  only transitions `revealing → summary` on a tick **after** the incoming
  `revealedCount` is already full — guaranteeing at least one observable
  fully-revealed `revealing` frame before summary, in both motion modes.
- Computes excitement tier from `(boxTier, highestItemRarity)` as two
  independent axes (`src/shared/reward-presentation.ts`), so intensity is
  never a function of box tier alone.

This state machine is a pure `src/shared` module with no Phaser or ECS
dependency, callable identically from unit tests, property tests, the
headless E2E harness, and the real `RewardOpeningUI` engine renderer.

**Persistence / resume**: achievements gained a `pendingPresentations`
ticket-queue on `world.achievements` (persisted through carryover), and boss
chests gained a `revealedGrant` field on their carryover state recording the
already-resolved bundle. On load, `MainGameScene` and both UIs re-drive the
same `RewardOpeningUI` from whatever ticket/`revealedGrant` is pending,
resuming presentation rather than re-rolling. Carryover restore is
**fail-closed**: a boss chest persisted as `revealed`/`claimed` without a
`revealedGrant` throws `PlayerCarryoverSnapshotError` rather than silently
accepting an inconsistent save.

**Rendering / integration**: a single `RewardOpeningUI` (Phaser, `src/engine`)
is shared by `AchievementsUI` and `BossChestUI` (`src/game`) — boss chests
auto-open through the same renderer achievements already used, rather than
inventing separate chest-interaction presentation semantics. `RewardOpeningUI`
only reads the resolved bundle and calls the existing shared claim API on
input; it never computes or mutates reward contents.

**Input lock**: `RewardOpeningUI` owns input exclusively while open (skip/
fast-forward is the only accepted input in `anticipation`/`revealing`; claim/
close is the only accepted input in `summary`), so duplicate claim input and
scene-interaction bleed-through are structurally prevented rather than
guarded by ad hoc flags at each call site.

**No audio in this slice**: `reward-opening-sequence.ts` exposes phase/tick
data as stable hooks a later audio slice can subscribe to, but does not add
sound itself.

## Consequences

### Positive

- One shared, pure, deterministic sequence definition for both reward
  sources — no duplicated timing/phase logic between achievements and boss
  chests, and no divergence risk between them going forward.
- Fully headless-reproducible: the same `tick()` semantics back unit tests,
  property tests, and the real game loop, so save/load and reduced-motion
  paths are provably tested rather than only manually eyeballed.
- Presentation is structurally incapable of mutating canonical bundle
  contents (it only ever reads a resolved bundle and calls the existing claim
  API), so this change cannot introduce reward-generation bugs.

### Negative

- Adds a third cross-cutting module family (`src/shared` state machine +
  `src/engine` renderer + `src/game` wiring) that any future reward source
  (e.g. a new box tier or event reward) must integrate with correctly rather
  than rolling its own presentation.
- The one-tick-delay-before-summary invariant is subtle: any future change to
  `tick()` must preserve "no same-tick revealing→summary transition on first
  full reveal" or silently reintroduce the round-2 review regression (no
  observable full-reveal frame).

### Risks

- `pendingPresentations`/`revealedGrant` persistence adds new carryover
  schema surface; the fail-closed validation mitigates silent data loss but
  means a malformed/older save with a stuck boss chest now hard-fails on load
  instead of degrading gracefully — acceptable given the alternative (silent
  reward loss) is worse, but worth flagging for future carryover-migration
  work.

## Alternatives Considered

1. **Provenance/claim-history reconstruction for resume** — rebuild "what
   should be presented" on load by replaying claim history instead of
   persisting an explicit pending-presentation ticket/`revealedGrant`.
   Rejected as significantly more complex and harder to make fail-closed; the
   explicit ticket-queue is simpler to reason about and to validate.
2. **Separate boss-chest-specific presentation UI** instead of reusing
   `RewardOpeningUI`/`AchievementsUI`'s shared renderer. Rejected: would
   duplicate the entire phase/timing/excitement-scaling logic and risk the
   two reward sources drifting out of sync; auto-opening boss chests through
   the same shared renderer keeps one source of truth.
3. **Same-tick `revealing → summary` transition** (the original design) once
   `revealedCount` reaches `itemCount`. Rejected after round-2 review found
   this makes the full-reveal frame unobservable in real gameplay/E2E timing;
   the state machine now guarantees at least one extra tick in `revealing`
   with a fully-revealed set before transitioning.
