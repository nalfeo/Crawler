import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toBashScriptPath, bashEnv } from '../helpers/bash-script-path.js';

/**
 * Deterministic coverage for the CI change-scope classifier
 * (`scripts/agent/ci/detect-art-only.sh`). The script gates five CI decisions:
 *   - art_only        → skip heavy gameplay gates on approved-art diffs
 *   - docs_only       → skip ALL heavy gates on markdown/text diffs
 *   - gameplay_safe   → skip the 306s headless Floor-1 gate on PRs whose diff
 *                       provably can't change the deterministic sim
 *   - sim_touched     → run the headless Floor-1 gate on PRs (fail-closed:
 *                       unknown paths set sim_touched=true)
 *   - coverage_touched → run the advisory unit-coverage job on PRs (fail-closed:
 *                        unknown paths set coverage_touched=true)
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
  sim_touched: boolean;
  coverage_touched: boolean;
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
    sim_touched: read('sim_touched'),
    coverage_touched: read('coverage_touched'),
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
  sim_touched: boolean,
  coverage_touched: boolean,
): Scope => ({
  art_only,
  docs_only,
  gameplay_safe,
  sprites_only,
  sprites_touched,
  sim_touched,
  coverage_touched,
});

const cases: Case[] = [
  // Approved-art surface.
  {
    name: 'generated sprites + manifest',
    files: ['public/assets/generated/manifest.json'],
    expected: F(true, false, true, false, false, false, false),
  },
  {
    name: 'sprite catalog data',
    files: ['src/shared/data/sprite-catalog.json'],
    expected: F(true, false, true, false, false, false, false),
  },
  {
    name: 'package script wiring (safe split)',
    files: ['package.json'],
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'true' },
    expected: F(false, false, true, false, false, false, false),
  },
  {
    name: 'package core script wiring (unsafe split)',
    files: ['package.json'],
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'false' },
    expected: F(false, false, false, false, false, true, true),
  },
  {
    name: 'scope classifier script',
    files: ['scripts/agent/ci/detect-art-only.sh'],
    expected: F(false, false, true, false, false, false, false),
  },
  {
    name: 'scope classifier unit test',
    files: ['tests/unit/detect-change-scope.test.ts'],
    // tests/unit/* → sim_touched=false (unit tests don't affect sim runtime);
    // tests/unit/ non-sprites → coverage_touched=true (this file is in tests/unit/
    // and is not under tests/unit/sprites/, so it can affect unit coverage numbers)
    expected: F(false, false, true, false, false, false, true),
  },
  // Docs / text.
  {
    name: 'docs markdown',
    files: ['docs/architecture.md'],
    expected: F(false, true, true, false, false, false, false),
  },
  {
    name: 'docs knowledge metric json',
    files: ['docs/knowledge/metrics/apples/2026-07-08-adr-cleanup.json'],
    expected: F(false, true, true, false, false, false, false),
  },
  {
    name: 'spec markdown',
    files: ['.specify/specs/spawner-battle-arena.md'],
    expected: F(false, true, true, false, false, false, false),
  },
  {
    name: 'agents governance doc',
    files: ['AGENTS.md'],
    expected: F(false, true, true, false, false, false, false),
  },
  {
    name: 'root readme',
    files: ['README.md'],
    expected: F(false, true, true, false, false, false, false),
  },
  // gameplay_safe=true surfaces (engine/labs stay in the old gameplay_safe allowlist),
  // but sim_touched and coverage_touched follow stricter rules:
  //   - engine: headless tests import engine modules → sim_touched=true; unit tests
  //     import engine modules and vitest covers most of src/engine → coverage_touched=true.
  //   - labs: headless tests import lab scenario presets → sim_touched=true; vitest
  //     explicitly excludes src/labs/** from coverage → coverage_touched=false.
  {
    name: 'engine-only (rendering)',
    files: ['src/engine/render/floorRenderer.ts'],
    expected: F(false, false, true, false, false, true, true),
  },
  {
    name: 'labs-only',
    files: ['src/labs/combatLab.ts'],
    expected: F(false, false, true, false, false, true, false),
  },
  {
    name: 'e2e tests',
    files: ['tests/e2e/hud-overlap-visual.test.ts'],
    expected: F(false, false, true, false, false, false, false),
  },
  {
    name: 'docs + engine mixed',
    files: ['docs/x.md', 'src/engine/foo.ts'],
    expected: F(false, false, true, false, false, true, true),
  },
  // Anything that CAN change the sim must force the gate to run.
  {
    name: 'core system',
    files: ['src/core/systems/movementSystem.ts'],
    expected: F(false, false, false, false, false, true, true),
  },
  {
    name: 'game system',
    files: ['src/game/combat.ts'],
    expected: F(false, false, false, false, false, true, true),
  },
  {
    name: 'shared (non-catalog)',
    files: ['src/shared/random.ts'],
    expected: F(false, false, false, false, false, true, true),
  },
  {
    // headless test: sim_touched=true (test outcome matters); coverage_touched=false (tests/headless/*)
    name: 'headless test itself',
    files: ['tests/headless/floor1-completion.test.ts'],
    expected: F(false, false, false, false, false, true, false),
  },
  {
    name: 'engine + game mixed',
    files: ['src/engine/render/foo.ts', 'src/game/combat.ts'],
    expected: F(false, false, false, false, false, true, true),
  },
  {
    name: 'ci script change',
    files: ['scripts/agent/ci/detect-art-only.sh'],
    expected: F(false, false, true, false, false, false, false),
  },
  {
    name: 'workflow change',
    files: ['.github/workflows/ci.yml'],
    expected: F(false, false, true, false, false, false, false),
  },
  {
    name: 'github actions change',
    files: ['.github/actions/setup-node/action.yml'],
    expected: F(false, false, true, false, false, false, false),
  },
  {
    name: 'github extensions change',
    files: ['.github/extensions/copilot-guards/guard.ts'],
    expected: F(false, false, true, false, false, false, false),
  },
  {
    name: 'mixed workflow + engine (non-gameplay)',
    files: ['.github/workflows/ci.yml', 'src/engine/render/foo.ts'],
    expected: F(false, false, true, false, false, true, true),
  },
  {
    name: 'workflow + game code (gameplay-unsafe)',
    files: ['.github/workflows/ci.yml', 'src/game/combat.ts'],
    expected: F(false, false, false, false, false, true, true),
  },
  // Sprite pipeline paths: gameplay_safe=true, sprites_only=true, sprites_touched=true.
  {
    name: 'sprites pipeline script',
    files: ['scripts/sprites/run-full.ts'],
    expected: F(false, false, true, true, true, false, false),
  },
  {
    name: 'sprites pipeline unit test',
    files: ['tests/unit/sprites/run-pipeline.test.ts'],
    // tests/unit/sprites/* → coverage_touched=false (sprite tests don't cover game code)
    expected: F(false, false, true, true, true, false, false),
  },
  {
    name: 'sprites integration test',
    files: ['tests/integration/sprites/rerun.test.ts'],
    expected: F(false, false, true, true, true, false, false),
  },
  {
    name: 'sprites pipeline + unit test (pure sprites change)',
    files: ['scripts/sprites/batch.ts', 'tests/unit/sprites/batch.test.ts'],
    expected: F(false, false, true, true, true, false, false),
  },
  {
    name: 'sprites pipeline + game code (mixed) → sprites_only=false, sprites_touched=true',
    files: ['scripts/sprites/batch.ts', 'src/game/combat.ts'],
    expected: F(false, false, false, false, true, true, true),
  },
  {
    name: 'sprites pipeline + engine code → sprites_only=false, gameplay_safe=true, sprites_touched=true',
    files: ['scripts/sprites/run-full.ts', 'src/engine/renderer.ts'],
    expected: F(false, false, true, false, true, true, true),
  },
  // Root pipeline integration tests: in sprites surface, so sprites_only=true, sprites_touched=true.
  {
    name: 'root pipeline integration test (batch-cli)',
    files: ['tests/integration/batch-cli.test.ts'],
    expected: F(false, false, true, true, true, false, false),
  },
  {
    name: 'root pipeline integration test (sidecar-lifecycle)',
    files: ['tests/integration/sidecar-lifecycle.test.ts'],
    expected: F(false, false, true, true, true, false, false),
  },
  // Game-only change → sprites_touched=false.
  {
    name: 'game-only change → sprites_touched=false',
    files: ['src/game/combat.ts', 'src/core/systems/movementSystem.ts'],
    expected: F(false, false, false, false, false, true, true),
  },
  // --- New cases covering sim_touched and coverage_touched directly ---
  // CI/tooling-only changes: sim and coverage untouched.
  {
    name: 'CI-only: github workflow change',
    files: ['.github/workflows/ci.yml'],
    expected: F(false, false, true, false, false, false, false),
  },
  {
    name: 'CI-only: scripts/agent tooling change',
    files: ['scripts/agent/preflight.sh'],
    expected: F(false, false, false, false, false, false, false),
  },
  // Note: scripts/agent/ is NOT in gameplay_safe allowlist (only detect-art-only.sh explicitly is),
  // but scripts/* IS safe for sim_touched and coverage_touched.
  {
    name: 'CI-only: pure .github change',
    files: ['.github/actions/setup-node/action.yml', '.github/instructions/core.instructions.md'],
    expected: F(false, false, true, false, false, false, false),
  },
  // Dependency change: unsafe for both sim and coverage.
  {
    name: 'dependency change (package.json, deps touched)',
    files: ['package.json'],
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'false' },
    expected: F(false, false, false, false, false, true, true),
  },
  // Asset change: sim and coverage untouched.
  {
    name: 'asset-only: generated sprite sheet',
    files: ['public/assets/generated/sprites.png', 'public/assets/generated/manifest.json'],
    expected: F(true, false, true, false, false, false, false),
  },
  // Unknown/unclassified path → fail-closed: sim_touched=true, coverage_touched=true.
  {
    name: 'unknown unclassified path → fail-closed',
    files: ['some-new-build-output/bundle.js'],
    expected: F(false, false, false, false, false, true, true),
  },
  // Game unit test (non-sprites): coverage_touched=true, sim_touched=false.
  {
    name: 'game unit test (non-sprites) → coverage touched, sim not touched',
    files: ['tests/unit/some-game-logic.test.ts'],
    expected: F(false, false, false, false, false, false, true),
  },
  // Bootstrap wiring: both sim and coverage touched.
  {
    name: 'bootstrap wiring file → sim and coverage touched',
    files: ['src/bootstrap/floor-main-scene-options.ts'],
    expected: F(false, false, false, false, false, true, true),
  },
  // Headless tests: sim touched (test outcome matters), coverage NOT touched.
  {
    name: 'headless test → sim touched only',
    files: ['tests/headless/ai-stuck-wiggle.test.ts'],
    expected: F(false, false, false, false, false, true, false),
  },
  // Integration test (non-sprites): neither sim nor coverage touched.
  {
    name: 'integration test (non-sprites) → neither sim nor coverage',
    files: ['tests/integration/some-game-test.test.ts'],
    expected: F(false, false, false, false, false, false, false),
  },
  // Docs handoff + game code → sim and coverage still touched (handoff doesn't neutralise sim flag).
  {
    name: 'handoff + game code → sim and coverage touched',
    files: ['docs/knowledge/handoffs/2026-07-19-my-feature.md', 'src/game/combat.ts'],
    expected: F(false, false, false, false, false, true, true),
  },
  // Docs handoff alone → neutral (docs/* safe for both).
  {
    name: 'handoff alone → neutral companion',
    files: ['docs/knowledge/handoffs/2026-07-19-my-feature.md'],
    expected: F(false, true, true, false, false, false, false),
  },
];

describe('detect-art-only.sh change-scope classifier', () => {
  it('resolves bash (required by the verify.sh harness)', () => {
    expect(hasBash).toBe(true);
  });

  it.skipIf(!hasBash)('fail-safe: a blank/whitespace change set runs the full suite', () => {
    // A lone newline enters the override branch but strips to empty → fail-safe.
    // sim_touched=true and coverage_touched=true ensure both gates run.
    expect(run('\n')).toEqual(F(false, false, false, false, false, true, true));
  });

  it.skipIf(!hasBash)(
    'fail-safe: an explicitly empty override is honored as an empty change set',
    () => {
      // Presence-detected (${VAR+x}), so set-but-empty must NOT fall back to git.
      expect(run('')).toEqual(F(false, false, false, false, false, true, true));
    },
  );

  for (const c of cases) {
    it.skipIf(!hasBash)(`classifies ${c.name}`, () => {
      expect(classify(c.files, c.env ?? {})).toEqual(c.expected);
    });
  }
});
