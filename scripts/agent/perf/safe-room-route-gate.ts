#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SAFE_ROOM_FLAG_MS } from '../../../src/game/ai/scoring.js';

export const SAFE_ROOM_ROUTE_WEAPONS = [
  'sword',
  'bow',
  'baseball-bat',
  'pistol',
  'throwing-knife',
  'fireball',
] as const;

const EXPECTED_QUESTS = [
  'floor1-find-welcome',
  'floor1-tutorial',
  'floor1-boss-unlock',
  'floor1-meet-npcs',
  'floor1-shopkeeper-errand',
  'floor1-boss-battle',
  'floor1-leave-floor',
] as const;
const ACTIVE_TIME_LIMIT_MS = 360_000;
const MIN_OFFICIAL_WINS = 556;
const MAX_SAFE_ROOM_FLAGS = 11;
const BASELINE_SHA = 'a8e26a5189fd587c0abba2371f0d0d3387484344';
const BASELINE_SOURCE_RUN_IDS = [
  29165474387, 29165475085, 29165475795, 29165476582, 29165477259, 29165477837,
];
const BASELINE_CELL_DIGEST = 'aae52d26d38e04ca53008cb352590ac093700938d63be706d9abca0076f42c4c';

export interface SafeRoomBaselineManifest {
  baselineSha: string;
  sourceRunIds: number[];
  totalRuns: number;
  officialWins: number;
  safeRoomFlaggedCount: number;
  officialLossCells: string[];
  safeRoomFlagCells: string[];
}

export interface SafeRoomRouteRunMetric {
  weapon: string;
  seed: number;
  win: boolean;
  outcome: string;
  gameTimeMs: number;
  safeRoomMs: number;
  activeTimeMs: number;
  questLogAccepts: Record<string, number>;
  questLogCompletions: Record<string, number>;
  questsFailed: string[];
  safeRoomRouteActivations: number;
  safeRoomRouteCompletions: number;
  safeRoomRouteBlocked: number;
  safeRoomRouteReseeds: number;
}

interface SweepArtifact {
  metrics?: SafeRoomRouteRunMetric[];
}

export interface SafeRoomRouteGateResult {
  passed: boolean;
  baselineSha: string;
  totalRuns: number;
  officialWins: number;
  safeRoomFlaggedCount: number;
  maxSafeRoomMs: number;
  maxActiveTimeMs: number;
  newFlagsAmongBaselineWins: string[];
  anchorWins: Record<string, boolean>;
  routeLifecycle: {
    activations: number;
    completions: number;
    blocked: number;
    reseeds: number;
  };
  errors: string[];
}

function cellKey(row: Pick<SafeRoomRouteRunMetric, 'weapon' | 'seed'>): string {
  return `${row.weapon}:${row.seed}`;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function evaluateSafeRoomRouteGate(
  rows: readonly SafeRoomRouteRunMetric[],
  baseline: SafeRoomBaselineManifest,
): SafeRoomRouteGateResult {
  const errors: string[] = [];
  const expectedCells = new Set(
    SAFE_ROOM_ROUTE_WEAPONS.flatMap((weapon) =>
      Array.from({ length: 100 }, (_, index) => `${weapon}:${index + 1}`),
    ),
  );
  const seenCells = new Set<string>();
  const baselineLosses = new Set(baseline.officialLossCells);
  const baselineFlags = new Set(baseline.safeRoomFlagCells);
  const baselineCellDigest = createHash('sha256')
    .update(JSON.stringify([baseline.officialLossCells, baseline.safeRoomFlagCells]))
    .digest('hex');
  const candidateFlags = new Set<string>();
  let officialWins = 0;
  let maxSafeRoomMs = 0;
  let maxActiveTimeMs = 0;
  const routeLifecycle = { activations: 0, completions: 0, blocked: 0, reseeds: 0 };

  if (
    baseline.baselineSha !== BASELINE_SHA ||
    JSON.stringify(baseline.sourceRunIds) !== JSON.stringify(BASELINE_SOURCE_RUN_IDS) ||
    baselineCellDigest !== BASELINE_CELL_DIGEST ||
    baseline.totalRuns !== 600 ||
    baseline.officialWins !== 556 ||
    baseline.safeRoomFlaggedCount !== 11 ||
    baselineLosses.size !== 44 ||
    baselineFlags.size !== 11
  ) {
    errors.push('Baseline manifest does not match the immutable a8e26a51 artifact evidence.');
  }

  for (const row of rows) {
    const key = cellKey(row);
    if (!expectedCells.has(key)) {
      errors.push(`Unexpected candidate cell ${key}.`);
      continue;
    }
    if (seenCells.has(key)) {
      errors.push(`Duplicate candidate cell ${key}.`);
      continue;
    }
    seenCells.add(key);

    const derivedActiveTime = Math.max(0, row.gameTimeMs - row.safeRoomMs);
    if (Math.abs(derivedActiveTime - row.activeTimeMs) > 0.001) {
      errors.push(`${key} activeTimeMs does not match gameTimeMs - safeRoomMs.`);
    }
    const derivedWin = row.outcome === 'victory' && row.activeTimeMs < ACTIVE_TIME_LIMIT_MS;
    if (row.win !== derivedWin) {
      errors.push(
        `${key} stored official-win classification is not the strict active-time result.`,
      );
    }
    if (row.win) {
      officialWins += 1;
      const completions = new Set(Object.keys(row.questLogCompletions));
      const missingQuests = EXPECTED_QUESTS.filter((questId) => !completions.has(questId));
      if (missingQuests.length > 0 || row.questsFailed.length > 0) {
        errors.push(
          `${key} official win lacks legal quest completion: missing=${missingQuests.join(',') || 'none'} failed=${row.questsFailed.join(',') || 'none'}.`,
        );
      }
    }
    if (row.safeRoomMs > SAFE_ROOM_FLAG_MS) candidateFlags.add(key);
    maxSafeRoomMs = Math.max(maxSafeRoomMs, row.safeRoomMs);
    maxActiveTimeMs = Math.max(maxActiveTimeMs, row.activeTimeMs);

    const routeCounters = [
      row.safeRoomRouteActivations,
      row.safeRoomRouteCompletions,
      row.safeRoomRouteBlocked,
      row.safeRoomRouteReseeds,
    ];
    if (!routeCounters.every(isNonNegativeInteger)) {
      errors.push(`${key} is missing valid route-lifecycle counters.`);
    } else {
      routeLifecycle.activations += row.safeRoomRouteActivations;
      routeLifecycle.completions += row.safeRoomRouteCompletions;
      routeLifecycle.blocked += row.safeRoomRouteBlocked;
      routeLifecycle.reseeds += row.safeRoomRouteReseeds;
    }
  }

  for (const expectedCell of expectedCells) {
    if (!seenCells.has(expectedCell)) errors.push(`Missing candidate cell ${expectedCell}.`);
  }

  const newFlagsAmongBaselineWins = [...candidateFlags]
    .filter((key) => !baselineLosses.has(key) && !baselineFlags.has(key))
    .sort();
  const rowByCell = new Map(rows.map((row) => [cellKey(row), row]));
  const anchorWins = {
    'bow:97': rowByCell.get('bow:97')?.win === true,
    'pistol:76': rowByCell.get('pistol:76')?.win === true,
  };

  if (rows.length !== 600 || seenCells.size !== 600) {
    errors.push(
      `Canonical coverage must be exactly 600 unique runs; got ${rows.length}/${seenCells.size}.`,
    );
  }
  if (officialWins < MIN_OFFICIAL_WINS) {
    errors.push(`Official wins ${officialWins}/600 are below the ${MIN_OFFICIAL_WINS}/600 floor.`);
  }
  if (candidateFlags.size > MAX_SAFE_ROOM_FLAGS) {
    errors.push(`Safe-room flags ${candidateFlags.size} exceed the ${MAX_SAFE_ROOM_FLAGS} limit.`);
  }
  if (newFlagsAmongBaselineWins.length > 0) {
    errors.push(
      `New >60s flags among baseline official wins: ${newFlagsAmongBaselineWins.join(', ')}.`,
    );
  }
  for (const [anchor, won] of Object.entries(anchorWins)) {
    if (!won) errors.push(`Required anchor ${anchor} is not an official win.`);
  }

  return {
    passed: errors.length === 0,
    baselineSha: baseline.baselineSha,
    totalRuns: rows.length,
    officialWins,
    safeRoomFlaggedCount: candidateFlags.size,
    maxSafeRoomMs,
    maxActiveTimeMs,
    newFlagsAmongBaselineWins,
    anchorWins,
    routeLifecycle,
    errors,
  };
}

function formatSummary(result: SafeRoomRouteGateResult): string {
  return [
    '## Safe-room route canonical gate',
    '',
    `**${result.passed ? 'PASS' : 'FAIL'}** — ${result.officialWins}/${result.totalRuns} official wins; ` +
      `${result.safeRoomFlaggedCount} runs over 60s safe dwell.`,
    '',
    `- Baseline: \`${result.baselineSha}\` (556/600, 11 flags)`,
    `- New flags among baseline official wins: ${result.newFlagsAmongBaselineWins.length}`,
    `- Anchors: bow:97=${result.anchorWins['bow:97'] ? 'win' : 'loss'}, pistol:76=${result.anchorWins['pistol:76'] ? 'win' : 'loss'}`,
    `- Max safe dwell: ${(result.maxSafeRoomMs / 1000).toFixed(1)}s`,
    `- Max active time: ${(result.maxActiveTimeMs / 1000).toFixed(1)}s (strictly <360s for every official win)`,
    `- Route lifecycle: ${result.routeLifecycle.activations} activations, ${result.routeLifecycle.completions} completions, ${result.routeLifecycle.blocked} blocked, ${result.routeLifecycle.reseeds} reseeds`,
    ...(result.errors.length > 0
      ? ['', '### Failures', ...result.errors.map((error) => `- ${error}`)]
      : []),
    '',
  ].join('\n');
}

function main(argv: string[]): void {
  const candidateIndex = argv.indexOf('--candidate-dir');
  const outIndex = argv.indexOf('--out');
  if (candidateIndex < 0 || argv[candidateIndex + 1] === undefined) {
    throw new Error('Usage: safe-room-route-gate.ts --candidate-dir <dir> [--out <summary.json>]');
  }
  const candidateDir = resolve(argv[candidateIndex + 1]);
  const fixturePath = fileURLToPath(
    new URL('./fixtures/safe-room-baseline-a8e26a51.json', import.meta.url),
  );
  const baseline = JSON.parse(readFileSync(fixturePath, 'utf8')) as SafeRoomBaselineManifest;
  const rows = readdirSync(candidateDir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const artifact = JSON.parse(
        readFileSync(resolve(candidateDir, name), 'utf8'),
      ) as SweepArtifact;
      return artifact.metrics ?? [];
    });
  const result = evaluateSafeRoomRouteGate(rows, baseline);
  const json = JSON.stringify(result, null, 2);
  const summary = formatSummary(result);
  if (outIndex >= 0 && argv[outIndex + 1] !== undefined) {
    writeFileSync(resolve(argv[outIndex + 1]), `${json}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  console.log(summary);
  if (!result.passed) process.exitCode = 1;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entrypoint) main(process.argv.slice(2));
