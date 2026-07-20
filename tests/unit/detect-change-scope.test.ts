import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toBashScriptPath, bashEnv } from '../helpers/bash-script-path.js';

/**
 * Deterministic coverage for the CI change-scope classifier
 * (`scripts/agent/ci/detect-art-only.sh`). The script gates CI decisions:
 *   - art_only      → skip heavy gameplay gates on approved-art diffs
 *   - docs_only     → skip ALL heavy gates on markdown/text diffs
 *   - gameplay_safe → skip the headless Floor-1 gate on PRs whose diff
 *                     provably can't change the deterministic sim
 *   - visual_touched  → skip E2E visual regression on non-visual diffs
 *   - sim_touched     → skip headless on non-simulation diffs (complement of gameplay_safe)
 *   - coverage_touched → skip coverage job on non-coverage diffs
 *   - sprite_pipeline_touched → alias for sprites_touched
 *   - dependencies_touched → gate npm audit / dep-allowlist on dep-manifest diffs
 * A misclassification here silently drops a required gate, so we exercise the
 * real bash implementation via its SCOPE_FILES_OVERRIDE hook (no git needed).
 */

const SCRIPT = toBashScriptPath(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../scripts/agent/ci/detect-art-only.sh',
  ),
);

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

interface Scope {
  art_only: boolean;
  docs_only: boolean;
  gameplay_safe: boolean;
  sprites_only: boolean;
  sprites_touched: boolean;
  visual_touched: boolean;
  sim_touched: boolean;
  coverage_touched: boolean;
  sprite_pipeline_touched: boolean;
  dependencies_touched: boolean;
}

function run(override: string, extraEnv: Record<string, string> = {}): Scope {
  const res = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    // GITHUB_OUTPUT='' keeps the script from appending to a real CI output file.
    env: bashEnv({
      ...extraEnv,
      SCOPE_FILES_OVERRIDE: override,
      GITHUB_OUTPUT: '',
    }),
  });
  if (res.status !== 0) {
    throw new Error(
      `detect-art-only.sh exited ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
  const read = (key: keyof Scope): boolean => {
    const match = res.stdout.match(new RegExp(`^${key}=(true|false)$`, 'm'));
    if (!match) {
      throw new Error(`missing '${key}' in output:\n${res.stdout}`);
    }
    return match[1] === 'true';
  };
  return {
    art_only: read('art_only'),
    docs_only: read('docs_only'),
    gameplay_safe: read('gameplay_safe'),
    sprites_only: read('sprites_only'),
    sprites_touched: read('sprites_touched'),
    visual_touched: read('visual_touched'),
    sim_touched: read('sim_touched'),
    coverage_touched: read('coverage_touched'),
    sprite_pipeline_touched: read('sprite_pipeline_touched'),
    dependencies_touched: read('dependencies_touched'),
  };
}

const classify = (files: string[], extraEnv: Record<string, string> = {}): Scope =>
  run(files.join('\n'), extraEnv);

interface Case {
  name: string;
  files: string[];
  expected: Scope;
  env?: Record<string, string>;
}

const F = (
  art_only: boolean,
  docs_only: boolean,
  gameplay_safe: boolean,
  sprites_only: boolean,
  sprites_touched: boolean,
  visual_touched: boolean,
  sim_touched: boolean,
  coverage_touched: boolean,
  sprite_pipeline_touched: boolean,
  dependencies_touched: boolean,
): Scope => ({
  art_only,
  docs_only,
  gameplay_safe,
  sprites_only,
  sprites_touched,
  visual_touched,
  sim_touched,
  coverage_touched,
  sprite_pipeline_touched,
  dependencies_touched,
});

const cases: Case[] = [
  // Approved-art surface.
  {
    name: 'generated sprites + manifest',
    files: ['public/assets/generated/manifest.json'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(true, false, true, false, false, true, false, false, false, false),
  },
  {
    name: 'sprite catalog data',
    files: ['src/shared/data/sprite-catalog.json'],
    expected: F(true, false, true, false, false, true, false, false, false, false),
  },
  {
    name: 'package script wiring (safe split)',
    files: ['package.json'],
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'true' },
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, true, false, false, true, false, true, false, true),
  },
  {
    name: 'package core script wiring (unsafe split)',
    files: ['package.json'],
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'false' },
    expected: F(false, false, false, false, false, true, true, true, false, true),
  },
  {
    name: 'scope classifier script',
    files: ['scripts/agent/ci/detect-art-only.sh'],
    expected: F(false, false, true, false, false, false, false, false, false, false),
  },
  {
    name: 'scope classifier unit test',
    files: ['tests/unit/detect-change-scope.test.ts'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, true, false, false, false, false, true, false, false),
  },
  // Docs / text.
  {
    name: 'docs markdown',
    files: ['docs/architecture.md'],
    expected: F(false, true, true, false, false, false, false, false, false, false),
  },
  {
    name: 'docs knowledge metric json',
    files: ['docs/knowledge/metrics/apples/2026-07-08-adr-cleanup.json'],
    expected: F(false, true, true, false, false, false, false, false, false, false),
  },
  {
    name: 'spec markdown',
    files: ['.specify/specs/spawner-battle-arena.md'],
    expected: F(false, true, true, false, false, false, false, false, false, false),
  },
  {
    name: 'agents governance doc',
    files: ['AGENTS.md'],
    expected: F(false, true, true, false, false, false, false, false, false, false),
  },
  {
    name: 'root readme',
    files: ['README.md'],
    expected: F(false, true, true, false, false, false, false, false, false, false),
  },
  // Gameplay-safe surfaces the headless runner never imports.
  {
    name: 'engine-only (rendering)',
    files: ['src/engine/render/floorRenderer.ts'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, true, false, false, true, true, true, false, false),
  },
  {
    name: 'labs-only',
    files: ['src/labs/combatLab.ts'],
    expected: F(false, false, true, false, false, true, true, false, false, false),
  },
  {
    name: 'e2e tests',
    files: ['tests/e2e/hud-overlap-visual.test.ts'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, true, false, false, true, false, false, false, false),
  },
  {
    name: 'docs + engine mixed',
    files: ['docs/x.md', 'src/engine/foo.ts'],
    expected: F(false, false, true, false, false, true, true, true, false, false),
  },
  // Anything that CAN change the sim must force the gate to run.
  {
    name: 'core system',
    files: ['src/core/systems/movementSystem.ts'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, false, false, false, true, true, true, false, false),
  },
  {
    name: 'game system',
    files: ['src/game/combat.ts'],
    expected: F(false, false, false, false, false, true, true, true, false, false),
  },
  {
    name: 'shared (non-catalog)',
    files: ['src/shared/random.ts'],
    expected: F(false, false, false, false, false, true, true, true, false, false),
  },
  {
    name: 'headless test itself',
    files: ['tests/headless/floor1-completion.test.ts'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, false, false, false, false, true, false, false, false),
  },
  {
    name: 'engine + game mixed',
    files: ['src/engine/render/foo.ts', 'src/game/combat.ts'],
    expected: F(false, false, false, false, false, true, true, true, false, false),
  },
  {
    name: 'ci script change',
    files: ['scripts/agent/ci/detect-art-only.sh'],
    expected: F(false, false, true, false, false, false, false, false, false, false),
  },
  {
    name: 'workflow change',
    files: ['.github/workflows/ci.yml'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, true, false, false, false, false, false, false, false),
  },
  {
    name: 'github actions change',
    files: ['.github/actions/setup-node/action.yml'],
    expected: F(false, false, true, false, false, false, false, false, false, false),
  },
  {
    name: 'github extensions change',
    files: ['.github/extensions/copilot-guards/guard.ts'],
    expected: F(false, false, true, false, false, false, false, false, false, false),
  },
  {
    name: 'mixed workflow + engine (non-gameplay)',
    files: ['.github/workflows/ci.yml', 'src/engine/render/foo.ts'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, true, false, false, true, true, true, false, false),
  },
  {
    name: 'workflow + game code (gameplay-unsafe)',
    files: ['.github/workflows/ci.yml', 'src/game/combat.ts'],
    expected: F(false, false, false, false, false, true, true, true, false, false),
  },
  // Sprite pipeline paths: gameplay_safe=true, sprites_only=true, sprites_touched=true.
  {
    name: 'sprites pipeline script',
    files: ['scripts/sprites/run-full.ts'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, true, true, true, false, false, false, true, false),
  },
  {
    name: 'sprites pipeline unit test',
    files: ['tests/unit/sprites/run-pipeline.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, true, false),
  },
  {
    name: 'sprites integration test',
    files: ['tests/integration/sprites/rerun.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, true, false),
  },
  {
    name: 'sprites pipeline + unit test (pure sprites change)',
    files: ['scripts/sprites/batch.ts', 'tests/unit/sprites/batch.test.ts'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, true, true, true, false, false, false, true, false),
  },
  {
    name: 'sprites pipeline + game code (mixed) → sprites_only=false, sprites_touched=true',
    files: ['scripts/sprites/batch.ts', 'src/game/combat.ts'],
    expected: F(false, false, false, false, true, true, true, true, true, false),
  },
  {
    name: 'sprites pipeline + engine code → sprites_only=false, gameplay_safe=true, sprites_touched=true',
    files: ['scripts/sprites/run-full.ts', 'src/engine/renderer.ts'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, true, false, true, true, true, true, true, false),
  },
  // Root pipeline integration tests: in sprites surface, so sprites_only=true, sprites_touched=true.
  {
    name: 'root pipeline integration test (batch-cli)',
    files: ['tests/integration/batch-cli.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, true, false),
  },
  {
    name: 'root pipeline integration test (sidecar-lifecycle)',
    files: ['tests/integration/sidecar-lifecycle.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, true, false),
  },
  // Game-only change → sprites_touched=false.
  {
    name: 'game-only change → sprites_touched=false',
    files: ['src/game/combat.ts', 'src/core/systems/movementSystem.ts'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, false, false, false, true, true, true, false, false),
  },
  // New orthogonal flag tests (issue #1688 acceptance criteria).
  {
    name: 'package-lock.json → all runtime-sensitive flags + dependencies touched',
    files: ['package-lock.json'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, false, false, false, true, true, true, false, true),
  },
  {
    name: 'unit test (non-sprites) → coverage_touched=true, not visual, not sim',
    files: ['tests/unit/ai-runner-lighting-controls.test.ts'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, false, false, false, false, false, true, false, false),
  },
  {
    name: 'headless test → sim_touched=true, not visual, not coverage',
    files: ['tests/headless/floor1-completion.test.ts'],
    expected: F(false, false, false, false, false, false, true, false, false, false),
  },
  {
    name: 'CI-only scripts (agent scripts) → all touched flags false',
    files: ['scripts/agent/ci/local-scope.sh', 'scripts/agent/security/check-deps.ts'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, false, false, false, false, false, false, false, false),
  },
  {
    name: '.specify spec + engine (mixed) → visual, sim, coverage touched; not deps',
    files: ['.specify/specs/foo.md', 'src/engine/rendering/debugLayer.ts'],
    expected: F(false, false, true, false, false, true, true, true, false, false),
  },
  {
    name: 'package-lock.json + workflow → all runtime-sensitive flags + dependencies touched',
    files: ['package-lock.json', '.github/workflows/security-review.yml'],
    //             ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expected: F(false, false, false, false, false, true, true, true, false, true),
  },
  {
    name: 'src/shared (non-catalog) → sim+visual+coverage, not deps',
    files: ['src/shared/random.ts'],
    expected: F(false, false, false, false, false, true, true, true, false, false),
  },
];

describe('detect-art-only.sh change-scope classifier', () => {
  it('resolves bash (required by the verify.sh harness)', () => {
    expect(hasBash).toBe(true);
  });

  it.skipIf(!hasBash)('fail-safe: a blank/whitespace change set runs the full suite', () => {
    // A lone newline enters the override branch but strips to empty → fail-safe:
    // positive-signal flags (visual, sim, coverage, dependencies) are true so
    // gate jobs run rather than being silently skipped on unknown change sets.
    expect(run('\n')).toEqual(F(false, false, false, false, false, true, true, true, false, true));
  });

  it.skipIf(!hasBash)(
    'fail-safe: an explicitly empty override is honored as an empty change set',
    () => {
      // Presence-detected (${VAR+x}), so set-but-empty must NOT fall back to git.
      expect(run('')).toEqual(F(false, false, false, false, false, true, true, true, false, true));
    },
  );

  for (const c of cases) {
    it.skipIf(!hasBash)(`classifies ${c.name}`, () => {
      expect(classify(c.files, c.env ?? {})).toEqual(c.expected);
    });
  }
});
