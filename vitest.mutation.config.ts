import { defineConfig } from 'vitest/config';

// Dedicated Vitest config for Stryker mutation runs.
//
// The root `vitest.config.ts` declares 9 projects. Stryker's vitest runner
// drives them together, and Vitest rejects that combination outright:
//
//   Projects "integration" and "unit" have different 'maxWorkers'
//   but same 'sequence.groupOrder'
//
// That error aborts Stryker's *initial dry run*, so no mutant is ever
// generated. Because `.github/workflows/nightly-mutation.yml` marks the
// Stryker step `continue-on-error: true`, the nightly has been failing
// silently — the committed baseline in
// `docs/knowledge/metrics/mutation-baseline.json` has not moved since
// 2026-06-14.
//
// Mutation testing should only ever run fast, deterministic unit tests
// anyway: e2e/headless projects need a browser or simulate ~10k frames, and
// running them per-mutant would be unusably slow. So this config declares a
// single flat project mirroring the root `unit` project, with no `projects`
// array for Vitest to find inconsistent.
// Stryker re-runs this suite once per mutant, so suite size is the dominant
// cost: the full unit suite is 1102 tests / ~2m20s, which makes even a
// modestly-sized mutant set take an hour. `STRYKER_TEST_INCLUDE` (a
// comma-separated glob list) narrows the suite to just the tests that cover the
// target, which is what makes a scoped in-session run viable.
const ALL_UNIT_TESTS = 'tests/{unit,ecs,game,property,determinism,sensors}/**/*.{test,spec}.ts';
const include = (process.env.STRYKER_TEST_INCLUDE ?? ALL_UNIT_TESTS)
  .split(',')
  .map((glob) => glob.trim())
  .filter((glob) => glob.length > 0);

export default defineConfig({
  cacheDir: '.vitest-cache',
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include,
    exclude: ['tests/unit/sprites/**', '**/node_modules/**'],
    maxWorkers: 4,
    vmMemoryLimit: '2GB',
    pool: 'threads',
  },
});
