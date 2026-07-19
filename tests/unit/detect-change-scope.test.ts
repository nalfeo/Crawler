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
  // ── Approved-art surface ───────────────────────────────────────────────────
  {
    name: 'generated sprites + manifest',
    files: ['public/assets/generated/manifest.json'],
    // public/* → visual; public/* neutral for coverage; not sim/sprite pipeline
    expected: F(true, false, true, false, false, true, false, false, false, false),
  },
  {
    name: 'sprite catalog data',
    files: ['src/shared/data/sprite-catalog.json'],
    // explicit visual positive; explicit sim neutral; src/* → coverage
    expected: F(true, false, true, false, false, true, false, true, false, false),
  },
  {
    name: 'package script wiring (safe split)',
    files: ['package.json'],
    env: {
      PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'true',
      PACKAGE_JSON_DEPS_TOUCHED_OVERRIDE: 'false',
    },
    // scripts-only: neutral for visual/sim/coverage, no dep change
    expected: F(false, false, true, false, false, false, false, false, false, false),
  },
  {
    name: 'package unsafe non-dep change (e.g. top-level key)',
    files: ['package.json'],
    env: {
      PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE: 'false',
      PACKAGE_JSON_DEPS_TOUCHED_OVERRIDE: 'false',
    },
    // not scripts-safe → fail-closed for visual/sim/coverage; no dep change
    expected: F(false, false, false, false, false, true, true, true, false, false),
  },
  {
    name: 'scope classifier script',
    files: ['scripts/agent/ci/detect-art-only.sh'],
    // scripts/* → neutral; this specific file is also in gameplay_safe allowlist
    expected: F(false, false, true, false, false, false, false, false, false, false),
  },
  {
    name: 'scope classifier unit test',
    files: ['tests/unit/detect-change-scope.test.ts'],
    // tests/unit/* (non-sprite) → coverage; in gameplay_safe allowlist
    expected: F(false, false, true, false, false, false, false, true, false, false),
  },
  // ── Docs / text / neutral companion files ─────────────────────────────────
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
    name: 'handoff doc is neutral companion',
    files: ['docs/knowledge/handoffs/2026-07-19-foo.md'],
    expected: F(false, true, true, false, false, false, false, false, false, false),
  },
  {
    name: 'review ledger is neutral companion',
    files: ['docs/knowledge/review-ledgers/2026-07-19-foo.review-ledger.json'],
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
  // ── Gameplay-safe surfaces the headless runner never imports ───────────────
  {
    name: 'engine-only (rendering)',
    files: ['src/engine/render/floorRenderer.ts'],
    // src/engine/* → visual=true; neutral for sim; src/* → coverage=true
    expected: F(false, false, true, false, false, true, false, true, false, false),
  },
  {
    name: 'labs-only',
    files: ['src/labs/combatLab.ts'],
    // src/labs/* → visual=true; neutral for sim; src/* → coverage=true
    expected: F(false, false, true, false, false, true, false, true, false, false),
  },
  {
    name: 'e2e tests',
    files: ['tests/e2e/hud-overlap-visual.test.ts'],
    // tests/e2e/* → neutral for all new flags (not coverage)
    expected: F(false, false, true, false, false, false, false, false, false, false),
  },
  {
    name: 'docs + engine mixed',
    files: ['docs/x.md', 'src/engine/foo.ts'],
    // engine → visual=true, coverage=true; docs → neutral; combined gameplay_safe=true
    expected: F(false, false, true, false, false, true, false, true, false, false),
  },
  // ── Simulation-layer changes ───────────────────────────────────────────────
  {
    name: 'core system',
    files: ['src/core/systems/movementSystem.ts'],
    // src/core/* → sim=true; neutral for visual; src/* → coverage=true
    expected: F(false, false, false, false, false, false, true, true, false, false),
  },
  {
    name: 'game system',
    files: ['src/game/combat.ts'],
    // src/game/* → sim=true; neutral for visual; src/* → coverage=true
    expected: F(false, false, false, false, false, false, true, true, false, false),
  },
  {
    name: 'shared (non-catalog)',
    files: ['src/shared/random.ts'],
    // src/shared/* (non-catalog) → sim=true; neutral for visual; src/* → coverage=true
    expected: F(false, false, false, false, false, false, true, true, false, false),
  },
  {
    name: 'headless test itself',
    files: ['tests/headless/floor1-completion.test.ts'],
    // tests/headless/* → sim=true AND coverage=true; neutral for visual
    expected: F(false, false, false, false, false, false, true, true, false, false),
  },
  {
    name: 'engine + game mixed',
    files: ['src/engine/render/foo.ts', 'src/game/combat.ts'],
    // engine → visual=true; game → sim=true; both → coverage=true
    expected: F(false, false, false, false, false, true, true, true, false, false),
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
    expected: F(false, false, true, false, false, false, false, false, false, false),
  },
  {
    name: 'workflow change',
    files: ['.github/workflows/ci.yml'],
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
    // .github → neutral; engine → visual=true, coverage=true; combined gameplay_safe=true
    expected: F(false, false, true, false, false, true, false, true, false, false),
  },
  {
    name: 'workflow + game code (gameplay-unsafe)',
    files: ['.github/workflows/ci.yml', 'src/game/combat.ts'],
    // .github → neutral; game → sim=true, coverage=true
    expected: F(false, false, false, false, false, false, true, true, false, false),
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
    // scripts/* → neutral for visual/sim/coverage; sprite pipeline → sprite_pipeline_touched=true
    expected: F(false, false, true, true, true, false, false, false, true, false),
  },
  {
    name: 'sprites pipeline unit test',
    files: ['tests/unit/sprites/run-pipeline.test.ts'],
    // explicitly neutral for sim/coverage (sprite test exclusions precede tests/*)
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
    expected: F(false, false, true, true, true, false, false, false, true, false),
  },
  {
    name: 'sprites pipeline + game code (mixed) → sprites_only=false, sprites_touched=true',
    files: ['scripts/sprites/batch.ts', 'src/game/combat.ts'],
    // game → sim=true, coverage=true; no visual; sprite_pipeline=true from sprites_touched
    expected: F(false, false, false, false, true, false, true, true, true, false),
  },
  {
    name: 'sprites pipeline + engine code → sprites_only=false, gameplay_safe=true, sprites_touched=true',
    files: ['scripts/sprites/run-full.ts', 'src/engine/renderer.ts'],
    // engine → visual=true, coverage=true; sprite_pipeline=true
    expected: F(false, false, true, false, true, true, false, true, true, false),
  },
  // Root pipeline integration tests: in sprites surface, so sprites_only=true, sprites_touched=true.
  {
    name: 'root pipeline integration test (batch-cli)',
    files: ['tests/integration/batch-cli.test.ts'],
    // explicitly neutral for sim/coverage; sprite pipeline
    expected: F(false, false, true, true, true, false, false, false, true, false),
  },
  {
    name: 'root pipeline integration test (sidecar-lifecycle)',
    files: ['tests/integration/sidecar-lifecycle.test.ts'],
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
  },
  // Game-only change → sprites_touched=false.
  {
    name: 'game-only change → sprites_touched=false',
    files: ['src/game/combat.ts', 'src/core/systems/movementSystem.ts'],
    expected: F(false, false, false, false, false, false, true, true, false, false),
  },
];

describe('detect-art-only.sh change-scope classifier', () => {
  it('resolves bash (required by the verify.sh harness)', () => {
    expect(hasBash).toBe(true);
  });

  it.skipIf(!hasBash)('fail-safe: a blank/whitespace change set runs the full suite', () => {
    // A lone newline enters the override branch but strips to empty → all-false.
    expect(run('\n')).toEqual(
      F(false, false, false, false, false, false, false, false, false, false),
    );
  });

  it.skipIf(!hasBash)(
    'fail-safe: an explicitly empty override is honored as an empty change set',
    () => {
      // Presence-detected (${VAR+x}), so set-but-empty must NOT fall back to git.
      expect(run('')).toEqual(
        F(false, false, false, false, false, false, false, false, false, false),
      );
    },
  );

  for (const c of cases) {
    it.skipIf(!hasBash)(`classifies ${c.name}`, () => {
      expect(classify(c.files, c.env ?? {})).toEqual(c.expected);
    });
  }
});
