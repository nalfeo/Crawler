import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.vitest-cache',
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 10_000,
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
        'src/game/enemyAISystem.ts': {
          lines: 90,
          branches: 80,
          statements: 90,
        },
        'src/game/enemySpawnerSystem.ts': {
          lines: 90,
          branches: 80,
          statements: 90,
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
          passWithNoTests: true,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.{test,spec}.ts'],
          testTimeout: 120_000,
          passWithNoTests: true,
        },
      },
    ],
  },
});
