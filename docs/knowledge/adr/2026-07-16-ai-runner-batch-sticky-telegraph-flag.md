# ADR: AI-runner 16× batch sticky telegraph flag

## Status

Accepted

## Date

2026-07-16

## Estimated Complexity

🍎 x 2 — single-field store addition, three-file change, dev-tooling visual
fidelity only (no gameplay impact)

## Context

`MainGameScene`'s fixed-step catch-up loop can run up to
`MAX_STEPS_PER_FRAME * simulationSpeed` sim steps per rendered frame.
`PhaserBridge.sync()` — which drives all Phaser rendering — is called once per
rendered `update()` call, after the entire batch.

At the AI-runner lab's `16×` playback speed (SPEED_OPTIONS = [1, 4, 16]) a
batch covers ≈ 267ms of sim time. The enemy-projectile telegraph cue added in
PR #1196 has a default delay of 250ms, meaning the complete telegraph lifecycle
(start → fire) can occur entirely within one catch-up batch. When that happens,
`telegraphActive` transitions 0 → 1 → 0 before the next `sync()` call and the
cue is never drawn, even though the AI correctly dodged the shot mid-batch.

This is a dev/debug-tooling visual fidelity issue only:

- Production gameplay always runs at `simulationSpeed = 1` (one step per frame,
  always synced immediately), so the cue renders reliably there.
- The headless AI runner has no Phaser rendering at all; it is unaffected.
- Only the AI-runner lab at 16× speed is affected.

The issue was surfaced during the #1196 review and tracked separately as #1199.
The ADR for the telegraph feature itself lives in
`docs/knowledge/adr/2026-07-16-enemy-projectile-telegraph.md` (in PR #1196).

## Decision

Implement **Option 2** from issue #1199: add a per-entity
`telegraphWasActiveThisFrame: Uint8Array` sticky flag to the `enemyBehavior`
store. The flag is:

- **Set** by `startEnemyProjectileTelegraph()` (alongside `telegraphActive`),
  so it captures every telegraph start regardless of how many steps run before
  the next sync.
- **Read** by `PhaserBridge.sync()` as an additional condition:
  `isTelegraphing = (telegraphActive === 1 || telegraphWasActiveThisFrame === 1)`.
- **Cleared** by `PhaserBridge.sync()` after rendering the entity's telegraph
  section, so the cue renders for exactly **one** rendered frame when the
  telegraph completed within a batch, then disappears.

The existing `telegraphActive` path is unchanged for normal (1× speed) gameplay
and for multi-frame telegraphs.

## Alternatives Considered

### Option 1: Call a lightweight `bridge.sync()` (or "flush transient cues" hook) after each step in the catch-up loop

**Rejected.** Every sync() call involves iterating all visible entities, updating
Phaser game objects, and triggering Phaser's internal dirty tracking. At 16× speed
that means up to 16 full render passes per displayed frame even though only the
last one produces a pixel. This would significantly impact lab performance and
risks introducing subtle Phaser state corruption from partially-rendered frames.
It also changes the rendering architecture for all entities (not just telegraphs),
making the scope much larger than the bounded fix this issue calls for.

### Option 2: Per-entity "was active this frame" sticky flag (chosen)

**Accepted.** The store addition is one typed-array field (8 bytes per entity).
The PhaserBridge change is ~15 lines. No rendering-loop restructuring. Generalises
to any future short-lived cue that could start and end within a batch (e.g. a
hit-flash, floating damage number). The flag is always cleared at sync() time, so
it cannot accumulate state across frames and cannot affect headless runs (where
PhaserBridge is never instantiated).

## Consequences

### Positive

- AI-runner lab 16× playback shows a telegraph cue for at least one frame for
  every shot, matching what production players see at 1×.
- No gameplay, damage, timing, or seed-run changes of any kind.
- Pattern generalises: any future short-lived cue that should survive a multi-step
  batch can use the same `wasActiveThisFrame` convention.

### Negative / Risks

- One extra `Uint8Array` field in the `enemyBehavior` store (negligible memory:
  `DEFAULT_MAX_ENTITIES` bytes ≈ 4 KB).
- `PhaserBridge.sync()` now writes to a world store field (`telegraphWasActiveThisFrame`)
  each frame. This is intentional — the flag is render-frame lifecycle state — but
  it means rendering code mutates the ECS store. Precedent: `combatEvents` is
  drained by the render side. The write is a single typed-array zeroing, so it is
  inexpensive and deterministic.

## Systems Touched

`engine-rendering` (PhaserBridge), `enemy-combat` (enemyBehavior store,
enemyTelegraph.ts)
