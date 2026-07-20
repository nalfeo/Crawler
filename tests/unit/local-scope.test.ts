import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toBashScriptPath } from '../helpers/bash-script-path.js';

/**
 * Deterministic coverage for the LOCAL change-scope helper
 * (`scripts/agent/ci/local-scope.sh`). Unlike detect-art-only.sh (driven by the
 * SCOPE_FILES_OVERRIDE hook), local-scope.sh computes the changed-file set from
 * the real working tree — the union of committed branch changes AND uncommitted
 * work — then delegates classification to detect-art-only.sh. `npm run scope`
 * and verify-fast.sh gate expensive work on its `gameplay_safe` flag, so a wrong
 * "safe" here would silently skip a check. We exercise the actual git logic in a
 * throwaway repo and assert the safety-critical invariants:
 *   - no resolvable merge base ⇒ ALWAYS all-false (never grant a safe skip from
 *     working-tree data alone — committed branch history could hide a src change)
 *   - deletions/renames are included (no --diff-filter) ⇒ a deleted src/core file
 *     forces gameplay_safe=false
 *   - staged / unstaged / untracked work is unioned with committed branch changes
 *   - a clean tree fails safe to all-false (run everything)
 */

const SCRIPT = toBashScriptPath(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../scripts/agent/ci/local-scope.sh',
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
  sim_touched: boolean;
  coverage_touched: boolean;
  sprite_pipeline_touched: boolean;
  dependencies_touched: boolean;
}

const F = (
  art_only: boolean,
  docs_only: boolean,
  gameplay_safe: boolean,
  overrides: Partial<Scope> = {},
): Scope => ({
  art_only,
  docs_only,
  gameplay_safe,
  // The working-tree tests focus on the three safety-critical flags. The orthogonal
  // flags are covered by detect-change-scope.test.ts (via SCOPE_FILES_OVERRIDE).
  // We parse them here so the output shape stays consistent but don't vary them
  // in these scenarios.
  sprites_only: false,
  sprites_touched: false,
  visual_touched: false,
  game_visual_touched: false,
  asset_visual_touched: false,
  devtool_visual_touched: false,
  sim_touched: false,
  coverage_touched: false,
  sprite_pipeline_touched: false,
  dependencies_touched: false,
  ...overrides,
});

const tempDirs: string[] = [];

/**
 * Removes a directory tree, retrying on EBUSY/EPERM/ENOTEMPTY. On Windows, a
 * just-exited WSL `bash.exe` interop child leaves the directory it ran in
 * transiently locked (observed up to ~3s) even after `spawnSync` has
 * returned — `rmSync`'s own `maxRetries`/`retryDelay` do NOT cover this: they
 * only retry errors encountered while walking the tree, not a busy top-level
 * `rmdir`, so a real async wait-and-retry loop is required. This is a no-op
 * fast path (single attempt) on POSIX platforms and for any other bash.
 */
async function rmDirWithRetry(dir: string, attempts = 15, delayMs = 300): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (attempt === attempts || !retryable) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rmDirWithRetry(dir);
  }
});

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
  write: (relPath: string, content: string) => void;
  del: (relPath: string) => void;
  scope: () => Scope;
}

function makeRepo(): Repo {
  const dir = mkdtempSync(path.join(tmpdir(), 'local-scope-'));
  tempDirs.push(dir);
  const git = (...args: string[]): string => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${res.status}): ${res.stderr}`);
    }
    return res.stdout;
  };
  const write = (relPath: string, content: string): void => {
    const abs = path.join(dir, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const del = (relPath: string): void => {
    git('rm', '-q', relPath);
  };
  const scope = (): Scope => {
    const res = spawnSync('bash', [SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      // Neutralize inherited CI/override env so the helper reads the temp repo.
      env: {
        ...process.env,
        SCOPE_FILES_OVERRIDE: undefined,
        GITHUB_BASE_REF: undefined,
        GITHUB_OUTPUT: '',
      } as NodeJS.ProcessEnv,
    });
    if (res.status !== 0) {
      throw new Error(`local-scope.sh exited ${res.status}\n${res.stdout}\n${res.stderr}`);
    }
    const read = (key: keyof Scope): boolean => {
      const m = res.stdout.match(new RegExp(`^${key}=(true|false)$`, 'm'));
      if (!m) throw new Error(`missing '${key}' in output:\n${res.stdout}`);
      return m[1] === 'true';
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
      sim_touched: read('sim_touched'),
      coverage_touched: read('coverage_touched'),
      sprite_pipeline_touched: read('sprite_pipeline_touched'),
      dependencies_touched: read('dependencies_touched'),
    };
  };
  // Deterministic identity + no signing so commits work on any runner.
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Local Scope Test');
  git('config', 'commit.gpgsign', 'false');
  return { dir, git, write, del, scope };
}

/** main branch with one commit, then a feature branch checked out. */
function mainWithFeature(repo: Repo): void {
  repo.write('README.md', '# seed\n');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'seed');
  repo.git('branch', '-M', 'main');
  repo.git('checkout', '-q', '-b', 'feature');
}

describe('local-scope.sh working-tree change-scope helper', () => {
  it('resolves bash (required by the verify:fast harness)', () => {
    expect(hasBash).toBe(true);
  });

  it.skipIf(!hasBash)(
    'CRIT-1: no merge base ⇒ legacy flags false, new positive flags true (fail-closed)',
    () => {
      const repo = makeRepo();
      repo.write('README.md', '# seed\n');
      repo.git('add', '.');
      repo.git('commit', '-q', '-m', 'seed');
      // Rename the only branch away from main so neither origin/main nor main resolves.
      repo.git('branch', '-M', 'feature');
      // A docs-only edit would look "safe" if classified from the working tree alone —
      // but with no base we must refuse and force the full suite.
      repo.write('docs/notes.md', 'notes\n');
      // Unknown scope: legacy flags stay false (no false "safe" skip granted);
      // the five new positive flags are true (fail-closed — cannot prove nothing changed).
      expect(repo.scope()).toEqual(
        F(false, false, false, {
          visual_touched: true,
          game_visual_touched: true,
          asset_visual_touched: true,
          devtool_visual_touched: true,
          sim_touched: true,
          coverage_touched: true,
          sprite_pipeline_touched: true,
          dependencies_touched: true,
        }),
      );
    },
  );

  it.skipIf(!hasBash)('clean tree with a resolved base fails safe to all-false', () => {
    const repo = makeRepo();
    mainWithFeature(repo);
    // feature == main, nothing changed → empty set → detect-art-only fail-safe.
    expect(repo.scope()).toEqual(F(false, false, false));
  });

  it.skipIf(!hasBash)('committed docs-only branch change ⇒ gameplay_safe', () => {
    const repo = makeRepo();
    mainWithFeature(repo);
    repo.write('docs/architecture.md', '# arch\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'docs');
    expect(repo.scope()).toEqual(F(false, true, true));
  });

  it.skipIf(!hasBash)('committed docs json branch change still counts as docs-only', () => {
    const repo = makeRepo();
    mainWithFeature(repo);
    repo.write('docs/knowledge/metrics/apples/2026-07-08-adr-cleanup.json', '{"ok":true}\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'docs json');
    expect(repo.scope()).toEqual(F(false, true, true));
  });

  it.skipIf(!hasBash)('committed src/core branch change ⇒ not safe', () => {
    const repo = makeRepo();
    mainWithFeature(repo);
    repo.write('src/core/systems/movementSystem.ts', 'export const x = 1;\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'core');
    // src/core → gameplay_safe=false, sim_touched=true, coverage_touched=true, visual_touched=true
    expect(repo.scope()).toEqual(
      F(false, false, false, {
        visual_touched: true,
        game_visual_touched: true,
        sim_touched: true,
        coverage_touched: true,
      }),
    );
  });

  it.skipIf(!hasBash)('untracked src/core file is unioned in ⇒ not safe', () => {
    const repo = makeRepo();
    mainWithFeature(repo);
    // No commit on feature; the change exists only as an untracked working file.
    repo.write('src/core/world.ts', 'export const w = 1;\n');
    // src/core → gameplay_safe=false, sim_touched=true, coverage_touched=true, visual_touched=true
    expect(repo.scope()).toEqual(
      F(false, false, false, {
        visual_touched: true,
        game_visual_touched: true,
        sim_touched: true,
        coverage_touched: true,
      }),
    );
  });

  it.skipIf(!hasBash)('unstaged docs-only edit ⇒ gameplay_safe', () => {
    const repo = makeRepo();
    mainWithFeature(repo);
    // README.md is tracked; edit it without staging.
    repo.write('README.md', '# seed edited\n');
    expect(repo.scope()).toEqual(F(false, true, true));
  });

  it.skipIf(!hasBash)(
    'CRIT-2: a committed src/core deletion (no diff-filter) forces not safe',
    () => {
      const repo = makeRepo();
      repo.write('README.md', '# seed\n');
      repo.write('src/core/doomed.ts', 'export const d = 1;\n');
      repo.git('add', '.');
      repo.git('commit', '-q', '-m', 'seed');
      repo.git('branch', '-M', 'main');
      repo.git('checkout', '-q', '-b', 'feature');
      // Delete the src/core file and also touch a docs file, then commit both.
      repo.del('src/core/doomed.ts');
      repo.write('docs/readme.md', 'x\n');
      repo.git('add', '.');
      repo.git('commit', '-q', '-m', 'delete core + docs');
      // With --diff-filter=ACMR the deletion would vanish and only docs would remain
      // → a spurious gameplay_safe=true. The helper uses no filter, so it stays false.
      // src/core deletion → gameplay_safe=false, sim_touched=true, coverage_touched=true, visual_touched=true
      expect(repo.scope()).toEqual(
        F(false, false, false, {
          visual_touched: true,
          game_visual_touched: true,
          sim_touched: true,
          coverage_touched: true,
        }),
      );
    },
  );

  it.skipIf(!hasBash)(
    'CRIT-3: rename across impact classes — both old and new paths are classified',
    () => {
      const repo = makeRepo();
      repo.write('README.md', '# seed\n');
      repo.write('src/core/moveable.ts', 'export const m = 1;\n');
      repo.git('add', '.');
      repo.git('commit', '-q', '-m', 'seed');
      repo.git('branch', '-M', 'main');
      repo.git('checkout', '-q', '-b', 'feature');
      // git mv requires the destination directory to exist.
      mkdirSync(path.join(repo.dir, 'some', 'unknown'), { recursive: true });
      // Rename the src/core file to an unclassified path (crosses impact classes).
      repo.git('mv', 'src/core/moveable.ts', 'some/unknown/destination.ts');
      repo.git('add', '.');
      repo.git('commit', '-q', '-m', 'rename core → unclassified');
      // The diff contains both:
      //   src/core/moveable.ts  (old path, classified: sim_touched, coverage_touched)
      //   some/unknown/destination.ts (new path, unclassified → all five new flags)
      // Neither path should be silently dropped — no --diff-filter is used.
      expect(repo.scope()).toEqual(
        F(false, false, false, {
          visual_touched: true,
          game_visual_touched: true,
          asset_visual_touched: true,
          devtool_visual_touched: true,
          sim_touched: true,
          coverage_touched: true,
          sprite_pipeline_touched: true,
          dependencies_touched: true,
        }),
      );
    },
  );
});
