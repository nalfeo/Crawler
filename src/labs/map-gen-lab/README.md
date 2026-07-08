# Map Generation Lab

Unified visual sandbox for procedural floor generation (including the former cave-system lab overlays).

## What It Tests

- All registered biome generators (dungeon, cave, cave_system, arena, forest, fire swamp, etc.)
- Floor-constraint mode (Floor 1 / Floor 2 gameplay init path) with ON/OFF toggle
- Biome + cave-system parameter tuning (present families, fill ratio, smoothing, den size, separation, retries)
- Overlay stack: room bounds, doors + unlock criteria tooltips, reachability, trash spawn areas, territories, NPCs, special mobs/rooms
- On-hover inspection tooltips and in-lab legend
- Generation performance (timing)

## How to Use

1. `npm run lab` → open `?lab=map-gen-lab`
2. Use lil-gui to set floor constraints (or disable them for freeform map-gen)
3. Adjust biome + active-biome parameters (cave-system controls appear when biome is `cave_system`)
4. Toggle overlays and hover markers/areas for tooltips
5. Click "➕ Next Seed" / "🔄 Regenerate" to explore deterministic variations
6. Watch stats panel for room count, passable %, and gen time

## Visual Legend

Legend is now shown in-lab and updates with active overlays.

## Parameters

- **Floor constraints** — call the same Floor 1 / Floor 2 scenario initializers the game uses, so constrained biome, size, spawn, NPCs, special rooms, spawners, and door locks stay in sync with gameplay
- **Generation** — biome, seed, width/height
- **Room layout** — max rooms, floor density, room width/height ranges
- **Cave system tweaks** — present families, initial fill, smoothing passes, boss-den size, region separation, max retries
- **Overlay toggles** — rooms, doors, spawn, reachability, trash areas, territories + family names, NPC positions, special mobs/rooms, legend
