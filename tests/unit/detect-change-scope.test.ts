import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toBashScriptPath, bashEnv } from '../helpers/bash-script-path.js';

/**
 * Deterministic coverage for the CI change-scope classifier
 * (`scripts/agent/ci/detect-art-only.sh`). The script gates seven CI decisions:
 *   - art_only        → skip heavy gameplay gates on approved-art diffs
 *   - docs_only       → skip ALL heavy gates on markdown/text diffs
 *   - gameplay_safe   → skip the 306s headless Floor-1 gate on PRs whose diff
 *                       provably can't change the deterministic sim
 *   - sim_touched     → run the headless Floor-1 gate on PRs (fail-closed:
 *                       unknown paths set sim_touched=true)
 *   - coverage_touched → run the advisory unit-coverage job on PRs (fail-closed:
 *                        unknown paths set coverage_touched=true)
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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

interface Scope {
  art_only: boolean;
  docs_only: boolean;
  gameplay_safe: boolean;
  sprites_only: boolean;
  sprites_touched: boolean;
  sim_touched: boolean;
  coverage_touched: boolean;
  visual_touched: boolean;
  game_visual_touched: boolean;
  asset_visual_touched: boolean;
  devtool_visual_touched: boolean;
  dependencies_touched: boolean;
  ai_code_touched: boolean;
  codeowners_touched: boolean;
  source_code_touched: boolean;
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
    visual_touched: read('visual_touched'),
    game_visual_touched: read('game_visual_touched'),
    asset_visual_touched: read('asset_visual_touched'),
    devtool_visual_touched: read('devtool_visual_touched'),
    dependencies_touched: read('dependencies_touched'),
    ai_code_touched: read('ai_code_touched'),
    codeowners_touched: read('codeowners_touched'),
    source_code_touched: read('source_code_touched'),
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
  sim_touched: boolean,
  coverage_touched: boolean,
  visual_touched: boolean = false,
  game_visual_touched: boolean = false,
  asset_visual_touched: boolean = false,
  devtool_visual_touched: boolean = false,
  dependencies_touched: boolean = false,
  ai_code_touched: boolean = false,
  codeowners_touched: boolean = false,
  source_code_touched: boolean = false,
): Scope => ({
  art_only,
  docs_only,
  gameplay_safe,
  sprites_only,
  sprites_touched,
  sim_touched,
  coverage_touched,
  visual_touched,
  game_visual_touched,
  asset_visual_touched,
  devtool_visual_touched,
  dependencies_touched,
  ai_code_touched,
  codeowners_touched,
  source_code_touched,
});

const cases: Case[] = [
  // Approved-art surface: visual but only asset-visual (no game/devtool).
  {
    name: 'generated sprites + manifest',
    files: ['public/assets/generated/manifest.json'],
    //                          art   docs  gsafe sponly sptch  vis   game  asset devt
    expected: F(true, false, true, false, false, false, false, true, false, true, false),
  },
  {
    // The manifest source of truth is now per-asset shards under entries/. A
    // pure art check-in touches its PNG + its own shard — both must classify as
    // art-only / asset-visual so parallel art PRs stay conflict-free and skip
    // heavy gameplay gates.
    name: 'generated manifest shard (per-asset)',
    files: ['public/assets/generated/entries/equipment/weapon/bone-saw.json'],
    //                          art   docs  gsafe sponly sptch  vis   game  asset devt
    expected: F(true, false, true, false, false, false, false, true, false, true, false),
  },
  {
    name: 'sprite catalog data',
    files: ['src/shared/data/sprite-catalog.json'],
    expected: F(true, false, true, false, false, false, false, true, false, true, false),
  },
  {
    name: 'package script wiring (safe split)',
    files: ['package.json'],
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'true' },
    //                          art   docs  gsafe sponly sptch  vis   game  asset devt  deps
    expected: F(false, false, true, false, false, false, false, true, true, true, true, true),
  },
  {
    name: 'package core script wiring (unsafe split)',
    files: ['package.json'],
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'false' },
    expected: F(false, false, false, false, false, true, true, true, true, true, true, true),
  },
  // CI/tooling-only: non-visual.
  {
    name: 'scope classifier script',
    files: ['scripts/agent/ci/detect-art-only.sh'],
    expected: F(
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ),
  },
  {
    name: 'scope classifier unit test',
    files: ['tests/unit/detect-change-scope.test.ts'],
    expected: F(false, false, true, false, false, false, true, false, false, false, false),
  },
  // Docs / text: non-visual.
  {
    name: 'docs markdown',
    files: ['docs/architecture.md'],
    expected: F(true, true, true, false, false, false, false, false, false, false, false),
  },
  {
    name: 'docs knowledge metric json',
    files: ['docs/knowledge/metrics/apples/2026-07-08-adr-cleanup.json'],
    expected: F(true, true, true, false, false, false, false, false, false, false, false),
  },
  {
    name: 'spec markdown',
    files: ['.specify/specs/spawner-battle-arena.md'],
    expected: F(false, true, true, false, false, false, false, false, false, false, false),
  },
  {
    name: 'agents governance doc',
    files: ['AGENTS.md'],
    expected: F(false, true, true, false, false, false, false, false, false, false, false),
  },
  {
    name: 'root readme',
    files: ['README.md'],
    expected: F(false, true, true, false, false, false, false, false, false, false, false),
  },
  // Gameplay-safe surfaces: visual (game_visual) but not headless-unsafe.
  {
    name: 'engine-only (rendering)',
    files: ['src/engine/render/floorRenderer.ts'],
    expected: F(
      false,
      false,
      true,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  {
    name: 'labs-only',
    files: ['src/labs/combatLab.ts'],
    expected: F(false, false, true, false, false, true, false, true, true, false, false),
  },
  {
    name: 'e2e tests (non-devtool)',
    files: ['tests/e2e/hud-overlap-visual.test.ts'],
    // tests/e2e/* → sim=false (excluded), cov=false (excluded), game_visual=true
    expected: F(false, false, true, false, false, false, false, true, true, false, false),
  },
  {
    name: 'docs + engine mixed',
    files: ['docs/x.md', 'src/engine/foo.ts'],
    expected: F(
      false,
      false,
      true,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  // Anything that CAN change the sim must force the headless gate to run.
  // These also set game_visual_touched (src/* → visual, game).
  {
    name: 'core system',
    files: ['src/core/systems/movementSystem.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  {
    name: 'game system',
    files: ['src/game/combat.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  {
    name: 'shared (non-catalog)',
    files: ['src/shared/random.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  {
    name: 'headless test itself',
    files: ['tests/headless/floor1-completion.test.ts'],
    expected: F(false, false, false, false, false, true, false, false, false, false, false),
  },
  {
    name: 'engine + game mixed',
    files: ['src/engine/render/foo.ts', 'src/game/combat.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  // CI/tooling-only: non-visual.
  {
    name: 'ci script change',
    files: ['scripts/agent/ci/detect-art-only.sh'],
    expected: F(
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ),
  },
  {
    name: 'workflow change',
    files: ['.github/workflows/ci.yml'],
    // ci.yml hosts the dependency-verification wiring → dependencies_touched=true
    expected: F(
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      true,
    ),
  },
  {
    name: 'github actions change',
    files: ['.github/actions/setup-node/action.yml'],
    // the shared dependency setup action → dependencies_touched=true
    expected: F(false, false, true, false, false, false, false, false, false, false, false, true),
  },
  {
    name: 'github extensions change',
    files: ['.github/extensions/copilot-guards/guard.ts'],
    expected: F(false, false, true, false, false, false, false, false, false, false, false),
  },
  {
    name: 'mixed workflow + engine (non-gameplay)',
    files: ['.github/workflows/ci.yml', 'src/engine/render/foo.ts'],
    expected: F(
      false,
      false,
      true,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      true,
      false,
      true,
      true,
    ),
  },
  {
    name: 'workflow + game code (gameplay-unsafe)',
    files: ['.github/workflows/ci.yml', 'src/game/combat.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      true,
      false,
      true,
      true,
    ),
  },
  // Sprite pipeline paths: gameplay_safe=true, sprites_only=true, sprites_touched=true.
  // These are non-visual (pipeline scripts, not the rendered output).
  {
    name: 'sprites pipeline script',
    files: ['scripts/sprites/run-full.ts'],
    expected: F(false, false, true, true, true, false, false, false, false, false, false),
  },
  {
    name: 'sprites pipeline unit test',
    files: ['tests/unit/sprites/run-pipeline.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, false, false, false),
  },
  {
    name: 'sprites integration test',
    files: ['tests/integration/sprites/rerun.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, false, false, false),
  },
  {
    name: 'sprites pipeline + unit test (pure sprites change)',
    files: ['scripts/sprites/batch.ts', 'tests/unit/sprites/batch.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, false, false, false),
  },
  {
    name: 'sprites pipeline + game code (mixed) → sprites_only=false, sprites_touched=true',
    files: ['scripts/sprites/batch.ts', 'src/game/combat.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  {
    name: 'sprites pipeline + engine code → sprites_only=false, gameplay_safe=true, sprites_touched=true',
    files: ['scripts/sprites/run-full.ts', 'src/engine/renderer.ts'],
    expected: F(
      false,
      false,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  // Root pipeline integration tests: in sprites surface, so sprites_only=true, sprites_touched=true.
  {
    name: 'root pipeline integration test (batch-cli)',
    files: ['tests/integration/batch-cli.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, false, false, false),
  },
  {
    name: 'root pipeline integration test (sidecar-lifecycle)',
    files: ['tests/integration/sidecar-lifecycle.test.ts'],
    expected: F(false, false, true, true, true, false, false, false, false, false, false),
  },
  // Game-only change → sprites_touched=false, game_visual_touched=true.
  {
    name: 'game-only change → sprites_touched=false',
    files: ['src/game/combat.ts', 'src/core/systems/movementSystem.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  // ── New: visual surface routing cases (#1698) ──────────────────────────────
  // Devtools-only: devtool_visual_touched, NOT game_visual_touched.
  {
    name: 'devtools source change',
    files: ['src/devtools/sprite-workflow-queue.ts'],
    expected: F(false, false, true, false, false, true, true, true, false, false, true),
  },
  {
    name: 'devtools e2e test change',
    files: ['tests/e2e/sprite-workflow-sensors.test.ts'],
    // tests/e2e/* → sim=false, cov=false; devtool_visual=true (sprite-workflow-sensors specific)
    expected: F(false, false, true, false, false, false, false, true, false, false, true),
  },
  // Mixed devtools + game → both surfaces touched.
  {
    name: 'devtools + engine mixed',
    files: ['src/devtools/index.ts', 'src/engine/render/foo.ts'],
    expected: F(
      false,
      false,
      true,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      true,
      false,
      false,
      false,
      true,
    ),
  },
  // Non-visual: CI, docs, scripts, non-e2e tests.
  {
    name: 'ci-only change → visual_touched=false',
    files: ['.github/workflows/ci.yml', 'scripts/agent/ci/detect-art-only.sh'],
    // .github/*, scripts/agent/* → sim=false, cov=false, visual=false; detect-art-only.sh → security_infra
    expected: F(
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ),
  },
  {
    name: 'unit tests only → visual_touched=false',
    files: ['tests/unit/movementSystem.test.ts', 'tests/headless/floor1.test.ts'],
    expected: F(false, false, false, false, false, true, true, false, false, false, false),
  },
  // Mixed art + devtools → both asset and devtool visual.
  {
    name: 'art + devtools (mixed) → asset and devtool visual both touched',
    files: ['public/assets/generated/manifest.json', 'src/devtools/sprite-workflow-queue.ts'],
    expected: F(false, false, true, false, false, true, true, true, false, true, true),
  },
  // DevTools entrypoints: devtools.html and src/devtools-main.ts must route
  // to devtool_visual only, NOT game_visual.
  {
    name: 'devtools.html change → devtool_visual only',
    files: ['devtools.html'],
    expected: F(false, false, true, false, false, true, true, true, false, false, true),
  },
  {
    name: 'src/devtools-main.ts change → devtool_visual only',
    files: ['src/devtools-main.ts'],
    expected: F(false, false, true, false, false, true, true, true, false, false, true),
  },
  // Shared E2E infrastructure (global-setup, e2e-constants, helpers/**) is consumed
  // by all three projects → must enable ALL three visual surfaces.
  // Note: tests/e2e/* is gameplay_safe (no src/ change), so gameplay_safe=true here.
  {
    name: 'e2e global-setup change → all three visual surfaces',
    files: ['tests/e2e/global-setup.ts'],
    // tests/e2e/* → sim=false, cov=false; shared e2e infra → all visual surfaces
    expected: F(false, false, true, false, false, false, false, true, true, true, true),
  },
  {
    name: 'e2e-constants change → all three visual surfaces',
    files: ['tests/e2e/e2e-constants.ts'],
    // tests/e2e/* → sim=false, cov=false; shared e2e infra → all visual surfaces
    expected: F(false, false, true, false, false, false, false, true, true, true, true),
  },
  {
    name: 'e2e helpers/ui-probe change → all three visual surfaces',
    files: ['tests/e2e/helpers/ui-probe.ts'],
    // tests/e2e/* → sim=false, cov=false; shared e2e infra → all visual surfaces
    expected: F(false, false, true, false, false, false, false, true, true, true, true),
  },
  // Unknown path: must enable ALL three visual surfaces (fail toward broader validation).
  {
    name: 'unknown path (vitest.config.ts) → all three visual surfaces',
    files: ['vitest.config.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      true,
    ),
  },
  {
    name: 'unknown path (root script) → all three visual surfaces',
    files: ['some-unknown-file.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      true,
    ),
  },
  // ── New: sim_touched / coverage_touched cases ──────────────────────────────
  // CI/tooling-only changes: sim and coverage untouched.
  {
    name: 'CI-only: github workflow change',
    files: ['.github/workflows/ci.yml'],
    // .github/workflows/* → codeowners_touched=true; ci.yml also carries the
    // dependency-verification wiring → dependencies_touched=true
    expected: F(
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      true,
    ),
  },
  {
    name: 'CI-only: scripts/agent tooling change',
    files: ['scripts/agent/preflight.sh'],
    expected: F(false, false, false, false, false, false, false, false, false, false, false),
  },
  // Note: scripts/agent/ is NOT in gameplay_safe allowlist (only detect-art-only.sh explicitly is),
  // but scripts/* IS safe for sim_touched and coverage_touched.
  {
    name: 'CI-only: pure .github change',
    files: ['.github/actions/setup-node/action.yml', '.github/instructions/core.instructions.md'],
    expected: F(false, false, true, false, false, false, false, false, false, false, false, true),
  },
  // Dependency change: unsafe for both sim, coverage, and deps.
  {
    name: 'dependency change (package.json, deps touched)',
    files: ['package.json'],
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'false' },
    // package.json (unsafe) falls to catch-all → all visual surfaces touched
    expected: F(false, false, false, false, false, true, true, true, true, true, true, true),
  },
  // Asset change: sim and coverage untouched.
  {
    name: 'asset-only: generated sprite sheet',
    files: ['public/assets/generated/sprites.png', 'public/assets/generated/manifest.json'],
    expected: F(true, false, true, false, false, false, false, true, false, true, false),
  },
  // Unknown/unclassified path → fail-closed: sim_touched=true, coverage_touched=true.
  {
    name: 'unknown unclassified path → fail-closed',
    files: ['some-new-build-output/bundle.js'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      true,
    ),
  },
  // Game unit test (non-sprites): coverage_touched=true, sim_touched=false.
  {
    name: 'game unit test (non-sprites) → coverage touched, sim not touched',
    files: ['tests/unit/some-game-logic.test.ts'],
    expected: F(false, false, false, false, false, false, true, false, false, false, false),
  },
  // Bootstrap wiring: both sim and coverage touched.
  {
    name: 'bootstrap wiring file → sim and coverage touched',
    files: ['src/bootstrap/floor-main-scene-options.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  // Headless tests: sim touched (test outcome matters), coverage NOT touched.
  {
    name: 'headless test → sim touched only',
    files: ['tests/headless/ai-stuck-wiggle.test.ts'],
    expected: F(false, false, false, false, false, true, false, false, false, false, false),
  },
  // Integration test (non-sprites): neither sim nor coverage touched.
  {
    name: 'integration test (non-sprites) → neither sim nor coverage',
    files: ['tests/integration/some-game-test.test.ts'],
    expected: F(false, false, false, false, false, false, false, false, false, false, false),
  },
  // Docs handoff + game code → sim and coverage still touched (handoff doesn't neutralise sim flag).
  {
    name: 'handoff + game code → sim and coverage touched',
    files: ['docs/knowledge/handoffs/2026-07-19-my-feature.md', 'src/game/combat.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  // Docs handoff alone → neutral (docs/* safe for both).
  {
    name: 'handoff alone → neutral companion',
    files: ['docs/knowledge/handoffs/2026-07-19-my-feature.md'],
    expected: F(true, true, true, false, false, false, false, false, false, false, false),
  },
  // Security-impact surfaces: dependencies_touched.
  {
    name: 'package-lock.json → dependencies_touched',
    files: ['package-lock.json'],
    expected: F(false, false, false, false, false, true, true, true, true, true, true, true),
  },
  {
    name: 'yarn.lock → dependencies_touched',
    files: ['yarn.lock'],
    expected: F(false, false, false, false, false, true, true, true, true, true, true, true),
  },
  {
    name: 'npm-shrinkwrap.json → dependencies_touched',
    files: ['npm-shrinkwrap.json'],
    expected: F(false, false, false, false, false, true, true, true, true, true, true, true),
  },
  {
    name: 'dep-allowlist validator → dependencies_touched',
    files: ['scripts/agent/security/check-deps.ts'],
    expected: F(false, false, false, false, false, false, false, false, false, false, false, true),
  },
  {
    name: 'npm-audit wrapper → dependencies_touched',
    files: ['scripts/agent/security/npm-audit.mjs'],
    expected: F(false, false, false, false, false, false, false, false, false, false, false, true),
  },
  {
    name: 'lock-integrity guard → dependencies_touched',
    files: ['scripts/agent/security/check-lock-integrity.mjs'],
    expected: F(false, false, false, false, false, false, false, false, false, false, false, true),
  },
  // Security-impact surfaces: ai_code_touched.
  {
    name: 'AI source file → ai_code_touched',
    files: ['src/game/ai/bt-ai-provider.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      true,
      false,
      true,
    ),
  },
  {
    name: 'AI prompt-injection validator → ai_code_touched',
    files: ['scripts/agent/security/check-ai-prompts.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  {
    name: 'copilot instructions file → docs_only, not ai_code_touched',
    files: ['.github/copilot-instructions.md'],
    // *.md matches docs-only surface; check-ai-prompts.ts only scans src/game/ai
    // so instruction files are intentionally excluded from ai_code_touched.
    expected: F(false, true, true, false, false, false, false),
  },
  {
    name: 'github instructions file → docs_only, not ai_code_touched',
    files: ['.github/instructions/ai.instructions.md'],
    // Same reasoning: instruction *.md files are docs-only; validator does not scan them.
    expected: F(false, true, true, false, false, false, false),
  },
  // Security-impact surfaces: codeowners_touched.
  {
    name: 'CODEOWNERS → codeowners_touched',
    files: ['CODEOWNERS'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      true,
    ),
  },
  {
    name: 'CODEOWNERS validator → codeowners_touched',
    files: ['scripts/agent/security/check-codeowners.ts'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  // Security infra: changes to the security workflow or scope classifier force all
  // four security flags so modified gates are exercised in the same PR.
  {
    name: 'security-review.yml → all security flags',
    files: ['.github/workflows/security-review.yml'],
    expected: F(
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ),
  },
  // Mixed: package.json + game code.
  {
    name: 'package.json + game code → dependencies_touched, not gameplay_safe',
    files: ['package.json', 'src/game/combat.ts'],
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'false' },
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      true,
    ),
  },
  // Mixed: AI source + dep change.
  {
    name: 'AI source + package.json → ai_code_touched + dependencies_touched',
    files: ['src/game/ai/bt-ai-provider.ts', 'package.json'],
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'false' },
    expected: F(
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      true,
    ),
  },
  // source_code_touched: dynamic-execution validator itself.
  {
    name: 'check-dynamic-patterns.sh validator → source_code_touched',
    files: ['scripts/agent/security/check-dynamic-patterns.sh'],
    expected: F(
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ),
  },
  // Art-only scope regression: art_only=true, docs_only=false, source_code_touched=false.
  // The security workflow fast-path must check art_only explicitly (docs_only is false for
  // art paths) and Node setup must be skipped. source_code_touched=false ensures the
  // dynamic-execution scan is skipped for sprite-only PRs.
  {
    name: 'art-only scope regression: art_only=true, docs_only=false → workflow fast-path via art_only',
    files: ['public/assets/generated/sprites.png'],
    // docs_only=false, art_only=true: security-review.yml must use art_only to gate fast-path
    expected: F(true, false, true, false, false, false, false, true, false, true, false),
  },
  // Mixed art + docs (CI Recovery adds handoff/review-ledger to asset PR): still art_only.
  // docs/* is in the art_only allowlist so the heavy sim gates are still suppressed.
  {
    name: 'art + docs mixed (CI Recovery handoff on asset PR) → art_only=true, docs_only=false',
    files: [
      'public/assets/generated/hero.png',
      'src/shared/data/sprite-catalog.json',
      'docs/knowledge/handoffs/2026-07-31-example.md',
      'docs/knowledge/review-ledgers/2026-07-31-example.review-ledger.json',
    ],
    // art_only=true, docs_only=false (art files break docs_only), gameplay_safe=true.
    // visual_touched=true, asset_visual_touched=true because art files are in the diff.
    expected: F(true, false, true, false, false, false, false, true, false, true, false),
  },
  // Brief YAML files alone: still art_only and gameplay_safe (design data, no sim impact).
  {
    name: 'brief-only (enemies): art_only=true, gameplay_safe=true',
    files: ['briefs/enemies/panda-boba-sniper.yaml', 'briefs/enemies/ratfolk-elite-underboss.yaml'],
    //                         art   docs  gsafe sponly sptch sim   cov   vis   game  asset devt
    expected: F(true, false, true, false, false, false, false, false, false, false, false),
  },
  // Brief + art together (queue-commit bundles them): still art_only and gameplay_safe.
  {
    name: 'art + brief (bundled queue-commit): art_only=true, gameplay_safe=true',
    files: [
      'public/assets/generated/panda-boba-sniper-var-0.png',
      'briefs/enemies/panda-boba-sniper.yaml',
    ],
    //                         art   docs  gsafe sponly sptch sim   cov   vis   game  asset devt
    expected: F(true, false, true, false, false, false, false, true, false, true, false),
  },
];

describe('detect-art-only.sh change-scope classifier', () => {
  it('resolves bash (required by the verify.sh harness)', () => {
    expect(hasBash).toBe(true);
  });

  it.skipIf(!hasBash)('fail-safe: a blank/whitespace change set runs the full suite', () => {
    // A lone newline enters the override branch but strips to empty → fail-safe.
    // sim_touched=true, coverage_touched=true, and all security flags true ensure all gates run.
    expect(run('\n')).toEqual(
      F(
        false,
        false,
        false,
        false,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
      ),
    );
  });

  it.skipIf(!hasBash)(
    'fail-safe: an empty/whitespace change set enables all visual suites (unknown diff → run everything)',
    () => {
      // A lone newline enters the override branch but strips to empty.
      // Empty/unknown changeset → we cannot safely skip visual suites, so all
      // surface flags must be true (same fail-safe as the no-base-ref path).
      expect(run('\n')).toEqual(
        F(
          false,
          false,
          false,
          false,
          true,
          true,
          true,
          true,
          true,
          true,
          true,
          true,
          true,
          true,
          true,
        ),
      );
    },
  );

  it.skipIf(!hasBash)('fail-safe: an explicitly empty override enables all visual suites', () => {
    // Presence-detected (${VAR+x}), so set-but-empty must NOT fall back to git.
    // Security-impact flags default to true on ambiguous scope so checks always run.
    expect(run('')).toEqual(
      F(
        false,
        false,
        false,
        false,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
      ),
    );
  });

  for (const c of cases) {
    it.skipIf(!hasBash)(`classifies ${c.name}`, () => {
      expect(classify(c.files, c.env ?? {})).toEqual(c.expected);
    });
  }

  // ── security-review.yml workflow YAML regression ──────────────────────────
  // These tests read the real workflow source and assert that art_only is present
  // in every affected step condition. They catch regressions where someone drops
  // art_only from setup-node or either secret-scan condition — the exact gap the
  // art-only fast-path classifier case cannot detect (it only exercises detect-art-only.sh).
  describe('security-review.yml: art_only fast-path wiring', () => {
    const wf = readFileSync(path.join(REPO_ROOT, '.github/workflows/security-review.yml'), 'utf8');

    it('fast-path echo step includes art_only condition', () => {
      // "Docs/asset-only fast-path" step must fire on art_only, not only docs_only.
      expect(wf).toMatch(/- name: Docs\/asset-only fast-path[\s\S]*?if:.*art_only.*==.*'true'/);
    });

    it('setup-node skip includes art_only condition', () => {
      // setup-node must be skipped when art_only to avoid unnecessary Node install on art PRs.
      const setupNodeIdx = wf.indexOf('uses: ./.github/actions/setup-node');
      expect(setupNodeIdx).toBeGreaterThan(-1);
      // Use a forward window of 512 chars — enough to span any `with:` block before `if:`.
      const stepBlock = wf.slice(setupNodeIdx, setupNodeIdx + 512);
      expect(stepBlock).toContain('art_only');
    });

    it('docs/asset-only secret scan includes art_only condition', () => {
      // The bash-direct secret scan (no Node) must fire for art_only, not only docs_only.
      expect(wf).toMatch(
        /- name: Scan for committed secrets \(docs\/asset-only\)[\s\S]*?if:.*art_only/,
      );
    });

    it('Node-wrapped secret scan excludes art_only paths', () => {
      // The Node-wrapped secret scan must be skipped for art_only (Node is not set up).
      // Find the step by its unique name (no "(docs/asset-only)" suffix) and read its `if:` line.
      const stepIdx = wf.indexOf('- name: Scan for committed secrets\n');
      expect(stepIdx).toBeGreaterThan(-1);
      // Use a forward window of 512 chars — large enough to always capture the `if:` condition.
      const stepBlock = wf.slice(stepIdx, stepIdx + 512);
      expect(stepBlock).toContain('art_only');
    });
  });
});
