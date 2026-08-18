import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.vitest-cache',
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // 30s (not the Vitest 5s default) gives CPU-heavy unit tests — notably the
    // sprite scoring/postprocess suites — headroom when run under v8 coverage
    // instrumentation on a loaded machine, where a normally ~1s test can spike
    // past a tight 10s limit. Integration/e2e override this to 120s below.
    testTimeout: 30_000,
    // Same rationale as testTimeout, but for setup/teardown hooks: suites that
    // boot a server in beforeEach (e.g. the sprites sidecar Fastify server) can
    // exceed the 10s default when the full unit suite runs under v8 coverage on
    // a loaded box. Match testTimeout so heavy hooks don't flake.
    hookTimeout: 30_000,
    benchmark: {
      include: ['tests/bench/**/*.bench.ts'],
      outputFile: {
        json: 'coverage/bench-results.json',
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/main.ts',
        'src/lab-main.ts',
        'src/engine/scenes/**',
        'src/engine/InventoryUI.ts',
        'src/engine/PhaserBridge.ts',
        'src/engine/CombatVfx.ts',
        'src/labs/**',
        'src/shared/combat-events.ts',
        'src/shared/equipment-types.ts',
        'src/game/skills/types.ts',
        'src/engine/index.ts',
        'src/core/index.ts',
        'src/game/index.ts',
        'src/shared/index.ts',
      ],
      thresholds: {
        // Per-file thresholds for files that have been raised to stricter bars.
        'src/game/weaponSystem.ts': { lines: 90, branches: 80, statements: 90 },
        'src/game/systems/skillSystem.ts': { lines: 90, branches: 80, statements: 90 },
        'src/core/systems/meleeSwingSystem.ts': { lines: 90, branches: 80, statements: 90 },
        'src/core/systems/returningProjectileSystem.ts': {
          lines: 90,
          branches: 80,
          statements: 90,
        },
        // Dedicated branch-coverage tests added 2026-06-24
        // (tests/game/enemy-ai-coverage.test.ts) lifted measured coverage to
        // ~93.7% lines / 77.2% branches / 100% funcs; thresholds raised to lock
        // in the gains with a small margin.
        'src/game/enemyAISystem.ts': {
          lines: 92,
          branches: 75,
          statements: 92,
        },
        'src/game/enemySpawnerSystem.ts': {
          lines: 84,
          branches: 58,
          statements: 84,
        },
        'src/core/systems/trapSystem.ts': {
          lines: 90,
          branches: 80,
          statements: 90,
        },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          sequence: { groupOrder: 1 },
          include: ['tests/{unit,ecs,game,property,determinism,sensors}/**/*.{test,spec}.ts'],
          // Sprite pipeline tests live in their own project — exclude them here
          // so game test runs stay fast and focused on game code.
          exclude: ['tests/unit/sprites/**'],
          // Explicitly cap worker count and memory to avoid CI OOM crashes on
          // high-core runners where Vitest's default per-worker memory limit
          // scales down with CPU count.
          maxWorkers: 4,
          vmMemoryLimit: '2GB',
          // Worker threads start faster than forked processes (no process spawn
          // overhead per worker). Unit tests are pure-logic with no DOM side
          // effects; with Vitest's default isolate:true each test file gets its
          // own module registry, so thread isolation is equivalent to forks for
          // this suite.
          pool: 'threads',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/{integration,balance}/**/*.{test,spec}.ts'],
          // Sprite pipeline integration tests live in their own project.
          exclude: [
            'tests/integration/sprites/**',
            'tests/integration/batch-cli.test.ts',
            'tests/integration/generate-one.test.ts',
            'tests/integration/judge-budget-cache.test.ts',
            'tests/integration/judge-pipeline.test.ts',
            'tests/integration/run-full.test.ts',
            'tests/integration/sidecar-lifecycle.test.ts',
            'tests/integration/synth-to-generate.test.ts',
            'tests/integration/weapons-pipeline.test.ts',
          ],
          testTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          // Sprite generation/editing pipeline tests — isolated from game tests
          // so that a pure sprite-pipeline change never triggers the game suite
          // and vice versa. Includes unit tests for scripts/sprites/** and the
          // integration tests that drive the full pipeline end-to-end.
          name: 'sprites',
          sequence: { groupOrder: 2 },
          include: [
            'tests/unit/sprites/**/*.{test,spec}.ts',
            'tests/integration/sprites/**/*.{test,spec}.ts',
            'tests/integration/batch-cli.test.ts',
            'tests/integration/generate-one.test.ts',
            'tests/integration/judge-budget-cache.test.ts',
            'tests/integration/judge-pipeline.test.ts',
            'tests/integration/run-full.test.ts',
            'tests/integration/sidecar-lifecycle.test.ts',
            'tests/integration/synth-to-generate.test.ts',
            'tests/integration/weapons-pipeline.test.ts',
          ],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'headless',
          include: ['tests/headless/**/*.{test,spec}.ts'],
          // A full Floor 1 clear simulates ~10k frames; give it generous
          // headroom so a slow CI runner never flakes on time alone.
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.{test,spec}.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          globalSetup: ['tests/e2e/global-setup.ts'],
          // e2e specs share ONE Vite lab server and each drives its own
          // headless Chromium. Running files in parallel overloads the dev
          // server (network never goes idle, renders stall under CPU
          // contention), so force sequential file execution.
          fileParallelism: false,
        },
      },
      // ── Surface-targeted E2E sub-projects (#1698) ────────────────────────────
      // These projects let CI route Playwright to only the affected visual surface:
      //   e2e-game     → game/engine/UI visual (all tests except devtools-specific)
      //   e2e-assets   → generated art smoke (3 tests that verify sprite rendering)
      //   e2e-devtools → devtools browser UI (sprite-workflow-sensors test)
      // The top-level `e2e` project above stays for full local runs and fallback.
      // Surface-to-test mapping is documented in scripts/agent/ci/detect-art-only.sh.
      {
        extends: true,
        test: {
          // Game/engine/UI visual suite. Runs when any game, engine, core, shared,
          // labs, or non-devtool e2e source changes (game_visual_touched=true).
          name: 'e2e-game',
          include: ['tests/e2e/**/*.{test,spec}.ts'],
          exclude: [
            // Devtools-specific test belongs to e2e-devtools, not e2e-game.
            'tests/e2e/sprite-workflow-sensors.test.ts',
          ],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          globalSetup: ['tests/e2e/global-setup.ts'],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          // Asset visual smoke suite. Runs when only generated art or sprite-catalog
          // changes (asset_visual_touched=true, e.g. art_only=true). Tests here
          // directly verify that approved generated sprites render in the real scene,
          // providing targeted visual validation without the full UI suite overhead.
          name: 'e2e-assets',
          include: [
            'tests/e2e/generated-door-overlay.test.ts',
            'tests/e2e/harvestable-node-sprite.test.ts',
            'tests/e2e/terrain-generated-tiles.test.ts',
          ],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          globalSetup: ['tests/e2e/global-setup.ts'],
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          // Devtools browser visual suite. Runs when devtools source or its e2e test
          // changes (devtool_visual_touched=true). Isolated so a pure devtools change
          // never triggers the full game visual suite.
          name: 'e2e-devtools',
          include: ['tests/e2e/sprite-workflow-sensors.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          globalSetup: ['tests/e2e/global-setup.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
});
