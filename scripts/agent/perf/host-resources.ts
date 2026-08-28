#!/usr/bin/env tsx
/**
 * host-resources.ts — sample host CPU/memory/pressure utilization and report it.
 *
 * WHY
 * ---
 * Cloud agent sessions and GitHub-hosted runners had no way to answer "am I
 * using the machine I was given?" (issue #3800). This CLI samples the host (and
 * the cgroup slice, when containerized) on an interval and writes a JSON report
 * plus an optional markdown summary for a GitHub job summary.
 *
 * USAGE
 * -----
 *   npm run host:profile -- --once
 *       One-shot inventory + a short two-snapshot CPU measurement.
 *
 *   npm run host:profile -- --duration 120 --label unit-tests
 *       Sample for 120s, then write the report.
 *
 *   npm run host:profile -- --label e2e &   # stop with SIGTERM/SIGINT
 *       Sample until signalled; the report is written on the way out.
 *
 * Samples are appended to a JSONL sidecar as they are taken, so a job that is
 * hard-killed (timeout, cancellation, runner loss) still leaves usable data
 * behind — `--from-jsonl` rebuilds a report from whatever was flushed.
 *
 * This is telemetry, never a gate: it exits 0 unless its own arguments are
 * invalid, and it never fails a job for resource usage.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  buildReport,
  collectHostInfo,
  collectSample,
  formatHeadline,
  formatMarkdownSummary,
  readRunContext,
  type HostInfo,
  type HostReaders,
  type HostReport,
  type HostSample,
  type SamplerState,
} from './host-resources-lib.js';

/** Parsed CLI options. */
export interface CliOptions {
  readonly once: boolean;
  readonly intervalMs: number;
  readonly durationSec: number | null;
  readonly out: string;
  readonly jsonl: string;
  readonly markdown: string | null;
  readonly stepSummary: boolean;
  readonly label: string;
  readonly diskPath: string;
  readonly fromJsonl: boolean;
  readonly quiet: boolean;
  /**
   * Optional file whose appearance stops sampling. Signals do not reliably
   * reach a `tsx`-launched process through an npm/npx wrapper in a composite
   * action, so background CI use stops the sampler by creating this file.
   */
  readonly stopFile: string | null;
  /** Print a single-line summary instead of the markdown table. */
  readonly headline: boolean;
}

const DEFAULT_INTERVAL_MS = 5000;
/** Two snapshots this far apart give `--once` a real CPU rate, not a null. */
const ONCE_SAMPLE_WINDOW_MS = 300;
const MIN_INTERVAL_MS = 200;

/** Parse argv (everything after the script name). Throws on invalid input. */
export function parseArgs(argv: readonly string[]): CliOptions {
  let once = false;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let durationSec: number | null = null;
  let out = 'files/host-resources.json';
  let jsonl: string | null = null;
  let markdown: string | null = null;
  let stepSummary = false;
  let label = 'host';
  let diskPath = process.cwd();
  let fromJsonl = false;
  let quiet = false;
  let stopFile: string | null = null;
  let headline = false;

  const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined) throw new Error(`${flag} requires a value`);
    return value;
  };
  const requirePositive = (flag: string, value: string | undefined, min = 0): number => {
    const parsed = Number(requireValue(flag, value));
    if (!Number.isFinite(parsed) || parsed < min) {
      throw new Error(`${flag} requires a number >= ${min}`);
    }
    return parsed;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--once':
        once = true;
        break;
      case '--interval':
        intervalMs = requirePositive('--interval', argv[++i], MIN_INTERVAL_MS);
        break;
      case '--duration':
        durationSec = requirePositive('--duration', argv[++i], 0);
        break;
      case '--out':
        out = requireValue('--out', argv[++i]);
        break;
      case '--jsonl':
        jsonl = requireValue('--jsonl', argv[++i]);
        break;
      case '--markdown':
        markdown = requireValue('--markdown', argv[++i]);
        break;
      case '--step-summary':
        stepSummary = true;
        break;
      case '--label':
        label = requireValue('--label', argv[++i]);
        break;
      case '--disk-path':
        diskPath = requireValue('--disk-path', argv[++i]);
        break;
      case '--from-jsonl':
        fromJsonl = true;
        break;
      case '--quiet':
        quiet = true;
        break;
      case '--headline':
        headline = true;
        break;
      case '--stop-file':
        stopFile = requireValue('--stop-file', argv[++i]);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    once,
    intervalMs,
    durationSec,
    out,
    jsonl: jsonl ?? `${out.replace(/\.json$/, '')}.samples.jsonl`,
    markdown,
    stepSummary,
    label,
    diskPath,
    fromJsonl,
    quiet,
    stopFile,
    headline,
  };
}

/** Real-host readers. Every filesystem read fails soft to null. */
export function createDefaultReaders(): HostReaders {
  return {
    readText: (filePath) => {
      try {
        return readFileSync(filePath, 'utf8');
      } catch {
        return null;
      }
    },
    cpus: () => os.cpus().map((cpu) => ({ model: cpu.model, times: cpu.times })),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    loadavg: () => os.loadavg(),
    platform: () => process.platform,
    arch: () => process.arch,
    statfs: (target) => {
      try {
        const stats = statfsSync(target);
        return {
          blockSizeBytes: Number(stats.bsize),
          totalBlocks: Number(stats.blocks),
          freeBlocks: Number(stats.bfree),
          availableBlocks: Number(stats.bavail),
        };
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
    env: (name) => process.env[name],
  };
}

function ensureDir(filePath: string): void {
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

/** Write atomically so a killed process never leaves a half-written report. */
function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDir(filePath);
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, filePath);
}

/** Read back whatever samples were flushed to the JSONL sidecar. */
export function readSamplesFromJsonl(text: string): HostSample[] {
  const samples: HostSample[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      samples.push(JSON.parse(trimmed) as HostSample);
    } catch {
      // A hard kill can truncate the final line; keep every complete sample.
    }
  }
  return samples;
}

function emitReport(report: HostReport, options: CliOptions): void {
  writeJsonAtomic(options.out, report);
  const markdown = formatMarkdownSummary(report);
  if (options.markdown) {
    ensureDir(options.markdown);
    writeFileSync(options.markdown, markdown);
  }
  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (options.stepSummary && stepSummaryPath) {
    appendFileSync(stepSummaryPath, `${markdown}\n`);
  }
  if (!options.quiet) {
    process.stdout.write(options.headline ? `${formatHeadline(report)}\n` : markdown);
  }
}

async function run(options: CliOptions): Promise<void> {
  const readers = createDefaultReaders();
  const host: HostInfo = collectHostInfo(readers, options.diskPath);
  const context = readRunContext(readers, options.label);
  const startedAt = new Date(readers.now()).toISOString();

  if (options.fromJsonl) {
    const raw = (() => {
      try {
        return readFileSync(options.jsonl, 'utf8');
      } catch {
        return '';
      }
    })();
    const samples = readSamplesFromJsonl(raw);
    emitReport(
      buildReport({
        startedAt: samples[0]?.timestamp ?? startedAt,
        endedAt: samples[samples.length - 1]?.timestamp ?? startedAt,
        intervalMs: options.intervalMs,
        context,
        host,
        samples,
      }),
      options,
    );
    return;
  }

  const samples: HostSample[] = [];
  let state: SamplerState | null = null;

  ensureDir(options.jsonl);
  writeFileSync(options.jsonl, '');

  const tick = (): void => {
    // Guard against a stop landing right after a tick: a sub-interval delta
    // turns CPU percent into noise, so skip rather than record a bogus rate.
    if (state !== null && readers.now() - state.atMs < MIN_INTERVAL_MS) return;
    const result = collectSample(readers, host, state, options.diskPath);
    const priming = state === null;
    state = result.state;
    // The first read only primes the cumulative counters: every rate field is
    // null by construction, so it is not a real observation and is not emitted.
    if (priming) return;
    samples.push(result.sample);
    try {
      appendFileSync(options.jsonl, `${JSON.stringify(result.sample)}\n`);
    } catch {
      // Telemetry must never take a job down; a failed flush is not fatal.
    }
  };

  tick();

  if (options.once) {
    await delay(ONCE_SAMPLE_WINDOW_MS);
    tick();
  } else {
    await sampleUntilDone(tick, options);
  }

  emitReport(
    buildReport({
      startedAt,
      endedAt: new Date(readers.now()).toISOString(),
      intervalMs: options.intervalMs,
      context,
      host,
      samples,
    }),
    options,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Sample on an interval until the duration elapses, the stop file appears, or
 * a stop signal arrives.
 */
function sampleUntilDone(tick: () => void, options: CliOptions): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let durationTimer: NodeJS.Timeout | undefined;

    const stop = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(durationTimer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      tick();
      resolve();
    };

    const timer = setInterval(() => {
      tick();
      if (options.stopFile !== null && existsSync(options.stopFile)) stop();
    }, options.intervalMs);

    if (options.durationSec !== null && options.durationSec > 0) {
      durationTimer = setTimeout(stop, options.durationSec * 1000);
    }

    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`host-resources: ${(error as Error).message}\n`);
    process.exit(2);
  }
}
