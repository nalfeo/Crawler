# Session Handoff: Projectile Cleanup Lab

## Date

2026-06-04

## What Was Done

- Replaced the `src/labs/projectilecleanup-lab/index.ts` scaffold with a real canvas-based visualization.
- Added a scaled view of the game area and cull boundary, centered projectile spawning, click-to-fire, seeded auto-fire, cull flash effects, and an active/culled counter.
- Added lil-gui controls for projectile speed, auto-fire toggle/rate, cull margin, bounds visibility, and clearing all projectiles.
- Kept the lab standalone from `src/core/` and hardcoded the requested 1024x768 gameplay dimensions.

## What's Next

- Optionally preview the lab in `npm run lab` and tune visuals/interactions if UX feedback comes in.

## Blockers

- `bash scripts/agent/preflight.sh` and `npm run verify:fast` did not work reliably through the default Windows `bash.exe` path in this environment, so validation was run directly with `npx.cmd`/`npm.cmd` commands instead.

## Branch State

- Branch: `nalfeo-microsoft/lab-index-grouped-categories`
- All tests passing: yes
- PR created: no

## Test Results

- `npx.cmd tsc --noEmit` ✅
- `npx.cmd eslint src/ tests/ --max-warnings 0` ✅
- `npx.cmd vitest run --project unit --reporter=dot --maxWorkers 1` ✅ (38 files, 290 tests)
- `npm.cmd exec -- vite build` ✅

## Key Decisions Made

- Used `SeededRandom` for deterministic auto-fire directions instead of `Math.random()`.
- Scaled the full cull envelope into a fixed 640x480 logical canvas so both the white gameplay bounds and red dashed cull bounds remain visible as `cullMargin` changes.
- Treated projectile speed as pixels-per-frame and converted RAF delta time into 60 FPS frame units to match the requested control semantics.
