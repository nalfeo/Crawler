#!/usr/bin/env node
/**
 * Find the release baseline that was in effect when a branch forked from main.
 *
 * Every successful GitHub Pages deploy from main runs a 100-seed win-rate
 * sweep and commits the result to the `baselines` branch at
 * `by-sha/<commit-sha>.json`, plus an `index.json` sorted newest-first by
 * commit date. This tool answers: "for a given ref, what baseline should I
 * compare against?"
 *
 * Algorithm:
 *   1. Fetch `origin/baselines` (unless --no-fetch).
 *   2. Read `index.json` from that branch.
 *   3. Determine the branch-off point: `git merge-base origin/main <ref>`.
 *   4. Walk `main` history from that point backwards (in first-parent order)
 *      and return the newest baseline whose commit appears in the walk.
 *      This is robust when not every main commit has a baseline (e.g., the
 *      deploy failed, the sweep failed, or the commit predates the workflow).
 *
 * Usage:
 *   node scripts/agent/perf/find-baseline.mjs [--ref HEAD] [--json] [--no-fetch]
 *   npm run perf:find-baseline -- --ref my-feature-branch
 *
 * Exit codes:
 *   0  found a baseline (prints summary or JSON to stdout)
 *   1  no baseline found within the walk window
 *   2  usage / setup error
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';

function parseArgs() {
  const args = {
    ref: 'HEAD',
    json: false,
    fetch: true,
    maxWalk: 500,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--ref' && next) {
      args.ref = next;
      i++;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--no-fetch') {
      args.fetch = false;
    } else if (a === '--max-walk' && next) {
      args.maxWalk = parseInt(next, 10);
      i++;
    } else if (a === '-h' || a === '--help') {
      console.log('Usage: find-baseline [--ref REF] [--json] [--no-fetch] [--max-walk N]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { encoding: 'utf8' }).trim();
}

function gitOrNull(...gitArgs) {
  try {
    return git(...gitArgs);
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs();

  if (args.fetch) {
    try {
      execFileSync('git', ['fetch', '--quiet', 'origin', 'main', 'baselines'], {
        stdio: 'inherit',
      });
    } catch {
      // fall back to fetching just baselines; main may already be up to date
      // (or the remote may be missing one of them — surface later if fatal).
      try {
        execFileSync('git', ['fetch', '--quiet', 'origin', 'baselines'], {
          stdio: 'inherit',
        });
      } catch (e) {
        console.error('warning: could not fetch origin/baselines:', String(e));
      }
    }
  }

  const mainRef = gitOrNull('rev-parse', '--verify', 'origin/main') ?? 'main';
  const baselinesRef =
    gitOrNull('rev-parse', '--verify', 'origin/baselines') ??
    gitOrNull('rev-parse', '--verify', 'baselines');
  if (!baselinesRef) {
    console.error(
      'error: no `baselines` branch found (locally or on origin). ' +
        'Baselines are populated by .github/workflows/deploy.yml after each release.',
    );
    process.exit(2);
  }

  const mergeBase = gitOrNull('merge-base', mainRef, args.ref);
  if (!mergeBase) {
    console.error(`error: could not compute merge-base(${mainRef}, ${args.ref})`);
    process.exit(2);
  }

  // Load index.json from the baselines branch without checking it out.
  let indexRaw;
  try {
    indexRaw = git('show', `${baselinesRef}:index.json`);
  } catch {
    console.error('error: baselines branch has no index.json');
    process.exit(2);
  }
  const index = JSON.parse(indexRaw);
  const byCommit = new Map();
  for (const entry of index) byCommit.set(entry.commit, entry);

  // Walk main history backwards from the branch-off point, following
  // first-parent so we stay on the release lineage.
  const walk = git('log', '--first-parent', '--format=%H', `-n`, String(args.maxWalk), mergeBase)
    .split('\n')
    .filter(Boolean);

  let found = null;
  let distance = 0;
  for (const sha of walk) {
    const hit = byCommit.get(sha);
    if (hit) {
      found = hit;
      break;
    }
    distance++;
  }

  if (!found) {
    console.error(
      `no baseline found within ${args.maxWalk} first-parent commits before ${mergeBase.slice(0, 12)}; ` +
        `retry with a larger --max-walk if this branch forked from an older main.`,
    );
    process.exit(1);
  }

  // Load the full baseline JSON (also from the baselines branch).
  const fullRaw = git('show', `${baselinesRef}:${found.path}`);
  const full = JSON.parse(fullRaw);

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ref: args.ref,
          mergeBase,
          baselineCommit: found.commit,
          commitsBehindMergeBase: distance,
          index: found,
          baseline: full,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const short = found.commit.slice(0, 12);
  const winPct = ((full.winRate ?? found.winRate) * 100).toFixed(1);
  console.log('Baseline for ref:      ' + args.ref);
  console.log('Merge-base w/ main:    ' + mergeBase.slice(0, 12));
  console.log('Baseline commit:       ' + short + ' (' + distance + ' commits before merge-base)');
  console.log('Subject:               ' + (found.commitSubject ?? ''));
  console.log('Captured:              ' + (found.capturedAt ?? ''));
  console.log(
    'Win rate:              ' + winPct + '% (' + full.totalWins + '/' + full.totalRuns + ')',
  );
  if (found.runUrl) console.log('Run:                   ' + found.runUrl);
  console.log('Path on baselines:     ' + found.path);
  console.log('');
  console.log('To load full baseline JSON:');
  console.log('  git show ' + baselinesRef.slice(0, 12) + ':' + found.path);
}

main();
