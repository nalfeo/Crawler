import { defineConfig } from 'vitest/config';

export default defineConfig({
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
        // global defaults (new files must meet this bar)
        lines: 90,
        branches: 80,
        statements: 90,
        // per-file overrides (files that have been raised to the bar)
        'src/game/weaponSystem.ts': { lines: 90, branches: 80, statements: 90 },
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
