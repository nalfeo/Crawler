# Map Generation Lab

Visual sandbox for the procedural floor generation system.

## What It Tests

- All registered biome generators (dungeon, cave, arena, forest, fire swamp, etc.)
- MapConfig parameter impact on generation output
- Room placement, door positions, and corridor connectivity
- Player spawn calculation
- Generation performance (timing)

## How to Use

1. `npm run lab` → open `?lab=map-gen-lab`
2. Use lil-gui to adjust biome type, seed, dimensions, and room params
3. Toggle room overlays, door markers, and spawn indicator
4. Click "🎲 Random Seed" to explore variations
5. Watch stats panel for room count, passable %, and gen time

## Visual Legend

| Color           | Meaning                |
| --------------- | ---------------------- |
| Dark grey       | Stone wall             |
| Medium grey     | Stone floor            |
| Dark blue       | Corridor               |
| Orange dot      | Door                   |
| Colored overlay | Room bounds (numbered) |
| Green dot       | Player spawn           |
| Purple          | Cave floor/wall        |
| Dark green      | Grass/forest           |
| Red             | Lava                   |
| Blue            | Water                  |

## Parameters

- **Biome** — selects generator algorithm
- **Seed** — deterministic RNG seed
- **Width/Height** — map dimensions in tiles (lab uses smaller sizes for fast iteration)
- **Max Rooms** — cap on room count (room-based generators)
- **Floor Density** — target passable percentage
- **Room W/H Min/Max** — room size constraints
