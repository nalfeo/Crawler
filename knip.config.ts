/**
 * knip.config.ts — Knip dead-code detector configuration.
 *
 * `ignoreIssues` is derived from the structured KNIP_SUPPRESSIONS list in
 * `scripts/agent/health/knip-suppressions.ts`, which is the single source of
 * truth for suppressions and carries required `reason` and `expiresOn` fields.
 *
 * To add a suppression: edit KNIP_SUPPRESSIONS in
 * `scripts/agent/health/knip-suppressions.ts` — NOT this file.
 *
 * Suppressions are validated by `npm run check:knip-suppressions` (blocking in
 * CI): expired entries fail the build, and bumping `expiresOn` without updating
 * `reason` is also a build failure (reason-restatement rule).
 */

import type { KnipConfig, KnipConfiguration } from 'knip';
import { KNIP_SUPPRESSIONS } from './scripts/agent/health/knip-suppressions.js';

type KnipIgnoreIssues = NonNullable<KnipConfiguration['ignoreIssues']>;

const ignoreIssues: KnipIgnoreIssues = {};
for (const s of KNIP_SUPPRESSIONS) {
  ignoreIssues[s.file] = [...s.issues] as KnipIgnoreIssues[string];
}

export default {
  entry: [
    'src/main.ts',
    'src/lab-main.ts',
    'src/devtools-main.ts',
    'src/labs/**/index.ts',
    'src/shared/index.ts',
    'src/core/index.ts',
    'src/core/barriers/index.ts',
    'src/core/map/index.ts',
    'src/core/map/generators/index.ts',
    'src/game/index.ts',
    'src/game/systems/index.ts',
    'src/game/ai/navmesh/index.ts',
    'src/engine/index.ts',
    'src/engine/sprites/index.ts',
    'src/engine/generatedAssets/index.ts',
    'scripts/sprites/sidecar/cli.ts',
    'scripts/sprites/**/*.ts',
    'src/bootstrap/equipment-balance-harness.ts',
  ],
  project: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/sprites/**/*.ts'],
  ignore: ['node_modules/**', 'dist/**'],
  ignoreDependencies: ['playwright'],
  ignoreBinaries: ['pwsh'],
  ignoreIssues,
} satisfies KnipConfig;
