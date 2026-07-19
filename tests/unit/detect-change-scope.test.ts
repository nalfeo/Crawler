import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toBashScriptPath, bashEnv } from '../helpers/bash-script-path.js';

/**
 * Deterministic coverage for the CI change-scope classifier
 * (`scripts/agent/ci/detect-art-only.sh`). The script gates three CI decisions:
 *   - art_only      → skip heavy gameplay gates on approved-art diffs
 *   - docs_only     → skip ALL heavy gates on markdown/text diffs
 *   - gameplay_safe → skip the 306s headless Floor-1 gate on PRs whose diff
 *                     provably can't change the deterministic sim
 * And four visual-routing outputs added in #1688/#1698:
 *   - visual_touched       → any visual rendering surface was changed
 *   - game_visual_touched  → game/engine/UI visual surface (e2e-game suite)
 *   - asset_visual_touched → generated art / sprite catalog (e2e-assets suite)
 *   - devtool_visual_touched → devtools browser UI (e2e-devtools suite)
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
  game_visual_touched: boolean;
  asset_visual_touched: boolean;
  devtool_visual_touched: boolean;
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
    game_visual_touched: read('game_visual_touched'),
    asset_visual_touched: read('asset_visual_touched'),
    devtool_visual_touched: read('devtool_visual_touched'),
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

/**
 * Build a Scope expectation.
 * Positional args (original 5): art_only, docs_only, gameplay_safe, sprites_only, sprites_touched
 * Visual args (new 4):          visual_touched, game_visual_touched, asset_visual_touched, devtool_visual_touched
 */
const F = (
  art_only: boolean,
  docs_only: boolean,
  gameplay_safe: boolean,
  sprites_only: boolean,
  sprites_touched: boolean,
  visual_touched: boolean,
  game_visual_touched: boolean,
  asset_visual_touched: boolean,
  devtool_visual_touched: boolean,
): Scope => ({
  art_only,
  docs_only,
  gameplay_safe,
  sprites_only,
  sprites_touched,
  visual_touched,
  game_visual_touched,
  asset_visual_touched,
  devtool_visual_touched,
});

const cases: Case[] = [
  // Approved-art surface: visual but only asset-visual (no game/devtool).
  {
    name: 'generated sprites + manifest',
    files: ['public/assets/generated/manifest.json'],
    //                          art   docs  gsafe sponly sptch  vis   game  asset devt
    expected: F(true, false, true, false, false, true, false, true, false),
  },
  {
    name: 'sprite catalog data',
    files: ['src/shared/data/sprite-catalog.json'],
    expected: F(true, false, true, false, false, true, false, true, false),
  },
  {
    name: 'package script wiring (safe split)',
    files: ['package.json'],
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'true' },
    //                          art   docs  gsafe sponly sptch  vis   game  asset devt
    expected: F(false, false, true, false, false, true, true, true, true),
  },
  {
    name: 'package core script wiring (unsafe split)',
    files: ['package.json'],
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'false' },
    expected: F(false, false, false, false, false, true, true, true, true),
  },
  // CI/tooling-only: non-visual.
  {
    name: 'scope classifier script',
    files: ['scripts/agent/ci/detect-art-only.sh'],
    expected: F(false, false, true, false, false, false, false, false, false),
  },
  {
    name: 'scope classifier unit test',
    files: ['tests/unit/detect-change-scope.test.ts'],
    expected: F(false, false, true, false, false, false, false, false, false),
  },
  // Docs / text: non-visual.
  {
    name: 'docs markdown',
    files: ['docs/architecture.md'],
    expected: F(false, true, true, false, false, false, false, false, false),
  },
  {
    name: 'docs knowledge metric json',
    files: ['docs/knowledge/metrics/apples/2026-07-08-adr-cleanup.json'],
    expected: F(false, true, true, false, false, false, false, false, false),
  },
  {
    name: 'spec markdown',
    files: ['.specify/specs/spawner-battle-arena.md'],
    expected: F(false, true, true, false, false, false, false, false, false),
  },
  {
    name: 'agents governance doc',
    files: ['AGENTS.md'],
    expected: F(false, true, true, false, false, false, false, false, false),
  },
  {
    name: 'root readme',
    files: ['README.md'],
    expected: F(false, true, true, false, false, false, false, false, false),
  },
  // Gameplay-safe surfaces: visual (game_visual) but not headless-unsafe.
  {
    name: 'engine-only (rendering)',
    files: ['src/engine/render/floorRenderer.ts'],
    expected: F(false, false, true, false, false, true, true, false, false),
  },
  {
    name: 'labs-only',
    files: ['src/labs/combatLab.ts'],
    expected: F(false, false, true, false, false, true, true, false, false),
  },
  {
    name: 'e2e tests (non-devtool)',
    files: ['tests/e2e/hud-overlap-visual.test.ts'],
    expected: F(false, false, true, false, false, true, true, false, false),
  },
  {
    name: 'docs + engine mixed',
    files: ['docs/x.md', 'src/engine/foo.ts'],
    expected: F(false, false, true, false, false, true, true, false, false),
  },
  // Anything that CAN change the sim must force the headless gate to run.
  // These also set game_visual_touched (src/* → visual, game).
  {
    name: 'core system',
    files: ['src/core/systems/movementSystem.ts'],
    expected: F(false, false, false, false, false, true, true, false, false),
  },
  {
    name: 'game system',
    files: ['src/game/combat.ts'],
    expected: F(false, false, false, false, false, true, true, false, false),
  },
  {
    name: 'shared (non-catalog)',
    files: ['src/shared/random.ts'],
    expected: F(false, false, false, false, false, true, true, false, false),
  },
  {
    name: 'headless test itself',
    files: ['tests/headless/floor1-completion.test.ts'],
    expected: F(false, false, false, false, false, false, false, false, false),
  },
  {
    name: 'engine + game mixed',
    files: ['src/engine/render/foo.ts', 'src/game/combat.ts'],
    expected: F(false, false, false, false, false, true, true, false, false),
  },
  // CI/tooling-only: non-visual.
  {
    name: 'ci script change',
    files: ['scripts/agent/ci/detect-art-only.sh'],
    expected: F(false, false, true, false, false, false, false, false, false),
  },
  {
    name: 'workflow change',
    files: ['.github/workflows/ci.yml'],
    expected: F(false, false, true, false, false, false, false, false, false),
  },
  {
    name: 'github actions change',
    files: ['.github/actions/setup-node/action.yml'],
    expected: F(false, false, true, false, false, false, false, false, false),
  },
  {
    name: 'github extensions change',
    files: ['.github/extensions/copilot-guards/guard.ts'],
    expected: F(false, false, true, false, false, false, false, false, false),
  },
  {
    name: 'mixed workflow + engine (non-gameplay)',
    files: ['.github/workflows/ci.yml', 'src/engine/render/foo.ts'],
    expected: F(false, false, true, false, false, true, true, false, false),
  },
  {
    name: 'workflow + game code (gameplay-unsafe)',
    files: ['.github/workflows/ci.yml', 'src/game/combat.ts'],
    expected: F(false, false, false, false, false, true, true, false, false),
  },
  // Sprite pipeline paths: gameplay_safe=true, sprites_only=true, sprites_touched=true.
  // These are non-visual (pipeline scripts, not the rendered output).
  {
    name: 'sprites pipeline script',
    files: ['scripts/sprites/run-full.ts'],
    expected: F(false, false, true, true, true, false, false, false, false),
  },
  {
    name: 'sprites pipeline unit test',
    files: ['tests/unit/sprites/run-pipeline.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, false),
  },
  {
    name: 'sprites integration test',
    files: ['tests/integration/sprites/rerun.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, false),
  },
  {
    name: 'sprites pipeline + unit test (pure sprites change)',
    files: ['scripts/sprites/batch.ts', 'tests/unit/sprites/batch.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, false),
  },
  {
    name: 'sprites pipeline + game code (mixed) → sprites_only=false, sprites_touched=true',
    files: ['scripts/sprites/batch.ts', 'src/game/combat.ts'],
    expected: F(false, false, false, false, true, true, true, false, false),
  },
  {
    name: 'sprites pipeline + engine code → sprites_only=false, gameplay_safe=true, sprites_touched=true',
    files: ['scripts/sprites/run-full.ts', 'src/engine/renderer.ts'],
    expected: F(false, false, true, false, true, true, true, false, false),
  },
  // Root pipeline integration tests: in sprites surface, so sprites_only=true, sprites_touched=true.
  {
    name: 'root pipeline integration test (batch-cli)',
    files: ['tests/integration/batch-cli.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, false),
  },
  {
    name: 'root pipeline integration test (sidecar-lifecycle)',
    files: ['tests/integration/sidecar-lifecycle.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, false),
  },
  // Game-only change → sprites_touched=false, game_visual_touched=true.
  {
    name: 'game-only change → sprites_touched=false',
    files: ['src/game/combat.ts', 'src/core/systems/movementSystem.ts'],
    expected: F(false, false, false, false, false, true, true, false, false),
  },
  // ── New: visual surface routing cases (#1698) ──────────────────────────────
  // Devtools-only: devtool_visual_touched, NOT game_visual_touched.
  {
    name: 'devtools source change',
    files: ['src/devtools/sprite-workflow-queue.ts'],
    expected: F(false, false, true, false, false, true, false, false, true),
  },
  {
    name: 'devtools e2e test change',
    files: ['tests/e2e/sprite-workflow-sensors.test.ts'],
    expected: F(false, false, true, false, false, true, false, false, true),
  },
  // Mixed devtools + game → both surfaces touched.
  {
    name: 'devtools + engine mixed',
    files: ['src/devtools/index.ts', 'src/engine/render/foo.ts'],
    expected: F(false, false, true, false, false, true, true, false, true),
  },
  // Non-visual: CI, docs, scripts, non-e2e tests.
  {
    name: 'ci-only change → visual_touched=false',
    files: ['.github/workflows/ci.yml', 'scripts/agent/ci/detect-art-only.sh'],
    expected: F(false, false, true, false, false, false, false, false, false),
  },
  {
    name: 'unit tests only → visual_touched=false',
    files: ['tests/unit/movementSystem.test.ts', 'tests/headless/floor1.test.ts'],
    expected: F(false, false, false, false, false, false, false, false, false),
  },
  // Mixed art + devtools → both asset and devtool visual.
  {
    name: 'art + devtools (mixed) → asset and devtool visual both touched',
    files: ['public/assets/generated/manifest.json', 'src/devtools/sprite-workflow-queue.ts'],
    expected: F(false, false, true, false, false, true, false, true, true),
  },
  // DevTools entrypoints: devtools.html and src/devtools-main.ts must route
  // to devtool_visual only, NOT game_visual.
  {
    name: 'devtools.html change → devtool_visual only',
    files: ['devtools.html'],
    expected: F(false, false, true, false, false, true, false, false, true),
  },
  {
    name: 'src/devtools-main.ts change → devtool_visual only',
    files: ['src/devtools-main.ts'],
    expected: F(false, false, true, false, false, true, false, false, true),
  },
  // Shared E2E infrastructure (global-setup, e2e-constants, helpers/**) is consumed
  // by all three projects → must enable ALL three visual surfaces.
  // Note: tests/e2e/* is gameplay_safe (no src/ change), so gameplay_safe=true here.
  {
    name: 'e2e global-setup change → all three visual surfaces',
    files: ['tests/e2e/global-setup.ts'],
    expected: F(false, false, true, false, false, true, true, true, true),
  },
  {
    name: 'e2e-constants change → all three visual surfaces',
    files: ['tests/e2e/e2e-constants.ts'],
    expected: F(false, false, true, false, false, true, true, true, true),
  },
  {
    name: 'e2e helpers/ui-probe change → all three visual surfaces',
    files: ['tests/e2e/helpers/ui-probe.ts'],
    expected: F(false, false, true, false, false, true, true, true, true),
  },
  // Unknown path: must enable ALL three visual surfaces (fail toward broader validation).
  {
    name: 'unknown path (vitest.config.ts) → all three visual surfaces',
    files: ['vitest.config.ts'],
    expected: F(false, false, false, false, false, true, true, true, true),
  },
  {
    name: 'unknown path (root script) → all three visual surfaces',
    files: ['some-unknown-file.ts'],
    expected: F(false, false, false, false, false, true, true, true, true),
  },
];

describe('detect-art-only.sh change-scope classifier', () => {
  it('resolves bash (required by the verify.sh harness)', () => {
    expect(hasBash).toBe(true);
  });

  it.skipIf(!hasBash)(
    'fail-safe: an empty/whitespace change set enables all visual suites (unknown diff → run everything)',
    () => {
      // A lone newline enters the override branch but strips to empty.
      // Empty/unknown changeset → we cannot safely skip visual suites, so all
      // three surface flags must be true (same fail-safe as the no-base-ref path).
      expect(run('\n')).toEqual(F(false, false, false, false, false, true, true, true, true));
    },
  );

  it.skipIf(!hasBash)('fail-safe: an explicitly empty override enables all visual suites', () => {
    // Presence-detected (${VAR+x}), so set-but-empty must NOT fall back to git.
    expect(run('')).toEqual(F(false, false, false, false, false, true, true, true, true));
  });

  for (const c of cases) {
    it.skipIf(!hasBash)(`classifies ${c.name}`, () => {
      expect(classify(c.files, c.env ?? {})).toEqual(c.expected);
    });
  }
});
