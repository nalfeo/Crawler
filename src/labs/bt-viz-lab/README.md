# Behavior Tree Visualization Lab

Real-time debugger for the multi-track `BehaviorTreeAI` driving a live Floor 1
scene. Merges the old `bt-viz` and `parallel-bt` labs into one — there is only
one AI tree (a `Parallel(OBSERVE)` root with two tracks), so there is only one
lab.

Open with `npm run lab` → `?lab=bt-viz`.

## What it shows

- **Track A (Movement Goal)** — the exclusive priority selector that picks one
  movement target per frame (Retreat > Interact > Progress > Engage > Collect >
  Hunt > Explore). The top panel shows the current state, reason, and target.
- **Track B (Opportunistic)** — pull/dodge vectors blended into Track A. Live
  collect-pull, farm-pull, and dodge values with active/dormant indicators.
- **Compass overlay** — yellow = raw Track A direction, green = final blended
  direction, cyan = collect pull, orange = dodge.
- **Tree structure** — the serialised tree with Track A / Track B highlighted
  and a node-type colour legend.

## Determinism

The AI runs on a fixed seed (`54321`) with `SeededRandom`; the panel refreshes
at ~10 Hz off `getDecision()` / `getOpportunisticDebug()`.
