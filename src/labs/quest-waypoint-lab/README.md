# Quest Waypoint Lab

Exercises `getQuestWaypoints` (core) + `HudDirectionArrows` (engine).

## What it tests

- The off-screen direction arrow rotates to point at the tracked quest's active
  objective and shows the feet distance.
- The arrow hides once the target enters the viewport (target distance small).

## Use

`npm run lab` → `?lab=quest-waypoint-lab`

- **Target distance (ft)** — how far the goal is from the player. Drop below
  ~40' to bring it on-screen and watch the arrow disappear.
- **Target angle (°)** — orbit the goal around the player; the edge arrow tracks.

The minimap is inactive here (no floor map); waypoint map markers are covered by
the full game (`npm run dev`).
