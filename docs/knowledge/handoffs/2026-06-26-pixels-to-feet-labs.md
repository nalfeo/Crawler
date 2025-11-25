# Session Handoff: Pixels → Feet — Lab Migration (Phase 6)

## Date

2026-06-26

## Persona(s) adopted

**Producer.** This is the final phase of the pervasive pixels→feet unit inversion
(ADR 0023). The game-code migration (`src/core`, `src/game`, `src/shared`, engine
boundary) was already committed and validated on this branch (`421db14` +
merge `5394fe0`). This phase migrates the dev-sandbox labs (`src/labs/*`) that the
unit flip left visually broken, plus a full audit of all 56 labs.

## Routing verdict

✅ right persona — cross-cutting change touching many labs across rendering,
camera, and overlay code; the Producer owns the mechanical recipe and the audit.

## Apples

Estimated: 🍎 x 5 <!-- declared at task start; see parent apple record -->
Actual: 🍎 x 5
Verdict: 🎯 Exact — recorded canonically in
`docs/knowledge/metrics/apples/2026-06-26-px-to-feet-internal-unit-inversion.json`
(5/5 exact). Labs were Phase 6 of that same 5-apple estimate from the start, so
**no separate apple file is created here** (would double-count calibration).

Hello kitties: 5/5 = 1.0 🎀 (parent task)

## Systems touched

devtools

## What Was Done

Completed the lab migration so every spatially-rendering lab works under the new
invariant: **ECS/world state is feet; pixels exist only at the render boundary
(`ftToPx`, `PIXELS_PER_FOOT = 8`).**

### Labs migrated (13 files, uncommitted → committed this session)

- **Personally migrated:** `combat-lab` (reference pattern), `weapons-lab`,
  `juice-lab` (VfxEvent/combatEvent emit coords → `pxToFt`), `ui-probe-lab`
  (player spawn centered via `pxToFt`), `ux-snapshot-lab` (`tileSizeFt` +
  all world coords ÷8, proven pixel-invariant against `HudMinimap`).
- **Background-agent migrated, verified line-by-line:** `enemy-ai-lab`,
  `gore-lab`, `spawner-lab`, `movement-lab`, `inventory-lab`, `hud-lab`,
  `level-up-lab`.
- **`ai-runner-lab` (this session's main fix):** embeds the **real** Floor 1 game
  (renders in pixel world-space via the real `MainGameScene`). Fixed:
  - `getFollowOrigin` now scales the player's feet position with `ftToPx`.
  - Path overlay: smoothed-path `moveTo/lineTo`, active-waypoint `fillCircle`,
    decision-target `strokeCircle` all wrapped in `ftToPx`; line-of-sight sample
    spacing converted to feet via `pxToFt(OVERLAY_LINE_OF_SIGHT_SAMPLE_PX)`.
  - Flow-field overlay: `tileSizePx = ftToPx(tileSize)`; tile centers, `fillRect`,
    `pushFlowArrow`, and goal `strokeCircle` all scaled to pixels.
- **`movement-lab` extra fix:** trail-resample epsilon `0.05 → 0.00625` (px→ft),
  and `npx prettier --write` to clear formatting drift left by the agent migration.

### Labs audited and confirmed correct **without** changes (no migration needed)

- **Real-scene embeds** (`MainGameScene` handles `ftToPx` internally; AI input is
  dimensionless direction logic; no custom world overlays): `floor1-lab`,
  `parallel-bt-lab`, `bt-viz-lab`.
- **Self-consistent custom-canvas sandboxes** (own 2D canvas, local constants,
  `tileSizeFt` set to the local cell-pixel value → render 1:1, isolated from real
  systems): `pathfinding-lab`, `safe-room-lab`, `door-lock-lab`, `npc-lab`,
  `tile-render-lab`, `map-gen-lab`.
- **Display/data-only**: `drop-lab` (position only in debug text — now shows feet,
  which is correct), plus all origin-spawn stat/quest/skill labs
  (`spawnPlayer(world, 0, 0)`): `quest-lab`, `quest-content-lab`, `skill-lab`,
  `stats-lab`, `weapon-skill-lab`, `mana-lab`, `spell-system-lab`.

### Audit method

Grepped all 56 labs for: `createPhaserBridge` / `MainGameScene` / `createFloor1`
(real-render embeds), `stores.position` reads (custom overlays), `getFollowOrigin`
users, `units.ts` importers, shared spatial-constant imports (`PLAYER_SPEED`,
`ARENA`), and dimension-based spawns. Verified GUI slider ranges were ÷8 (e.g.
`aggroRange 6.25–50`, `playerSpeed 0.125–1.875` bracketing the 0.375 default,
weapons labelled "Knockback (ft)").

## What's Next

1. Merge this PR (squash). No human review required per merge policy.
2. Labs have **no automated visual gate** (`verify` does not run Playwright E2E);
   final visual confirmation is open-in-browser if any lab looks off. The
   `ux-snapshot-lab` invariance is additionally backed by
   `tests/e2e/minimap-overlay.test.ts`.

## Blockers

None.

## Branch State

- Branch: `nalfeo-remove-pixels-use-feet`
- `npm run verify` (full): **passed** — typecheck, lint, format, dead-code,
  unit+coverage, integration, **headless 68/68**, build (276 modules).
- `scripts/agent/lab-gate-check.sh`: **passed** (every system has a lab).
- PR created: yes (this session).

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — no telemetry section.

## Test Results

`npm run verify` → all 8 steps green; headless **68 passed (68)**; production build
succeeded. `verify:fast` runs unit tests with `--changed`; since all edits are in
`src/labs/*` (no unit tests), it correctly reports no related tests while still
type-checking and linting the full tree.

## Key Decisions Made

- **Self-consistent canvas labs stay in their local pixel space.** Labs that render
  their own 2D canvas with local cell constants and set `tileSizeFt` to that local
  value are internally consistent and isolated from real game systems — analogous to
  the recipe's "custom tile renderers stay px" exemption. Migrating them would add
  churn with zero behavioural change.
- **`ai-runner-lab` was genuinely broken** (a prior summary wrongly claimed it was
  migrated). It embeds the real pixel-space game, so its feet-domain overlays and
  follow-origin required `ftToPx`; this was the one substantive miss found in audit.
- **No duplicate apple file.** Labs were inside the parent 5-apple estimate; the
  canonical record already exists and stays at 5/5 exact.
