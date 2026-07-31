#!/usr/bin/env node
/**
 * `npm run perf:profile` — CPU-profile the headless simulation and rank where
 * the time actually goes.
 *
 * This is the attribution gate for the perf-optimizer skill (SKILL.md step 3).
 * Run it BEFORE choosing an optimization target so you can record the target's
 * share and the Amdahl ceiling on any win, rather than optimizing whatever
 * looked slow.
 *
 * WHAT IT COVERS
 * --------------
 * The headless runner executes the **simulation only** — no renderer, no DOM,
 * no asset loading, no browser GC. It is the right instrument for steady-state
 * simulation cost and the wrong one for render or load work; for those, take a
 * Chrome DevTools trace against `npm run dev` instead (see
 * `references/measurement-recipes.md`).
 *
 * USAGE
 * -----
 *   npm run perf:profile
 *   npm run perf:profile -- --seeds 1-3 --weapons sword --top 30
 *   npm run perf:profile -- --sort total          # rank by call-tree cost
 *   npm run perf:profile -- --json                # machine-readable
 *   npm run perf:profile -- --ceiling 2.9:3       # Amdahl helper, no profiling
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatSummary,
  mergeSummaries,
  predictCeiling,
  summarizeProfile,
  type CpuProfile,
  type ProfileSummary,
} from './profile-analyze-lib.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// `files/` is gitignored, so profiles never risk being committed.
const PROFILE_ROOT = path.join(REPO_ROOT, 'files', 'perf-profiles');
const HEADLESS_CLI = path.join(REPO_ROOT, 'src', 'game', 'ai', 'headless-runner-cli.ts');

/**
 * Outcomes the headless CLI prints (`Outcome: <VALUE>`) when a run terminated
 * normally — win or lose. `error` is deliberately excluded: it means the
 * simulation threw mid-run, which yields a truncated, unrepresentative profile.
 *
 * Source of truth: `RunStats['outcome']` in `src/game/ai/types.ts`.
 */
const HEALTHY_OUTCOMES = new Set(['VICTORY', 'DEATH', 'TIMEOUT', 'STALLED']);

/** How a headless run terminated, as far as profile validity is concerned. */
export type RunTermination =
  /** Reached a normal end — win or lose. Its profile is representative. */
  | { readonly kind: 'healthy'; readonly outcome: string }
  /** Reported `Outcome: ERROR` — the simulation threw partway through. */
  | { readonly kind: 'errored'; readonly outcome: string }
  /** Never printed an `Outcome:` line at all — it died before finishing. */
  | { readonly kind: 'missing' };

/**
 * Decide whether a headless run's profile is worth trusting, from its stdout.
 *
 * This exists because exit code cannot answer the question: the headless CLI
 * exits non-zero to mean "the AI did not win", which is a perfectly valid thing
 * to profile. Only the reported outcome separates "lost" from "broke".
 */
export function classifyRunTermination(stdout: string): RunTermination {
  const outcome = /^Outcome:\s+(\S+)/m.exec(stdout)?.[1];
  if (outcome === undefined) return { kind: 'missing' };
  return HEALTHY_OUTCOMES.has(outcome.toUpperCase())
    ? { kind: 'healthy', outcome }
    : { kind: 'errored', outcome };
}

function isMainThreadProfile(fileName: string): boolean {
  const parts = fileName.replace(/\.cpuprofile$/, '').split('.');
  return parts.length === 6 && parts[4] === '0';
}

export function selectMainThreadProfile(files: readonly string[]): string {
  if (files.length === 1) {
    return files[0]!;
  }

  const mainThreadProfiles = files.filter(isMainThreadProfile);
  if (mainThreadProfiles.length === 1) {
    return mainThreadProfiles[0]!;
  }

  throw new Error(
    `Expected exactly 1 .cpuprofile but found ${files.length}: ${files.join(', ')}` +
      ` (could not isolate main-thread profile: found ${mainThreadProfiles.length} candidate(s) with worker-ID 0)`,
  );
}

interface Options {
  seeds: number[];
  weapons: string[];
  top: number;
  sortBy: 'self' | 'total';
  json: boolean;
  /** Optional file target for `--json <path>`; stdout when absent. */
  jsonPath: string | null;
  keep: boolean;
  maxFrames: number | null;
}

function parseSeeds(spec: string): number[] {
  const seeds: number[] = [];
  for (const part of spec.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(part.trim());
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (end < start) throw new Error(`Invalid seed range "${part}": end is before start`);
      for (let s = start; s <= end; s += 1) seeds.push(s);
      continue;
    }
    const single = Number(part.trim());
    if (!Number.isInteger(single) || single < 0) {
      throw new Error(`Invalid seed "${part}" — expected an integer or a range like 1-3`);
    }
    seeds.push(single);
  }
  if (seeds.length === 0) throw new Error('No seeds parsed from --seeds');
  return seeds;
}

export function parseArgs(argv: readonly string[]): Options | { ceiling: [number, number] } {
  const options: Options = {
    // Three seeds by default: one run overfits to a single route and combat
    // sequence, which is how you end up optimizing a seed rather than the game.
    seeds: [1, 2, 3],
    weapons: ['sword'],
    top: 25,
    sortBy: 'self',
    json: false,
    jsonPath: null,
    keep: false,
    maxFrames: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--seeds':
        options.seeds = parseSeeds(next());
        break;
      case '--weapons':
        options.weapons = next()
          .split(',')
          .map((w) => w.trim())
          .filter((w) => w.length > 0);
        break;
      case '--top':
        options.top = Number(next());
        break;
      case '--sort': {
        const value = next();
        if (value !== 'self' && value !== 'total') {
          throw new Error(`--sort must be "self" or "total", got "${value}"`);
        }
        options.sortBy = value;
        break;
      }
      case '--max-frames': {
        const rawFrames = Number(next());
        if (!Number.isInteger(rawFrames) || rawFrames <= 0) {
          throw new Error('--max-frames must be a positive integer');
        }
        options.maxFrames = rawFrames;
        break;
      }
      case '--json':
        options.json = true;
        // Optional path: `--json` alone writes to stdout, `--json <path>`
        // writes a file. Only consume the next token if it is not a flag.
        if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')) {
          options.jsonPath = argv[++i]!;
        }
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--ceiling': {
        const value = next();
        const match = /^([\d.]+):([\d.]+|inf|Infinity)$/.exec(value);
        if (!match) {
          throw new Error(`--ceiling expects <sharePct>:<speedup>, e.g. 2.9:3 — got "${value}"`);
        }
        const speedupRaw = match[2]!;
        const speedup =
          speedupRaw === 'inf' || speedupRaw === 'Infinity' ? Infinity : Number(speedupRaw);
        return { ceiling: [Number(match[1]), speedup] };
      }
      case '--help':
      case '-h':
        console.log(
          [
            'Usage: npm run perf:profile -- [options]',
            '',
            '  --seeds <spec>       seeds to profile (default 1-3; "1,4" or "1-3" both work)',
            '  --weapons <list>     comma-separated weapons (default sword)',
            '  --max-frames <n>     cap simulated frames per run',
            '  --top <n>            rows to print (default 25)',
            '  --sort self|total    rank by own body cost or by call-tree cost (default self)',
            '  --json [path]        emit the full summary as JSON (stdout, or to a file)',
            '  --keep               keep the raw .cpuprofile files under files/perf-profiles/',
            '  --ceiling <s>:<x>    print the Amdahl ceiling for share s% at speedup x, then exit',
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument "${arg}" (try --help)`);
    }
  }
  if (!Number.isInteger(options.top) || options.top <= 0) {
    throw new Error('--top must be a positive integer');
  }
  if (options.weapons.length === 0) throw new Error('No weapons parsed from --weapons');
  return options;
}

function profileOneRun(
  seed: number,
  weapon: string,
  options: Options,
  dir: string,
): ProfileSummary {
  mkdirSync(dir, { recursive: true });
  const args = [
    '--cpu-prof',
    `--cpu-prof-dir=${dir}`,
    '--import',
    'tsx',
    HEADLESS_CLI,
    '--seed',
    String(seed),
    '--weapon',
    weapon,
  ];
  if (options.maxFrames !== null) args.push('--max-frames', String(options.maxFrames));

  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // The runner is chatty on stdout; capture both streams so a genuine crash
    // is diagnosable, and print neither on the happy path.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = result.stdout ?? '';
  const fail = (reason: string): never => {
    throw new Error(
      `${reason} (seed=${seed} weapon=${weapon}, exit ${result.status ?? 'null'}` +
        `${result.signal ? `, signal ${result.signal}` : ''})\n` +
        `--- stderr ---\n${result.stderr ?? ''}\n` +
        `--- stdout (tail) ---\n${stdout.slice(-2000)}`,
    );
  };

  if (result.error) fail(`Could not spawn the headless runner: ${result.error.message}`);

  const emitted = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.cpuprofile')) : [];
  if (emitted.length === 0) {
    fail('No .cpuprofile emitted — does this Node build support --cpu-prof?');
  }

  // A non-zero exit is NOT a failure here: the headless CLI uses its exit code
  // to report whether the AI *won the run*, and a losing or frame-capped run is
  // still a perfectly good sample of where time goes.
  //
  // But V8 writes a profile on *any* process exit, so "a file exists" alone
  // would happily summarize a run that died as if it were real data — exactly
  // the wrong-target failure this tool exists to prevent. Gate on the reported
  // outcome instead, which separates "lost" from "broke":
  //   - no `Outcome:` line  -> crashed before finishing (e.g. a bad --weapons)
  //   - `Outcome: ERROR`    -> the simulation threw mid-run
  // Both leave a truncated, startup-dominated profile.
  const outcome = classifyRunTermination(stdout);
  if (outcome.kind === 'missing') {
    fail(
      'The headless runner never reported an Outcome, so it crashed before finishing. ' +
        'Its profile would be mostly startup and is being rejected',
    );
  } else if (outcome.kind === 'errored') {
    fail(
      `The headless run ended with Outcome: ${outcome.outcome} — the simulation threw ` +
        'mid-run, so its profile is truncated and is being rejected',
    );
  }

  let profileFile!: string;
  try {
    profileFile = selectMainThreadProfile(emitted);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (emitted.length > 1 && isMainThreadProfile(profileFile) && !options.json) {
    console.error(
      `  note: ${emitted.length - 1} tsx worker-thread profile(s) discarded; using main-thread profile`,
    );
  }

  const profile = JSON.parse(readFileSync(path.join(dir, profileFile), 'utf8')) as CpuProfile;
  return summarizeProfile(profile);
}

function main(): void {
  let parsed: Options | { ceiling: [number, number] };
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`perf:profile — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if ('ceiling' in parsed) {
    const [share, speedup] = parsed.ceiling;
    let ceiling: number;
    try {
      ceiling = predictCeiling(share, speedup);
    } catch (error) {
      console.error(`perf:profile — ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    console.log(
      `A component at ${share}% of total, made ${speedup === Infinity ? 'free' : `${speedup}x faster`}, ` +
        `can win at most ${ceiling.toFixed(2)}% end-to-end.`,
    );
    return;
  }

  const options = parsed;
  const runId = `run-${Date.now()}`;
  const runRoot = path.join(PROFILE_ROOT, runId);
  const summaries: ProfileSummary[] = [];

  try {
    for (const weapon of options.weapons) {
      for (const seed of options.seeds) {
        const label = `${weapon}-${seed}`;
        if (!options.json) console.error(`profiling ${label}...`);
        summaries.push(profileOneRun(seed, weapon, options, path.join(runRoot, label)));
      }
    }

    const merged = mergeSummaries(summaries);

    if (options.json) {
      const payload = JSON.stringify(merged, null, 2);
      if (options.jsonPath) {
        const target = path.resolve(REPO_ROOT, options.jsonPath);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, `${payload}\n`, 'utf8');
        console.error(`wrote ${target}`);
      } else {
        console.log(payload);
      }
    } else {
      console.log('');
      console.log(formatSummary(merged, { top: options.top, sortBy: options.sortBy }));
      console.log('');
      console.log(
        "self%  = time in the function's own body (finds hot leaves)\n" +
          'total% = time in its whole call tree (finds expensive subsystems)\n' +
          'Pick a target using BOTH, then record its share and the ceiling on any win:\n' +
          '  npm run perf:profile -- --ceiling <share>:<speedup>\n' +
          'Simulation only — no renderer, assets, or browser GC. For render/load work,\n' +
          'take a Chrome DevTools trace against `npm run dev` instead.',
      );
    }
  } finally {
    if (!options.keep && existsSync(runRoot)) {
      rmSync(runRoot, { recursive: true, force: true });
    } else if (options.keep) {
      console.error(`raw profiles kept in ${path.relative(REPO_ROOT, runRoot)}`);
    }
  }
}

// Only run when invoked as a script, so the pure helpers above stay importable
// from tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
