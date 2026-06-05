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
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/lab-main.ts', 'src/**/index.ts'],
      thresholds: {
        'src/core/systems/meleeSwingSystem.ts': { lines: 90, branches: 80, statements: 90 },
        'src/core/systems/returningProjectileSystem.ts': {
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
