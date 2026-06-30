#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import type { RunStats } from '../../../src/game/ai/types.js';
import { type FunSession, type PlaytestSurvey, scoreFunSessions } from './fun-score-lib.js';

interface CLIArgs {
  readonly inputPath: string;
  readonly outputPath: string | null;
  readonly minOverall: number;
  readonly minDimension: number;
}

type UnknownRecord = Record<string, unknown>;
const VALID_OUTCOMES = new Set(['victory', 'death', 'timeout', 'stalled', 'error']);

function hasNumberField(obj: UnknownRecord, key: string): boolean {
  return typeof obj[key] === 'number' && Number.isFinite(obj[key] as number);
}

function parseArgs(argv: ReadonlyArray<string>): CLIArgs {
  let inputPath = '';
  let outputPath: string | null = null;
  let minOverall = 70;
  let minDimension = 55;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--input' && typeof next === 'string') {
      inputPath = next;
      i += 1;
      continue;
    }
    if (arg === '--out' && typeof next === 'string') {
      outputPath = next;
      i += 1;
      continue;
    }
    if (arg === '--min-overall' && typeof next === 'string') {
      minOverall = Number.parseFloat(next);
      i += 1;
      continue;
    }
    if (arg === '--min-dimension' && typeof next === 'string') {
      minDimension = Number.parseFloat(next);
      i += 1;
      continue;
    }
  }

  if (!inputPath) {
    throw new Error(
      'Missing --input <path>. Accepted JSON: RunStats[], { runs: RunStats[] }, { sessions: [{ id, run, survey? }] }.',
    );
  }
  if (!Number.isFinite(minOverall) || !Number.isFinite(minDimension)) {
    throw new Error('--min-overall and --min-dimension must be numbers.');
  }

  return { inputPath, outputPath, minOverall, minDimension };
}

function asSurvey(value: unknown): PlaytestSurvey | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const obj = value as UnknownRecord;
  const survey: {
    enjoyment?: number;
    immersion?: number;
    mastery?: number;
    control?: number;
    tension?: number;
  } = {};
  if (typeof obj.enjoyment === 'number') survey.enjoyment = obj.enjoyment;
  if (typeof obj.immersion === 'number') survey.immersion = obj.immersion;
  if (typeof obj.mastery === 'number') survey.mastery = obj.mastery;
  if (typeof obj.control === 'number') survey.control = obj.control;
  if (typeof obj.tension === 'number') survey.tension = obj.tension;
  return Object.keys(survey).length > 0 ? (survey as PlaytestSurvey) : undefined;
}

function isRunStats(value: unknown): value is RunStats {
  if (typeof value !== 'object' || value === null) return false;
  const run = value as UnknownRecord;
  const combat =
    typeof run.combat === 'object' && run.combat !== null ? (run.combat as UnknownRecord) : null;
  const health =
    typeof run.health === 'object' && run.health !== null ? (run.health as UnknownRecord) : null;
  const quests =
    typeof run.quests === 'object' && run.quests !== null ? (run.quests as UnknownRecord) : null;
  const firstQuestCompletedOk =
    quests !== null &&
    (quests.firstQuestCompletedMs === null ||
      (typeof quests.firstQuestCompletedMs === 'number' &&
        Number.isFinite(quests.firstQuestCompletedMs)));
  return (
    typeof run.outcome === 'string' &&
    VALID_OUTCOMES.has(run.outcome) &&
    typeof run.gameTimeMs === 'number' &&
    typeof run.startingWeapon === 'string' &&
    typeof run.finalLevel === 'number' &&
    typeof run.totalXp === 'number' &&
    Array.isArray(run.levelUps) &&
    combat !== null &&
    hasNumberField(combat, 'totalKills') &&
    hasNumberField(combat, 'combatTimeMs') &&
    hasNumberField(combat, 'engagementCount') &&
    hasNumberField(combat, 'damageDealt') &&
    health !== null &&
    hasNumberField(health, 'minHealthPercent') &&
    hasNumberField(health, 'closeCallCount') &&
    hasNumberField(health, 'lowHealthCount') &&
    hasNumberField(health, 'finalHealthPercent') &&
    quests !== null &&
    hasNumberField(quests, 'questsAccepted') &&
    hasNumberField(quests, 'questsCompleted') &&
    firstQuestCompletedOk
  );
}

function normalizeSessions(payload: unknown): FunSession[] {
  const toSession = (candidate: unknown, index: number): FunSession => {
    if (typeof candidate === 'object' && candidate !== null) {
      const obj = candidate as UnknownRecord;
      const id = typeof obj.id === 'string' ? obj.id : `run-${index + 1}`;
      const runCandidate = 'run' in obj ? obj.run : obj;
      if (!isRunStats(runCandidate)) {
        throw new Error(`Entry ${index + 1} is missing a valid RunStats payload.`);
      }
      return { id, run: runCandidate, survey: asSurvey(obj.survey) };
    }
    throw new Error(`Entry ${index + 1} is not an object.`);
  };

  if (Array.isArray(payload)) {
    return payload.map((entry, index) => toSession(entry, index));
  }
  if (typeof payload === 'object' && payload !== null) {
    const root = payload as UnknownRecord;
    if (Array.isArray(root.sessions)) {
      return root.sessions.map((entry, index) => toSession(entry, index));
    }
    if (Array.isArray(root.runs)) {
      return root.runs.map((entry, index) => toSession(entry, index));
    }
    if (isRunStats(root)) {
      return [{ id: 'run-1', run: root }];
    }
  }
  throw new Error(
    'Unsupported input shape. Expected RunStats[], { runs: RunStats[] }, or { sessions: [{ id, run, survey? }] }.',
  );
}

function main(): void {
  const args = parseArgs(process.argv);
  const raw = readFileSync(args.inputPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const sessions = normalizeSessions(parsed);
  const report = scoreFunSessions(sessions, {
    minOverall: args.minOverall,
    minDimension: args.minDimension,
  });

  const output = JSON.stringify(report, null, 2);
  process.stdout.write(`${output}\n`);
  if (args.outputPath) {
    writeFileSync(args.outputPath, `${output}\n`);
  }
  if (!report.gate.pass) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `fun-score failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}
