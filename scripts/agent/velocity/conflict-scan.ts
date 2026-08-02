/**
 * Conflict scan — turns "which files keep colliding?" into a tracked number.
 *
 * Crawler merges many PRs per day, all squash-merged onto `main`. When two
 * merged commits touch the same file on the same day, that is a useful proxy
 * for coordination pressure on shared files. The metric below tracks that
 * same-day co-touch proxy from committed history alone, so it can be
 * recomputed identically at any time and compared across windows. It is
 * observational: not every co-touch required a rebase, and not every rebase
 * appears as a same-day co-touch.
 *
 * Definitions (all per file, per calendar day, on first-parent `main` history):
 *   touches        commits in the window that modified the file
 *   overlap events for a (file, day) touched by N distinct commits: N - 1
 *                  (the first touch is free; each later touch is additional
 *                  same-day co-touch on the mainline)
 *   overlap rate   overlap events ÷ touches
 *
 * The rate is reported separately for **source** files and **non-source**
 * files (docs, JSON, config). A high non-source rate often points to shared
 * aggregates or config hot spots, but the hottest files still need inspection
 * before deciding whether to derive/shard them or refactor the surrounding
 * workflow.
 *
 *   npm run velocity:conflict-scan -- [--days 120] [--top 20]
 *                                     [--out files/velocity-conflicts.json]
 *                                     [--max-nonsource-rate 3]
 *
 * `--max-nonsource-rate` turns the scan into a policy gate on this proxy: the
 * process exits 1 when the non-source overlap rate (in percent) exceeds the
 * given threshold. Without it the scan is purely observational and always
 * exits 0.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Extensions treated as source code. Everything else is an artifact. */
const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.sh',
  '.ps1',
  '.py',
  '.css',
  '.html',
] as const;

/** One squash-merge commit, reduced to what the metric needs. */
export interface CommitTouch {
  sha: string;
  /** Calendar day of the commit, `YYYY-MM-DD`, in the timezone git reported. */
  day: string;
  /** Repo-relative paths modified by the commit. */
  files: string[];
}

export interface FileOverlap {
  path: string;
  category: 'source' | 'non-source';
  touches: number;
  overlapEvents: number;
  /** Number of distinct days on which the file was touched more than once. */
  contendedDays: number;
}

export interface CategoryTotals {
  touches: number;
  overlapEvents: number;
  /** Overlap events ÷ touches, expressed as a percentage (0–100). */
  overlapRatePct: number;
}

export interface ConflictReport {
  schema: 'crawler-velocity-conflicts/v1';
  generatedAt: string;
  windowDays: number;
  commitsAnalyzed: number;
  filesTouched: number;
  overall: CategoryTotals;
  source: CategoryTotals;
  nonSource: CategoryTotals;
  /** Worst offenders by overlap events, descending. */
  top: FileOverlap[];
  findings: string[];
}

const KNOWN_AGGREGATE_PATHS = [/^docs\/knowledge\/handoffs\/INDEX\.md$/] as const;

export function classify(path: string): 'source' | 'non-source' {
  const lower = path.toLowerCase();
  return SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext)) ? 'source' : 'non-source';
}

export function isKnownAggregatePath(path: string): boolean {
  return KNOWN_AGGREGATE_PATHS.some((pattern) => pattern.test(path));
}

/**
 * Parse `git log --name-only` output in the exact format `collectCommits` asks
 * for: a `\x01`-prefixed header line per commit (`\x01<sha>\t<YYYY-MM-DD>`),
 * followed by one path per line.
 *
 * Tolerant by design — history is data, and one malformed record should never
 * sink a 120-day scan.
 */
export function parseGitLog(raw: string): CommitTouch[] {
  const commits: CommitTouch[] = [];
  let current: CommitTouch | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('\x01')) {
      const [sha, date] = line.slice(1).split('\t');
      if (!sha || !date) {
        current = null;
        continue;
      }
      current = { sha, day: date.slice(0, 10), files: [] };
      commits.push(current);
      continue;
    }
    const path = line.trim();
    if (path.length === 0 || current === null) continue;
    current.files.push(path);
  }

  return commits;
}

/**
 * Reduce commits to per-file overlap counts.
 *
 * A file touched twice by the *same* commit (impossible in git, but rename
 * records can duplicate a path) counts once, so overlap can never be inflated
 * by a single session.
 */
export function computeOverlaps(commits: readonly CommitTouch[]): FileOverlap[] {
  // path → day → set of commit shas
  const byFile = new Map<string, Map<string, Set<string>>>();

  for (const commit of commits) {
    for (const path of new Set(commit.files)) {
      let days = byFile.get(path);
      if (!days) {
        days = new Map();
        byFile.set(path, days);
      }
      const shas = days.get(commit.day) ?? new Set<string>();
      shas.add(commit.sha);
      days.set(commit.day, shas);
    }
  }

  const overlaps: FileOverlap[] = [];
  for (const [path, days] of byFile) {
    let touches = 0;
    let overlapEvents = 0;
    let contendedDays = 0;
    for (const shas of days.values()) {
      touches += shas.size;
      if (shas.size > 1) {
        overlapEvents += shas.size - 1;
        contendedDays++;
      }
    }
    overlaps.push({ path, category: classify(path), touches, overlapEvents, contendedDays });
  }

  return overlaps.sort(
    (a, b) =>
      b.overlapEvents - a.overlapEvents || b.touches - a.touches || a.path.localeCompare(b.path),
  );
}

function totals(overlaps: readonly FileOverlap[]): CategoryTotals {
  const touches = overlaps.reduce((sum, o) => sum + o.touches, 0);
  const overlapEvents = overlaps.reduce((sum, o) => sum + o.overlapEvents, 0);
  return {
    touches,
    overlapEvents,
    overlapRatePct: touches === 0 ? 0 : (overlapEvents / touches) * 100,
  };
}

export function deriveFindings(report: Omit<ConflictReport, 'findings'>): string[] {
  const findings: string[] = [];

  findings.push(
    `Non-source overlap rate is ${report.nonSource.overlapRatePct.toFixed(1)}% ` +
      `(${report.nonSource.overlapEvents} events / ${report.nonSource.touches} touches); ` +
      `source is ${report.source.overlapRatePct.toFixed(1)}%.`,
  );

  if (report.nonSource.overlapRatePct > report.source.overlapRatePct) {
    findings.push(
      'Non-source files co-touch more often than code does. Review the hottest non-source ' +
        'paths first: generated aggregates often want deriving or sharding, while ' +
        'hand-authored config can reflect real coordination work.',
    );
  }

  const worstNonSource = report.top.find((o) => o.category === 'non-source');
  if (worstNonSource && worstNonSource.overlapEvents > 0) {
    findings.push(
      `Worst non-source file: ${worstNonSource.path} — ${worstNonSource.overlapEvents} overlap events ` +
        `across ${worstNonSource.contendedDays} contended days. ` +
        (isKnownAggregatePath(worstNonSource.path)
          ? 'Because this is a known aggregate, prefer deriving, sharding, or leaving it uncommitted.'
          : 'Inspect whether it is generated shared output or hand-authored config before changing structure.'),
    );
  }

  const worstSource = report.top.find((o) => o.category === 'source');
  if (worstSource && worstSource.overlapEvents > 0) {
    findings.push(
      `Worst source file: ${worstSource.path} — ${worstSource.overlapEvents} overlap events. ` +
        'Decomposition only pays here if the rate stays high after the aggregates are fixed.',
    );
  }

  return findings;
}

export function buildReport(
  commits: readonly CommitTouch[],
  windowDays: number,
  now: string,
  topCount = 20,
): ConflictReport {
  const overlaps = computeOverlaps(commits);
  const base = {
    schema: 'crawler-velocity-conflicts/v1' as const,
    generatedAt: now,
    windowDays,
    commitsAnalyzed: commits.length,
    filesTouched: overlaps.length,
    overall: totals(overlaps),
    source: totals(overlaps.filter((o) => o.category === 'source')),
    nonSource: totals(overlaps.filter((o) => o.category === 'non-source')),
    top: overlaps.filter((o) => o.overlapEvents > 0).slice(0, topCount),
  };
  return { ...base, findings: deriveFindings(base) };
}

/** Read first-parent `main` history for the window, as `CommitTouch` records. */
export function resolveMainlineRef(root: string): string {
  for (const ref of ['refs/remotes/origin/main', 'origin/main', 'refs/heads/main', 'main']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
        cwd: root,
        stdio: 'ignore',
      });
      return ref;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('Could not resolve a mainline ref. Expected origin/main or main.');
}

export function collectCommits(root: string, days: number): CommitTouch[] {
  const mainlineRef = resolveMainlineRef(root);
  const raw = execFileSync(
    'git',
    [
      'log',
      mainlineRef,
      '--first-parent',
      `--since=${days} days ago`,
      '--no-renames',
      '--pretty=format:\x01%H\t%cs',
      '--name-only',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return parseGitLog(raw);
}

export function render(report: ConflictReport): string {
  const lines: string[] = [];
  lines.push(
    `\nSame-day file co-touch proxy — ${report.commitsAnalyzed} commits over ${report.windowDays} days ` +
      `(${report.filesTouched} files)\n`,
  );
  const row = (label: string, t: CategoryTotals) =>
    `  ${label.padEnd(11)} ${t.overlapRatePct.toFixed(1).padStart(5)}%  ` +
    `(${t.overlapEvents} overlap events / ${t.touches} touches)`;
  lines.push(row('overall', report.overall));
  lines.push(row('source', report.source));
  lines.push(row('non-source', report.nonSource));

  if (report.top.length > 0) {
    lines.push('\nTop contended files:');
    for (const file of report.top) {
      lines.push(
        `  ${String(file.overlapEvents).padStart(4)}  ${file.category.padEnd(10)}  ` +
          `${file.path} (${file.touches} touches, ${file.contendedDays} contended days)`,
      );
    }
  }

  lines.push('\nFindings:');
  for (const finding of report.findings) lines.push(`  • ${finding}`);
  lines.push('');
  return lines.join('\n');
}

function readFlagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;

  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }

  return value;
}

function parseNumberFlag(argv: readonly string[], name: string, fallback?: number): number | undefined {
  const raw = readFlagValue(argv, name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} must be a finite number`);
  }

  return value;
}

export function isDirectExecution(argvEntry: string | undefined, moduleUrl: string): boolean {
  return Boolean(argvEntry) && moduleUrl === pathToFileURL(argvEntry).href;
}

function main(): void {
  const argv = process.argv.slice(2);
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const days = parseNumberFlag(argv, 'days', 120) ?? 120;
  const top = parseNumberFlag(argv, 'top', 20) ?? 20;
  const report = buildReport(collectCommits(root, days), days, new Date().toISOString(), top);

  const out = resolve(root, readFlagValue(argv, 'out') ?? 'files/velocity-conflicts.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(render(report));
  process.stdout.write(`Report → ${out}\n`);

  const max = parseNumberFlag(argv, 'max-nonsource-rate');
  if (max !== undefined && report.nonSource.overlapRatePct > max) {
    process.stderr.write(
      `\n✗ non-source overlap rate ${report.nonSource.overlapRatePct.toFixed(1)}% exceeds ${max}%\n`,
    );
    process.exitCode = 1;
  }
}

if (isDirectExecution(process.argv[1], import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `velocity:conflict-scan crashed: ${error instanceof Error ? error.message : error}\n`,
    );
    process.exitCode = 2;
  }
}
