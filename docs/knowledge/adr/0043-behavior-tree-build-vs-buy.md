# ADR 0043: Behavior tree — build vs. buy

## Status

Accepted

## Date

2026-06-26

## Estimated Complexity

🍎 x 2 — a build-vs-buy fit-gap for one internal subsystem (`src/game/ai/`),
with a determinism constraint that eliminates most off-the-shelf options.

## Context

The AI runner (`src/game/ai/headless-runner.ts`) needs a behavior tree to
compose leaf behaviors — approach target, back off to standoff distance,
melee swing, ranged fire, wander, path to point. Two candidate JavaScript
behavior-tree libraries were evaluated:

- [`behavior3js`](https://www.npmjs.com/package/behavior3js) — full editor +
  runtime, ~30 kB, tick loop uses closure-scoped state.
- [`behaviortree`](https://www.npmjs.com/package/behaviortree) — smaller
  (~5 kB) runtime-only, callback-based tick.

Both libraries schedule internal callbacks (`onEnter`, `onTick`, `onExit`) in
an order that is not guaranteed across their own minor versions and is not
seeded off the game's `SeededRandom`. That breaks Rule #3 (never
`Math.random()`) and, more importantly, breaks the seeded-reproducible ECS
sim invariant the headless gate depends on: two runs with identical seed
must produce identical `RunStats`.

Beyond determinism, both libraries add a first-party runtime dependency to a
project whose policy is **zero non-essential deps**, and the API surface each
exposes is larger than the ~5 leaf types this project actually needs.

## Decision

**Hand-roll the behavior tree in-tree.** Land it at
`src/game/ai/behavior-tree.ts` (~420 lines):

- Nodes: `Sequence`, `Selector`, `Decorator (Inverter/UntilSuccess)`, `Leaf`.
- Tick contract: `(actorId: EntityId, ctx: TickCtx) => Status` where
  `Status = 'success' | 'failure' | 'running'`.
- No RNG inside the BT — leaves that need randomness receive a
  `SeededRandom` from `ctx`.
- No `Date.now()` — timers use the runner's `frameCount * FRAME_MS`.

This satisfies the build-vs-buy fit-gap rule (`docs/agent-os/policies/complexity-policy.md`):
the third-party API surface exceeds what we need, the determinism cost is
non-negotiable, and the hand-roll is small enough to own.

## Consequences

**Positive:**

- Determinism preserved. Headless gate passes across identical seeds without
  any special-casing.
- Zero new runtime dependencies.
- Ownership is obvious; extending the BT (e.g., new leaves for Floor 2 AI)
  edits one file, no framework indirection.

**Negative:**

- We own the tree traversal, the tick semantics, and the debug story. No
  visual editor.
- Future contributors must resist the temptation to `npm i behavior3js` when
  the tree grows — this ADR is the durable "no" to that PR.

## Alternatives considered

- **`behavior3js`** — rejected: non-deterministic tick order, unused editor,
  ~30 kB runtime.
- **`behaviortree`** — rejected: callback ordering not seeded/deterministic,
  and its `Selector` short-circuit semantics differ from what we need.
- **Ad-hoc `if/else` in `enemyAISystem`** — rejected: was the status quo
  before this ADR; grew unreadable at 5+ behaviors and had no reusable
  composition (sequence / selector / decorators).

<!-- Sources: docs/knowledge/handoffs/2026-06-18-behavior-tree-ai.md
     and 2026-06-26-mcp-and-skills-tooling.md -->
