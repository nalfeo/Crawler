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
<<<<<<< HEAD
  visual_touched: boolean;
  sim_touched: boolean;
  coverage_touched: boolean;
  sprite_pipeline_touched: boolean;
  dependencies_touched: boolean;
=======
  sim_touched: boolean;
  coverage_touched: boolean;
>>>>>>> origin/main
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
<<<<<<< HEAD
    visual_touched: read('visual_touched'),
    sim_touched: read('sim_touched'),
    coverage_touched: read('coverage_touched'),
    sprite_pipeline_touched: read('sprite_pipeline_touched'),
    dependencies_touched: read('dependencies_touched'),
=======
    sim_touched: read('sim_touched'),
    coverage_touched: read('coverage_touched'),
>>>>>>> origin/main
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
<<<<<<< HEAD
  visual_touched: boolean,
  sim_touched: boolean,
  coverage_touched: boolean,
  sprite_pipeline_touched: boolean,
  dependencies_touched: boolean,
=======
  sim_touched: boolean,
  coverage_touched: boolean,
>>>>>>> origin/main
): Scope => ({
  art_only,
  docs_only,
  gameplay_safe,
  sprites_only,
  sprites_touched,
<<<<<<< HEAD
  visual_touched,
  sim_touched,
  coverage_touched,
  sprite_pipeline_touched,
  dependencies_touched,
=======
  sim_touched,
  coverage_touched,
>>>>>>> origin/main
});

const cases: Case[] = [
  // ── Approved-art surface ───────────────────────────────────────────────────
  {
    name: 'generated sprites + manifest',
    files: ['public/assets/generated/manifest.json'],
<<<<<<< HEAD
    // public/* → visual; public/* neutral for coverage; not sim/sprite pipeline
    expected: F(true, false, true, false, false, true, false, false, false, false),
=======
    expected: F(true, false, true, false, false, false, false),
>>>>>>> origin/main
  },
  {
    name: 'sprite catalog data',
    files: ['src/shared/data/sprite-catalog.json'],
<<<<<<< HEAD
    // explicit visual positive; explicit sim neutral; src/* → coverage
    expected: F(true, false, true, false, false, true, false, true, false, false),
=======
    expected: F(true, false, true, false, false, false, false),
>>>>>>> origin/main
  },
  {
    name: 'package script wiring (safe split)',
    files: ['package.json'],
<<<<<<< HEAD
    env: {
      PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'true',
      PACKAGE_JSON_DEPS_TOUCHED_OVERRIDE: 'false',
    },
    // scripts-only: neutral for visual/sim/coverage, no dep change
    expected: F(false, false, true, false, false, false, false, false, false, false),
=======
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'true' },
    expected: F(false, false, true, false, false, false, false),
>>>>>>> origin/main
  },
  {
    name: 'package unsafe non-dep change (e.g. top-level key)',
    files: ['package.json'],
<<<<<<< HEAD
    env: {
      PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'false',
      PACKAGE_JSON_DEPS_TOUCHED_OVERRIDE: 'false',
    },
    // not scripts-safe → fail-closed for visual/sim/coverage; no dep change
    expected: F(false, false, false, false, false, true, true, true, false, false),
=======
    env: { PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'false' },
    expected: F(false, false, false, false, false, true, true),
>>>>>>> origin/main
  },
  {
    name: 'scope classifier script',
    files: ['scripts/agent/ci/detect-art-only.sh'],
<<<<<<< HEAD
    // scripts/* → neutral; this specific file is also in gameplay_safe allowlist
    expected: F(false, false, true, false, false, false, false, false, false, false),
=======
    expected: F(false, false, true, false, false, false, false),
>>>>>>> origin/main
  },
  {
    name: 'scope classifier unit test',
    files: ['tests/unit/detect-change-scope.test.ts'],
<<<<<<< HEAD
    // tests/unit/* (non-sprite) → coverage; in gameplay_safe allowlist
    expected: F(false, false, true, false, false, false, false, true, false, false),
=======
    // tests/unit/* → sim_touched=false (unit tests don't affect sim runtime);
    // tests/unit/ non-sprites → coverage_touched=true (this file is in tests/unit/
    // and is not under tests/unit/sprites/, so it can affect unit coverage numbers)
    expected: F(false, false, true, false, false, false, true),
>>>>>>> origin/main
  },
  // ── Docs / text / neutral companion files ─────────────────────────────────
  {
    name: 'docs markdown',
    files: ['docs/architecture.md'],
<<<<<<< HEAD
    expected: F(false, true, true, false, false, false, false, false, false, false),
=======
    expected: F(false, true, true, false, false, false, false),
>>>>>>> origin/main
  },
  {
    name: 'docs knowledge metric json',
    files: ['docs/knowledge/metrics/apples/2026-07-08-adr-cleanup.json'],
<<<<<<< HEAD
    expected: F(false, true, true, false, false, false, false, false, false, false),
  },
  {
    name: 'handoff doc is neutral companion',
    files: ['docs/knowledge/handoffs/2026-07-19-foo.md'],
    expected: F(false, true, true, false, false, false, false, false, false, false),
  },
  {
    name: 'review ledger is neutral companion',
    files: ['docs/knowledge/review-ledgers/2026-07-19-foo.review-ledger.json'],
    expected: F(false, true, true, false, false, false, false, false, false, false),
=======
    expected: F(false, true, true, false, false, false, false),
>>>>>>> origin/main
  },
  {
    name: 'spec markdown',
    files: ['.specify/specs/spawner-battle-arena.md'],
<<<<<<< HEAD
    expected: F(false, true, true, false, false, false, false, false, false, false),
=======
    expected: F(false, true, true, false, false, false, false),
>>>>>>> origin/main
  },
  {
    name: 'agents governance doc',
    files: ['AGENTS.md'],
<<<<<<< HEAD
    expected: F(false, true, true, false, false, false, false, false, false, false),
=======
    expected: F(false, true, true, false, false, false, false),
>>>>>>> origin/main
  },
  {
    name: 'root readme',
    files: ['README.md'],
<<<<<<< HEAD
    expected: F(false, true, true, false, false, false, false, false, false, false),
  },
  // ── Gameplay-safe surfaces the headless runner never imports ───────────────
  {
    name: 'engine-only (rendering)',
    files: ['src/engine/render/floorRenderer.ts'],
    // src/engine/* → visual=true; neutral for sim; src/* → coverage=true
    expected: F(false, false, true, false, false, true, false, true, false, false),
=======
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
>>>>>>> origin/main
  },
  {
    name: 'labs-only',
    files: ['src/labs/combatLab.ts'],
<<<<<<< HEAD
    // src/labs/* → visual=true; neutral for sim; src/* → coverage=true
    expected: F(false, false, true, false, false, true, false, true, false, false),
=======
    expected: F(false, false, true, false, false, true, false),
>>>>>>> origin/main
  },
  {
    name: 'e2e tests',
    files: ['tests/e2e/hud-overlap-visual.test.ts'],
<<<<<<< HEAD
    // tests/e2e/* → neutral for all new flags (not coverage)
    expected: F(false, false, true, false, false, false, false, false, false, false),
=======
    expected: F(false, false, true, false, false, false, false),
>>>>>>> origin/main
  },
  {
    name: 'docs + engine mixed',
    files: ['docs/x.md', 'src/engine/foo.ts'],
<<<<<<< HEAD
    // engine → visual=true, coverage=true; docs → neutral; combined gameplay_safe=true
    expected: F(false, false, true, false, false, true, false, true, false, false),
=======
    expected: F(false, false, true, false, false, true, true),
>>>>>>> origin/main
  },
  // ── Simulation-layer changes ───────────────────────────────────────────────
  {
    name: 'core system',
    files: ['src/core/systems/movementSystem.ts'],
<<<<<<< HEAD
    // src/core/* → sim=true; neutral for visual; src/* → coverage=true
    expected: F(false, false, false, false, false, false, true, true, false, false),
=======
    expected: F(false, false, false, false, false, true, true),
>>>>>>> origin/main
  },
  {
    name: 'game system',
    files: ['src/game/combat.ts'],
<<<<<<< HEAD
    // src/game/* → sim=true; neutral for visual; src/* → coverage=true
    expected: F(false, false, false, false, false, false, true, true, false, false),
=======
    expected: F(false, false, false, false, false, true, true),
>>>>>>> origin/main
  },
  {
    name: 'shared (non-catalog)',
    files: ['src/shared/random.ts'],
<<<<<<< HEAD
    // src/shared/* (non-catalog) → sim=true; neutral for visual; src/* → coverage=true
    expected: F(false, false, false, false, false, false, true, true, false, false),
=======
    expected: F(false, false, false, false, false, true, true),
>>>>>>> origin/main
  },
  {
    // headless test: sim_touched=true (test outcome matters); coverage_touched=false (tests/headless/*)
    name: 'headless test itself',
    files: ['tests/headless/floor1-completion.test.ts'],
<<<<<<< HEAD
    // tests/headless/* → sim=true AND coverage=true; neutral for visual
    expected: F(false, false, false, false, false, false, true, true, false, false),
=======
    expected: F(false, false, false, false, false, true, false),
>>>>>>> origin/main
  },
  {
    name: 'engine + game mixed',
    files: ['src/engine/render/foo.ts', 'src/game/combat.ts'],
<<<<<<< HEAD
    // engine → visual=true; game → sim=true; both → coverage=true
    expected: F(false, false, false, false, false, true, true, true, false, false),
=======
    expected: F(false, false, false, false, false, true, true),
>>>>>>> origin/main
  },
  // ── Core + neutral companion: handoff doesn't broaden flags ───────────────
  {
    name: 'core change + handoff doc (neutral companion)',
    files: ['src/core/world.ts', 'docs/knowledge/handoffs/2026-07-19-foo.md'],
    // core → sim=true, coverage=true; handoff is neutral
    expected: F(false, false, false, false, false, false, true, true, false, false),
  },
  // ── CI/tooling paths ───────────────────────────────────────────────────────
  {
    name: 'ci script change',
    files: ['scripts/agent/ci/detect-art-only.sh'],
<<<<<<< HEAD
    expected: F(false, false, true, false, false, false, false, false, false, false),
=======
    expected: F(false, false, true, false, false, false, false),
>>>>>>> origin/main
  },
  {
    name: 'workflow change',
    files: ['.github/workflows/ci.yml'],
<<<<<<< HEAD
    expected: F(false, false, true, false, false, false, false, false, false, false),
=======
    expected: F(false, false, true, false, false, false, false),
>>>>>>> origin/main
  },
  {
    name: 'github actions change',
    files: ['.github/actions/setup-node/action.yml'],
<<<<<<< HEAD
    expected: F(false, false, true, false, false, false, false, false, false, false),
=======
    expected: F(false, false, true, false, false, false, false),
>>>>>>> origin/main
  },
  {
    name: 'github extensions change',
    files: ['.github/extensions/copilot-guards/guard.ts'],
<<<<<<< HEAD
    expected: F(false, false, true, false, false, false, false, false, false, false),
=======
    expected: F(false, false, true, false, false, false, false),
>>>>>>> origin/main
  },
  {
    name: 'mixed workflow + engine (non-gameplay)',
    files: ['.github/workflows/ci.yml', 'src/engine/render/foo.ts'],
<<<<<<< HEAD
    // .github → neutral; engine → visual=true, coverage=true; combined gameplay_safe=true
    expected: F(false, false, true, false, false, true, false, true, false, false),
=======
    expected: F(false, false, true, false, false, true, true),
>>>>>>> origin/main
  },
  {
    name: 'workflow + game code (gameplay-unsafe)',
    files: ['.github/workflows/ci.yml', 'src/game/combat.ts'],
<<<<<<< HEAD
    // .github → neutral; game → sim=true, coverage=true
    expected: F(false, false, false, false, false, false, true, true, false, false),
=======
    expected: F(false, false, false, false, false, true, true),
>>>>>>> origin/main
  },
  // ── Dependency manifest ────────────────────────────────────────────────────
  {
    name: 'package-lock.json → dependencies + fail-closed broad flags',
    files: ['package-lock.json'],
    // package-lock hits *)  in visual/sim/coverage loops → fail-closed=true for each
    expected: F(false, false, false, false, false, true, true, true, false, true),
  },
  {
    name: 'package.json dep sections changed',
    files: ['package.json'],
    env: {
      PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'false',
      PACKAGE_JSON_DEPS_TOUCHED_OVERRIDE: 'true',
    },
    // not gameplay_safe → fail-closed for visual/sim/coverage; deps changed
    expected: F(false, false, false, false, false, true, true, true, false, true),
  },
  {
    name: 'package.json dep check unknown (no base/node) → fail-closed',
    files: ['package.json'],
    env: {
      PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'false',
      PACKAGE_JSON_DEPS_TOUCHED_OVERRIDE: 'unknown',
    },
    // dep analysis unavailable → fail-closed for both broad flags and dependencies_touched
    expected: F(false, false, false, false, false, true, true, true, false, true),
  },
  // ── Unknown / unclassified paths ───────────────────────────────────────────
  {
    name: 'unknown path → fail-closed for all five new impact flags',
    files: ['some/weird/unclassified/file.xyz'],
    // *) in visual/sim/coverage loops → those three fail closed; has_unclassified
    // detection also forces sprite_pipeline_touched and dependencies_touched true
    expected: F(false, false, false, false, false, true, true, true, true, true),
  },
  // ── Sprite pipeline paths ──────────────────────────────────────────────────
  {
    name: 'sprites pipeline script',
    files: ['scripts/sprites/run-full.ts'],
<<<<<<< HEAD
    // scripts/* → neutral for visual/sim/coverage; sprite pipeline → sprite_pipeline_touched=true
    expected: F(false, false, true, true, true, false, false, false, true, false),
=======
    expected: F(false, false, true, true, true, false, false),
>>>>>>> origin/main
  },
  {
    name: 'sprites pipeline unit test',
    files: ['tests/unit/sprites/run-pipeline.test.ts'],
<<<<<<< HEAD
    // explicitly neutral for sim/coverage (sprite test exclusions precede tests/*)
    expected: F(false, false, true, true, true, false, false, false, true, false),
=======
    // tests/unit/sprites/* → coverage_touched=false (sprite tests don't cover game code)
    expected: F(false, false, true, true, true, false, false),
>>>>>>> origin/main
  },
  {
    name: 'sprites integration test',
    files: ['tests/integration/sprites/rerun.test.ts'],
<<<<<<< HEAD
    expected: F(false, false, true, true, true, false, false, false, true, false),
=======
    expected: F(false, false, true, true, true, false, false),
>>>>>>> origin/main
  },
  {
    name: 'sprites pipeline + unit test (pure sprites change)',
    files: ['scripts/sprites/batch.ts', 'tests/unit/sprites/batch.test.ts'],
<<<<<<< HEAD
    expected: F(false, false, true, true, true, false, false, false, true, false),
=======
    expected: F(false, false, true, true, true, false, false),
>>>>>>> origin/main
  },
  {
    name: 'sprites pipeline + game code (mixed) → sprites_only=false, sprites_touched=true',
    files: ['scripts/sprites/batch.ts', 'src/game/combat.ts'],
<<<<<<< HEAD
    // game → sim=true, coverage=true; no visual; sprite_pipeline=true from sprites_touched
    expected: F(false, false, false, false, true, false, true, true, true, false),
=======
    expected: F(false, false, false, false, true, true, true),
>>>>>>> origin/main
  },
  {
    name: 'sprites pipeline + engine code → sprites_only=false, gameplay_safe=true, sprites_touched=true',
    files: ['scripts/sprites/run-full.ts', 'src/engine/renderer.ts'],
<<<<<<< HEAD
    // engine → visual=true, coverage=true; sprite_pipeline=true
    expected: F(false, false, true, false, true, true, false, true, true, false),
=======
    expected: F(false, false, true, false, true, true, true),
>>>>>>> origin/main
  },
  // Root pipeline integration tests: in sprites surface, so sprites_only=true, sprites_touched=true.
  {
    name: 'root pipeline integration test (batch-cli)',
    files: ['tests/integration/batch-cli.test.ts'],
<<<<<<< HEAD
    // explicitly neutral for sim/coverage; sprite pipeline
    expected: F(false, false, true, true, true, false, false, false, true, false),
=======
    expected: F(false, false, true, true, true, false, false),
>>>>>>> origin/main
  },
  {
    name: 'root pipeline integration test (sidecar-lifecycle)',
    files: ['tests/integration/sidecar-lifecycle.test.ts'],
<<<<<<< HEAD
    expected: F(false, false, true, true, true, false, false, false, true, false),
  },
  // ── Overlap precedence tests ───────────────────────────────────────────────
  {
    name: 'sprite-catalog path ordering: visual positive before src/shared/* neutral',
    files: ['src/shared/data/sprite-catalog.json'],
    // Must match explicit positive BEFORE the broad src/shared/* neutral in sim loop
    // and explicit positive BEFORE src/shared/* neutral in visual loop
    expected: F(true, false, true, false, false, true, false, true, false, false),
  },
  {
    name: 'sprite test path ordering: neutral before tests/* positive in coverage loop',
    files: ['tests/unit/sprites/batch.test.ts'],
    // tests/unit/sprites/* must match BEFORE tests/* in coverage loop → coverage=false
    expected: F(false, false, true, true, true, false, false, false, true, false),
=======
    expected: F(false, false, true, true, true, false, false),
>>>>>>> origin/main
  },
  // Game-only change → sprites_touched=false.
  {
    name: 'game-only change → sprites_touched=false',
    files: ['src/game/combat.ts', 'src/core/systems/movementSystem.ts'],
<<<<<<< HEAD
    expected: F(false, false, false, false, false, false, true, true, false, false),
=======
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
>>>>>>> origin/main
  },
];

describe('detect-art-only.sh change-scope classifier', () => {
  it('resolves bash (required by the verify.sh harness)', () => {
    expect(hasBash).toBe(true);
  });

  it.skipIf(!hasBash)('fail-safe: a blank/whitespace change set runs the full suite', () => {
<<<<<<< HEAD
    // A lone newline enters the override branch but strips to empty → all-false.
    expect(run('\n')).toEqual(
      F(false, false, false, false, false, false, false, false, false, false),
    );
=======
    // A lone newline enters the override branch but strips to empty → fail-safe.
    // sim_touched=true and coverage_touched=true ensure both gates run.
    expect(run('\n')).toEqual(F(false, false, false, false, false, true, true));
>>>>>>> origin/main
  });

  it.skipIf(!hasBash)(
    'fail-safe: an explicitly empty override is honored as an empty change set',
    () => {
      // Presence-detected (${VAR+x}), so set-but-empty must NOT fall back to git.
<<<<<<< HEAD
      expect(run('')).toEqual(
        F(false, false, false, false, false, false, false, false, false, false),
      );
=======
      expect(run('')).toEqual(F(false, false, false, false, false, true, true));
>>>>>>> origin/main
    },
  );

  for (const c of cases) {
    it.skipIf(!hasBash)(`classifies ${c.name}`, () => {
      expect(classify(c.files, c.env ?? {})).toEqual(c.expected);
    });
  }
});
