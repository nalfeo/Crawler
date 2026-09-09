/**
 * Goobers attempt-telemetry producer.
 *
 * Turns the raw Goobers run tree a `goobers-run.yml` lane leaves behind
 * (`<lane-root>/slot-<n>/gaggles/<gaggle>/runs/<run-id>/events.jsonl`) into a
 * validated `crawler.goobers.run-artifact/v1` record per slot, so the lineage,
 * per-stage timings, context footprint, and normalized terminal outcome of
 * every feature-PR attempt are recorded in the run artifact instead of only
 * existing as a schema.
 *
 * Journal-less slots are the reason this is a producer rather than a jq
 * snippet: a lane that dies before Goobers writes any event still has an
 * assigned issue whose attempt must be accounted for, so those slots emit an
 * attempt with an explicit `unavailableReason` and an `aborted`/`timeout`
 * outcome rather than silently emitting nothing.
 *
 * Privacy: only counts, byte sizes, durations, and stage NAMES are read out of
 * the journal. Prompt text, diffs, tokens' contents, and credentials are never
 * copied into the emitted record.
 *
 * CLI:
 *   node .github/scripts/goobers/attempt-telemetry.mjs \
 *     --lane-root <path> --lane <n> --slots "0 1" --assignments <json> \
 *     [--attempt <n>] [--job-status <status>] [--workflow-run-id <id>]
 *
 * Writes `<lane-root>/slot-<n>/diagnostics/attempt-telemetry.json` for every
 * slot with an assigned issue and exits non-zero if any emitted record fails
 * its own contract validation (fail-closed, deterministic).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { attemptTelemetryV1, runArtifactV1 } from '../validate-goobers-contracts-schema.js';
import {
  attemptTelemetrySemanticErrors,
  runArtifactSemanticErrors,
} from '../validate-goobers-contracts.mjs';

const require = createRequire(import.meta.url);

/**
 * Journal events carry their instant under one of several keys depending on
 * the emitting stage, so read them all rather than hard-coding one and
 * silently losing every duration.
 */
const TIMESTAMP_KEYS = Object.freeze(['ts', 'timestamp', 'time', 'at', 'occurredAt', 'emittedAt']);

const DURATION_KEYS = Object.freeze(['durationMs', 'elapsedMs', 'tookMs']);

/** Byte/token counters, mapped from any of the journal spellings we accept. */
const METRIC_SOURCES = Object.freeze({
  promptBytes: ['promptBytes', 'prompt_bytes'],
  contextArtifactBytes: ['contextArtifactBytes', 'contextBytes', 'context_bytes'],
  modelInputTokens: ['inputTokens', 'promptTokens', 'input_tokens'],
  modelOutputTokens: ['outputTokens', 'completionTokens', 'output_tokens'],
  compactionCount: ['compactionCount', 'compactions', 'compaction_count'],
});

const METRIC_FIELDS = Object.freeze(Object.keys(METRIC_SOURCES));

/** Sanitizes a lineage component to the schema's `^[A-Za-z0-9._:-]+$`. */
export function lineageToken(value) {
  const token = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return token || 'unknown';
}

/**
 * Stable lineage key linking the initial run, its retries, resumes, and
 * repasses for one issue. The issue is the lineage root; the workflow run
 * attempt distinguishes attempts within it.
 */
export function attemptLineageKeyFor({ issueNumber, runId, attemptNumber }) {
  return [
    `issue-${lineageToken(issueNumber)}`,
    `run-${lineageToken(runId || 'no-journal')}`,
    `attempt-${lineageToken(attemptNumber)}`,
  ].join(':');
}

/** Parses a JSONL journal, ignoring malformed lines the way the workflow does. */
export function parseJournalLines(text) {
  const events = [];
  let malformedCount = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        events.push(parsed);
        continue;
      }
      malformedCount += 1;
    } catch {
      malformedCount += 1;
    }
  }
  return { events, malformedCount };
}

/** Epoch milliseconds for an event, or null when it carries no usable instant. */
export function eventTimestampMs(event) {
  for (const key of TIMESTAMP_KEYS) {
    const raw = event?.[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const parsed = Date.parse(String(raw));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstFiniteNumber(container, keys) {
  for (const key of keys) {
    const raw = container?.[key];
    if (raw === undefined || raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/**
 * Per-stage wall-clock durations in milliseconds, derived from
 * `stage.started`/`stage.finished` pairs, or from an explicit duration field
 * when the journal reports one. Repeated stages accumulate, so a repassed
 * stage reports its total cost.
 */
export function stageDurationsFrom(events) {
  const durations = {};
  const startedAt = new Map();
  const trace = [];

  for (const event of events) {
    const stage = String(event?.stage ?? '').trim();
    if (!stage) continue;
    if (event?.type === 'stage.started') {
      startedAt.set(stage, eventTimestampMs(event));
      trace.push(stage);
      continue;
    }
    if (event?.type !== 'stage.finished') continue;

    if (!trace.includes(stage)) trace.push(stage);
    const explicit =
      firstFiniteNumber(event, DURATION_KEYS) ?? firstFiniteNumber(event?.outputs, DURATION_KEYS);
    let duration = explicit;
    if (duration === null) {
      const start = startedAt.get(stage) ?? null;
      const end = eventTimestampMs(event);
      if (start !== null && end !== null && end >= start) duration = end - start;
    }
    startedAt.delete(stage);
    if (duration === null) continue;
    durations[stage] = (durations[stage] ?? 0) + duration;
  }

  return { durations, trace };
}

/** Total wall clock for the attempt: run.started→run.finished, else stage sum. */
export function totalElapsedMsFrom(events, durations) {
  const runStart = events.find((event) => event?.type === 'run.started');
  const runFinished = [...events].reverse().find((event) => event?.type === 'run.finished');
  const start = runStart ? eventTimestampMs(runStart) : null;
  const end = runFinished ? eventTimestampMs(runFinished) : null;
  if (start !== null && end !== null && end >= start) return end - start;
  return Object.values(durations).reduce((sum, value) => sum + value, 0);
}

/**
 * Privacy-safe context footprint. Every metric is a count or a byte size read
 * from a journal-reported usage record; nothing derived from prompt CONTENT is
 * copied. Missing metrics stay null and force an `unavailableReason`.
 */
export function contextMetricsFrom(events) {
  const totals = Object.fromEntries(METRIC_FIELDS.map((field) => [field, null]));
  for (const event of events) {
    const containers = [event, event?.usage, event?.metrics, event?.outputs, event?.outputs?.usage];
    for (const [field, keys] of Object.entries(METRIC_SOURCES)) {
      for (const container of containers) {
        const value = firstFiniteNumber(container, keys);
        if (value === null) continue;
        totals[field] = (totals[field] ?? 0) + value;
        break;
      }
    }
  }
  return totals;
}

/**
 * Number of repasses this attempt absorbed: a remediation/review-driven
 * re-entry into implementation is what "repass" means for the feature-PR
 * workflow, so count the terminal remediation stages the journal records.
 */
export function repassCountFrom(events) {
  return events.filter(
    (event) =>
      event?.type === 'stage.finished' &&
      ['needs-remediation', 'review'].includes(String(event?.stage ?? '')) &&
      String(event?.status ?? '') !== 'no-work',
  ).length;
}

/** Normalized terminal outcome + a short human-readable reason. */
export function terminalOutcomeFrom({ events, hasJournal, jobStatus }) {
  if (!hasJournal) {
    return jobStatus === 'cancelled'
      ? {
          terminalOutcome: 'timeout',
          outcomeReason: 'Lane was cancelled before Goobers wrote a run journal.',
        }
      : { terminalOutcome: 'aborted', outcomeReason: 'Slot produced no run journal.' };
  }

  const runFinished = [...events].reverse().find((event) => event?.type === 'run.finished');
  const phase = String(runFinished?.status ?? '').trim();
  const noWork = events.some(
    (event) => event?.type === 'stage.finished' && event?.status === 'no-work',
  );
  const openedPr = events.some(
    (event) =>
      event?.type === 'stage.finished' &&
      String(event?.stage ?? '') === 'open-pr' &&
      String(event?.status ?? '') === 'success',
  );

  if (!phase) {
    return jobStatus === 'cancelled'
      ? {
          terminalOutcome: 'timeout',
          outcomeReason: 'Run never reached a terminal phase before the lane was cancelled.',
        }
      : {
          terminalOutcome: 'aborted',
          outcomeReason: 'Run never recorded a terminal run.finished event.',
        };
  }
  if (phase === 'completed') {
    if (noWork)
      return {
        terminalOutcome: 'no-work',
        outcomeReason: 'Run completed with a no-work disposition.',
      };
    if (openedPr)
      return {
        terminalOutcome: 'pr-opened',
        outcomeReason: 'Run completed after opening a feature PR.',
      };
    return {
      terminalOutcome: 'issue-completed',
      outcomeReason: 'Run completed without opening a new PR.',
    };
  }
  if (phase === 'aborted') {
    return { terminalOutcome: 'aborted', outcomeReason: 'Run was aborted before completion.' };
  }
  return {
    terminalOutcome: 'blocked',
    outcomeReason: `Run ended in phase '${phase}'.`,
  };
}

/**
 * Builds one `crawler.goobers.attempt-telemetry/v1` record. `events` may be
 * empty: a journal-less attempt is still recorded, with every unavailable
 * metric explained.
 */
export function buildAttemptTelemetry({
  events = [],
  hasJournal = events.length > 0,
  issueNumber,
  runId = '',
  attemptNumber = 1,
  jobStatus = '',
  malformedCount = 0,
}) {
  const { durations, trace } = stageDurationsFrom(events);
  const metrics = contextMetricsFrom(events);
  const { terminalOutcome, outcomeReason } = terminalOutcomeFrom({ events, hasJournal, jobStatus });
  const attempt = Math.max(1, Number(attemptNumber) || 1);
  const missingMetrics = METRIC_FIELDS.filter((field) => metrics[field] === null);

  const record = {
    contractVersion: 'v1',
    attemptLineageKey: attemptLineageKeyFor({ issueNumber, runId, attemptNumber: attempt }),
    issueNumber: String(issueNumber),
    runId: String(runId || `no-journal-attempt-${attempt}`),
    attemptNumber: attempt,
    retryCount: attempt - 1,
    repassCount: repassCountFrom(events),
    parentAttemptLineageKey:
      attempt > 1 ? attemptLineageKeyFor({ issueNumber, runId, attemptNumber: attempt - 1 }) : null,
    stageDurations: durations,
    totalElapsedMs: totalElapsedMsFrom(events, durations),
    ...metrics,
    terminalOutcome,
    outcomeReason,
    stageTrace: trace,
  };

  if (missingMetrics.length > 0) {
    record.unavailableReason = hasJournal
      ? `Goobers run journal reported no ${missingMetrics.join(', ')} usage for this attempt${
          malformedCount > 0 ? ` (${malformedCount} malformed journal line(s) ignored)` : ''
        }.`
      : 'Slot produced no run journal, so no context or model usage could be measured.';
  }

  return record;
}

/** Wraps attempts into a `crawler.goobers.run-artifact/v1` record. */
export function buildRunArtifact({ issueNumber, attempts, cohortSummary = null }) {
  return {
    contractVersion: 'v1',
    issueNumber: String(issueNumber),
    attempts,
    ...(cohortSummary ? { cohortSummary } : {}),
  };
}

let compiledValidators = null;
function validators() {
  if (!compiledValidators) {
    const Ajv = require('ajv');
    const ajv = new Ajv({ allErrors: true, strict: false });
    compiledValidators = {
      attempt: ajv.compile(attemptTelemetryV1),
      runArtifact: ajv.compile(runArtifactV1),
    };
  }
  return compiledValidators;
}

/** Fail-closed validation of an emitted record against its own contract. */
export function validateRunArtifactPayload(payload) {
  const { attempt, runArtifact } = validators();
  const errors = [];
  if (!runArtifact(payload)) {
    for (const error of runArtifact.errors ?? []) {
      errors.push(`${error.instancePath || '/'} ${error.message}`.trim());
    }
  }
  errors.push(...runArtifactSemanticErrors(payload));
  for (const [index, record] of (payload?.attempts ?? []).entries()) {
    if (!attempt(record)) {
      for (const error of attempt.errors ?? []) {
        errors.push(`attempts[${index}]${error.instancePath || ''} ${error.message}`.trim());
      }
    }
    errors.push(
      ...attemptTelemetrySemanticErrors(record).map((message) => `attempts[${index}]: ${message}`),
    );
  }
  return errors;
}

/** Newest-last list of `events.jsonl` files under a slot instance root. */
export function findJournalFiles(slotRoot, readdir = fs.readdirSync, exists = fs.existsSync) {
  const gagglesRoot = path.join(slotRoot, 'gaggles');
  if (!exists(gagglesRoot)) return [];
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'events.jsonl') found.push(full);
    }
  };
  walk(gagglesRoot);
  return found;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function issueForSlot(assignments, slot, lane) {
  const match = assignments.find(
    (entry) =>
      String(entry?.slot) === String(slot) &&
      (lane === undefined || lane === '' || String(entry?.lane) === String(lane)),
  );
  const issue = String(match?.issue ?? '').trim();
  return /^[0-9]+$/.test(issue) ? issue : '';
}

/**
 * Emits one validated run artifact per assigned slot into that slot's
 * diagnostics directory (already part of the uploaded run-journal artifact).
 */
export function emitLaneTelemetry({
  laneRoot,
  slots,
  assignments,
  lane = '',
  attemptNumber = 1,
  jobStatus = '',
  log = () => {},
}) {
  const emitted = [];
  const errors = [];

  for (const slot of slots) {
    const slotRoot = path.join(laneRoot, `slot-${slot}`);
    const issueNumber = issueForSlot(assignments, slot, lane);
    if (!issueNumber) {
      log(`Slot ${slot}: no assigned issue; no attempt telemetry to emit.`);
      continue;
    }

    const journalFiles = findJournalFiles(slotRoot);
    const attempts = [];
    for (const journalFile of journalFiles) {
      const { events, malformedCount } = parseJournalLines(fs.readFileSync(journalFile, 'utf8'));
      attempts.push(
        buildAttemptTelemetry({
          events,
          hasJournal: true,
          issueNumber,
          runId: path.basename(path.dirname(journalFile)),
          attemptNumber,
          jobStatus,
          malformedCount,
        }),
      );
    }
    if (attempts.length === 0) {
      // The journal-less failure path: an assigned issue whose attempt would
      // otherwise vanish from the telemetry entirely.
      attempts.push(
        buildAttemptTelemetry({
          events: [],
          hasJournal: false,
          issueNumber,
          attemptNumber,
          jobStatus,
        }),
      );
    }

    const payload = buildRunArtifact({ issueNumber, attempts });
    const payloadErrors = validateRunArtifactPayload(payload);
    const outputDir = path.join(slotRoot, 'diagnostics');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'attempt-telemetry.json');
    fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
    emitted.push({ slot, issueNumber, outputPath, payload });

    if (payloadErrors.length > 0) {
      errors.push(`slot ${slot} (issue #${issueNumber}): ${payloadErrors.join('; ')}`);
      continue;
    }
    log(
      `Slot ${slot}: wrote ${outputPath} (issue #${issueNumber}, ${attempts.length} attempt(s), outcome ${attempts
        .map((entry) => entry.terminalOutcome)
        .join(',')})`,
    );
  }

  return { emitted, errors };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const laneRoot = args['lane-root'] || env.GOOBERS_LANE_ROOT;
  if (!laneRoot) {
    process.stderr.write('attempt-telemetry: --lane-root (or GOOBERS_LANE_ROOT) is required\n');
    return 2;
  }
  const slots = String(args.slots ?? env.GOOBERS_SLOTS ?? '')
    .split(/\s+/)
    .filter(Boolean);
  let assignments = [];
  try {
    assignments = JSON.parse(args.assignments ?? env.GOOBERS_SLOT_ASSIGNMENTS ?? '[]');
  } catch (error) {
    process.stderr.write(`attempt-telemetry: could not parse slot assignments: ${error.message}\n`);
    return 2;
  }

  const { errors } = emitLaneTelemetry({
    laneRoot,
    slots,
    assignments: Array.isArray(assignments) ? assignments : [],
    lane: args.lane ?? env.GOOBERS_LANE ?? '',
    attemptNumber: Number(args.attempt ?? env.GITHUB_RUN_ATTEMPT ?? 1),
    jobStatus: args['job-status'] ?? env.JOB_STATUS ?? '',
    log: (message) => process.stdout.write(`${message}\n`),
  });

  if (errors.length > 0) {
    for (const error of errors) {
      process.stderr.write(`::error::attempt telemetry failed contract validation: ${error}\n`);
    }
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
