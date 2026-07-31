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
  sim_touched: boolean;
  coverage_touched: boolean;
  sprite_pipeline_touched: boolean;
  dependencies_touched: boolean;
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
    'CRIT-1: no merge base ⇒ fail-closed shape even for a docs-only working tree',
    () => {
      const repo = makeRepo();
      repo.write('README.md', '# seed\n');
      repo.git('add', '.');
      repo.git('commit', '-q', '-m', 'seed');
      // Rename the only branch away from main so neither origin/main nor main resolves.
      repo.git('branch', '-M', 'feature');
      // A docs-only edit would look "safe" if classified from the working tree alone —
      // but with no base we must refuse and force the full suite (positive-signal flags true).
      repo.write('docs/notes.md', 'notes\n');
      //                               ao     do     gs     so     st     vt     simt   cvgt   spt    dept
      expect(repo.scope()).toEqual(
        F(false, false, false, false, true, true, true, true, true, true),
      );
    },
  );

  it.skipIf(!hasBash)(
    'clean tree with a resolved base fails safe (positive-signal flags true)',
    () => {
      const repo = makeRepo();
      mainWithFeature(repo);
      // feature == main, nothing changed → empty set → detect-art-only fail-safe
      // emits gameplay_safe=false with all positive-signal flags true.
      //                               ao     do     gs     so     st     vt     simt   cvgt   spt    dept
      expect(repo.scope()).toEqual(
        F(false, false, false, false, true, true, true, true, true, true),
      );
    },
  );

  it.skipIf(!hasBash)('committed docs-only branch change ⇒ gameplay_safe, no touched flags', () => {
    const repo = makeRepo();
    mainWithFeature(repo);
    repo.write('docs/architecture.md', '# arch\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'docs');
    //                               ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expect(repo.scope()).toEqual(
      F(true, true, true, false, false, false, false, false, false, false),
    );
  });

  it.skipIf(!hasBash)('committed docs json branch change still counts as docs-only', () => {
    const repo = makeRepo();
    mainWithFeature(repo);
    repo.write('docs/knowledge/metrics/apples/2026-07-08-adr-cleanup.json', '{"ok":true}\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'docs json');
    //                               ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expect(repo.scope()).toEqual(
      F(true, true, true, false, false, false, false, false, false, false),
    );
  });

  it.skipIf(!hasBash)(
    'committed src/core branch change ⇒ not safe, visual+sim+coverage touched',
    () => {
      const repo = makeRepo();
      mainWithFeature(repo);
      repo.write('src/core/systems/movementSystem.ts', 'export const x = 1;\n');
      repo.git('add', '.');
      repo.git('commit', '-q', '-m', 'core');
      //                               ao     do     gs     so     st     vt     simt   cvgt   spt    dept
      expect(repo.scope()).toEqual(
        F(false, false, false, false, false, true, true, true, false, false),
      );
    },
  );

  it.skipIf(!hasBash)('untracked src/core file is unioned in ⇒ not safe', () => {
    const repo = makeRepo();
    mainWithFeature(repo);
    // No commit on feature; the change exists only as an untracked working file.
    repo.write('src/core/world.ts', 'export const w = 1;\n');
    //                               ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expect(repo.scope()).toEqual(
      F(false, false, false, false, false, true, true, true, false, false),
    );
  });

  it.skipIf(!hasBash)('unstaged docs-only edit ⇒ gameplay_safe, no touched flags', () => {
    const repo = makeRepo();
    mainWithFeature(repo);
    // README.md is tracked; edit it without staging.
    repo.write('README.md', '# seed edited\n');
    //                               ao     do     gs     so     st     vt     simt   cvgt   spt    dept
    expect(repo.scope()).toEqual(
      F(false, true, true, false, false, false, false, false, false, false),
    );
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
      //                               ao     do     gs     so     st     vt     simt   cvgt   spt    dept
      expect(repo.scope()).toEqual(
        F(false, false, false, false, false, true, true, true, false, false),
      );
    },
  );

  it.skipIf(!hasBash)(
    'CRIT-3: a committed src/core rename (git mv within core) forces not safe',
    () => {
      const repo = makeRepo();
      repo.write('README.md', '# seed\n');
      repo.write('src/core/doomed.ts', 'export const d = 1;\n');
      repo.git('add', '.');
      repo.git('commit', '-q', '-m', 'seed');
      repo.git('branch', '-M', 'main');
      repo.git('checkout', '-q', '-b', 'feature');
      // Rename within src/core: git diff --name-only shows only the new path, which
      // still matches the core allowlist — so the change remains not-safe.
      repo.git('mv', 'src/core/doomed.ts', 'src/core/renamed.ts');
      repo.git('commit', '-q', '-m', 'rename core file');
      //                               ao     do     gs     so     st     vt     simt   cvgt   spt    dept
      expect(repo.scope()).toEqual(
        F(false, false, false, false, false, true, true, true, false, false),
      );
    },
  );

  it.skipIf(!hasBash)(
    'CRIT-4: cross-surface rename src/core→docs exposes old path via --no-renames',
    () => {
      const repo = makeRepo();
      repo.write('README.md', '# seed\n');
      repo.write('src/core/doomed.ts', 'export const d = 1;\n');
      repo.git('add', '.');
      repo.git('commit', '-q', '-m', 'seed');
      repo.git('branch', '-M', 'main');
      repo.git('checkout', '-q', '-b', 'feature');
      // Rename across surfaces: src/core/doomed.ts -> docs/doomed.md.
      // git mv triggers rename detection so `git diff --name-only` (without
      // --no-renames) shows only the NEW path `docs/doomed.md` and suppresses
      // the old `src/core/doomed.ts`. That would make the classifier emit
      // docs_only=true and silently bypass all gates. With --no-renames BOTH
      // endpoints appear, the src/core path forces gameplay_safe=false / sim_touched.
      // Create the destination directory first (git mv doesn't auto-create it).
      mkdirSync(path.join(repo.dir, 'docs'), { recursive: true });
      repo.git('mv', 'src/core/doomed.ts', 'docs/doomed.md');
      repo.git('commit', '-q', '-m', 'cross-surface rename via git mv');
      //                               ao     do     gs     so     st     vt     simt   cvgt   spt    dept
      expect(repo.scope()).toEqual(
        F(false, false, false, false, false, true, true, true, false, false),
      );
    },
  );
});
