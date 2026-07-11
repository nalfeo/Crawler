# Crawler

A crafting-focused vampire-survivors-like set inside a brutal intergalactic reality show dungeon.
An ancient AI showrunner (_The Director_) narrates your descent through procedurally generated floors
while alien audiences bet on your survival. Dark humor meets spectacle — Squid Game stakes,
American Gladiators showmanship, Dungeon Crawler Carl absurdity.

## Play

| Channel   | Link                                                  |
| --------- | ----------------------------------------------------- |
| Release   | [Play](https://nalfeo.github.io/Crawler/)             |
| Beta      | [Play](https://nalfeo.github.io/Crawler/beta/)        |
| Dev       | [Play](https://nalfeo.github.io/Crawler/dev/)         |
| Lab (Dev) | [Open](https://nalfeo.github.io/Crawler/dev/lab.html) |

## Architecture

**Tech stack:** TypeScript (strict) · Phaser 4 · bitecs 0.4 · Vite · Vitest · fast-check

The codebase is split into five layers with strict one-way import boundaries enforced by ESLint:

| Layer    | Path          | Role                                                                            |
| -------- | ------------- | ------------------------------------------------------------------------------- |
| `shared` | `src/shared/` | Constants, types, utilities, and data schemas shared across the codebase        |
| `core`   | `src/core/`   | Pure ECS game logic (bitecs). **No Phaser imports allowed.**                    |
| `game`   | `src/game/`   | Game-level systems: weapons, enemy AI, scenario scripts, crafting               |
| `engine` | `src/engine/` | Phaser 4 rendering bridge — scenes, sprites, HUD, VFX                           |
| `labs`   | `src/labs/`   | Dev sandboxes with unrestricted imports; every system needs one before shipping |

Legal import edges:

- `src/shared/` imports no higher layers
- `src/core/` may import `src/shared/`
- `src/game/` may import `src/core/` and `src/shared/`
- `src/engine/` may import `src/core/` and `src/shared/`
- `src/labs/` may import anything

The game loop runs as a deterministic ECS pipeline in `src/core/` and `src/game/`,
driven by Phaser 4's update tick in `src/engine/scenes/MainGameScene.ts`.
Simulation/runtime randomness uses `SeededRandom`; labs are exempt from that determinism rule.

For the full systems catalogue, ADRs, specs, and agent-OS policies see [`docs/`](docs/README.md).

## Developer docs

```bash
npm run dev            # Vite dev server
npm run lab            # Labs harness (per-system sandboxes)
npm run verify:fast    # typecheck + changed-file lint + changed unit tests (~30s)
npm run verify         # full pre-commit chain (add VERIFY_COVERAGE=1 / VERIFY_FULL=1 for coverage / headless)
```

## Logging

Crawler uses [`loglevel`](https://github.com/pimterry/loglevel) with scoped loggers.

- Default level: `info`
- Configure via env: `VITE_LOG_LEVEL` (browser) or `LOG_LEVEL` (scripts)
- Override in browser query string: `?logLevel=debug`
- Toggle at runtime in the browser console:
  - `window.crawlerLogs.setLevel('debug')`
  - `window.crawlerLogs.getLevel()`

## Sprite assets

Player + enemy sprites come from [Kenney's CC0 asset packs](https://kenney.nl/).
The committed PNGs live under `public/assets/kenney/`.

To refresh them from the upstream Kenney CDN:

```bash
bash scripts/fetch-assets.sh
```

The script is idempotent and verifies the SHA-256 of each download
before writing into the repo. See `public/assets/kenney/README.md`
for the list of vendored packs.
