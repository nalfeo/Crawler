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
          include: ['tests/{unit,ecs,game,property,determinism,sensors}/**/*.{test,spec}.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/{integration,balance}/**/*.{test,spec}.ts'],
          testTimeout: 120_000,
          passWithNoTests: true,
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
          passWithNoTests: true,
          globalSetup: ['tests/e2e/global-setup.ts'],
          // e2e specs share ONE Vite lab server and each drives its own
          // headless Chromium. Running files in parallel overloads the dev
          // server (network never goes idle, renders stall under CPU
          // contention), so force sequential file execution.
          fileParallelism: false,
        },
      },
    ],
  },
});
