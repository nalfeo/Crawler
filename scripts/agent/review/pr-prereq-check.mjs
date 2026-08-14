#!/usr/bin/env node
/* global console */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { evaluatePreflightChecks } from '../../../.github/extensions/copilot-guards/guards/pr-preflight.mjs';
import { decideLedger } from '../../../.github/extensions/copilot-guards/guards/pr-review-ledger.mjs';
import { mergeBaseWithMain } from '../../../.github/extensions/copilot-guards/lib/git.mjs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function section(title, body) {
  return `\n[${title}]\n${body.trim()}`;
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function hasTelemetryCapture(files) {
  return (files || []).some(
    (f) => f.startsWith('docs/knowledge/metrics/guard-telemetry/') && f.endsWith('.json'),
  );
}

function handoffSlug(file) {
  return file.match(/^docs\/knowledge\/handoffs\/\d{4}-\d{2}-\d{2}-(.+)\.md$/)?.[1] ?? null;
}

function ledgerSlug(file) {
  return (
    file.match(
      /^docs\/knowledge\/review-ledgers\/\d{4}-\d{2}-\d{2}-(.+)\.review-ledger\.json$/,
    )?.[1] ?? null
  );
}

function uniqueSlug(files, parser) {
  const slugs = [...new Set((files || []).map(parser).filter(Boolean))];
  return slugs.length === 1 ? slugs[0] : null;
}

export function inferTelemetrySessionSlug(_files, addedFiles = []) {
  return uniqueSlug(addedFiles, handoffSlug) ?? uniqueSlug(addedFiles, ledgerSlug);
}

function normalizeSlug(slug) {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Returns the platform-appropriate telemetry capture invocation descriptor so
 * tests can verify command selection without executing npm.
 *
 * On Windows, Node >= 18.20/20.12 refuses to `execFile` a `.cmd` without a
 * shell (CVE-2024-27980 mitigation), surfacing as `spawnSync npm.cmd EINVAL`.
 * Passing `shell: true` with an args array additionally triggers DEP0190. The
 * fix is a single pre-built command string via `execSync`. `slug` is already
 * normalized to `[a-z0-9-]` by `normalizeSlug`, so there is nothing in it for
 * a shell to interpret.
 *
 * @param {boolean} isWindows
 * @param {string} slug
 * @returns {{ type: 'shell'; command: string } | { type: 'execFile'; args: string[] }}
 */
export function buildCaptureTelemetryOpts(isWindows, slug) {
  if (isWindows) {
    return { type: 'shell', command: `npm run telemetry:capture -- ${slug}` };
  }
  return { type: 'execFile', args: ['npm', 'run', 'telemetry:capture', '--', slug] };
}

function captureTelemetry(cwd, slug) {
  const opts = buildCaptureTelemetryOpts(process.platform === 'win32', slug);
  if (opts.type === 'shell') {
    return execSync(opts.command, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return execFileSync(opts.args[0], opts.args.slice(1), {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function captureErrorDetail(err) {
  if (!err) {
    return 'telemetry:capture subprocess failed: no error details available';
  }
  if (typeof err?.stderr === 'string' && err.stderr.trim()) {
    return `telemetry:capture subprocess failed: ${err.stderr.trim()}`;
  }
  if (typeof err?.message === 'string' && err.message.trim()) {
    return `telemetry:capture subprocess failed: ${err.message.trim()}`;
  }
  return 'telemetry:capture subprocess failed: unknown error';
}

export function summarizePrereqResult(preflightDecision, ledgerDecision) {
  const failures = [];
  const notes = [];

  if (preflightDecision?.decision === 'deny') {
    failures.push(section('pr-preflight', preflightDecision.reason || 'failed'));
  } else if (preflightDecision?.additionalContext) {
    notes.push(section('pr-preflight', preflightDecision.additionalContext));
  }

  if (ledgerDecision?.decision === 'deny') {
    failures.push(section('pr-review-ledger', ledgerDecision.reason || 'failed'));
  } else if (ledgerDecision?.decision === 'skip') {
    notes.push(
      section(
        'pr-review-ledger',
        ledgerDecision.additionalContext ||
          'review ledger not required for docs/art/deps-only change.',
      ),
    );
  } else if (ledgerDecision?.additionalContext) {
    notes.push(section('pr-review-ledger', ledgerDecision.additionalContext));
  }

  return { ok: failures.length === 0, failures, notes };
}

export function evaluatePrereqs(files, addedFiles, cwd, opts = {}) {
  const preflightDecision = evaluatePreflightChecks({
    files,
    addedFiles,
    cwd,
    toolArgs: {},
    skipSemanticTitle: true,
    currentBranch: opts.currentBranch,
    mergeBase: opts.mergeBase,
  });
  const ledgerDecision = decideLedger(files, addedFiles, {
    cwd,
    validateFile: opts.validateFile,
  });
  return summarizePrereqResult(preflightDecision, ledgerDecision);
}

export function telemetryCaptureNote(cwd, files, addedFiles = [], opts = {}) {
  const artifact = join(cwd, 'files', 'guard-telemetry.jsonl');
  if (!existsSync(artifact)) return null;
  const hasCapture = hasTelemetryCapture(files);
  if (hasCapture) return null;
  const rawSlug = inferTelemetrySessionSlug(files, addedFiles);
  const slug = rawSlug ? normalizeSlug(rawSlug) : null;
  const runCapture = opts.captureTelemetry ?? captureTelemetry;
  if (slug) {
    let captureOutput;
    try {
      captureOutput = runCapture(cwd, slug) ?? '';
    } catch (err) {
      return section(
        'guard-telemetry',
        `Automatic guard-telemetry capture failed for session "${slug}". Run ` +
          `\`npm run telemetry:capture -- ${slug}\` manually before PR.\n\n` +
          `Last error: ${captureErrorDetail(err)}`,
      );
    }

    const captureFile = `docs/knowledge/metrics/guard-telemetry/${todayStamp()}-${slug}.json`;
    if (captureOutput.includes('Captured ') || existsSync(join(cwd, captureFile))) {
      return section(
        'guard-telemetry',
        `Auto-captured guard telemetry to \`${captureFile}\`. Stage or commit it with the rest of the session artifacts.`,
      );
    }
  }
  return section(
    'guard-telemetry',
    'files/guard-telemetry.jsonl exists but no capture file is staged. Run ' +
      `\`npm run telemetry:capture -- ${slug ?? '<session-slug>'}\` to commit a durable per-session ` +
      'summary (non-blocking).',
  );
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function lines(text) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function addedFromNameStatus(text) {
  return lines(text)
    .filter((line) => line.startsWith('A\t'))
    .map((line) => line.slice(2).trim());
}

function gatherCurrentDiff(cwd) {
  const files = new Set();
  const addedFiles = new Set();

  const base = mergeBaseWithMain(cwd);
  if (base) {
    for (const f of lines(
      git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]),
    )) {
      files.add(f);
    }
    for (const f of addedFromNameStatus(git(cwd, ['diff', '--name-status', `${base}...HEAD`]))) {
      addedFiles.add(f);
    }
  }

  for (const f of lines(git(cwd, ['diff', '--name-only', '--diff-filter=ACMR']))) {
    files.add(f);
  }
  for (const f of lines(git(cwd, ['diff', '--name-only', '--diff-filter=ACMR', '--cached']))) {
    files.add(f);
  }

  for (const f of addedFromNameStatus(git(cwd, ['diff', '--name-status', '--cached']))) {
    addedFiles.add(f);
  }

  const untracked = lines(git(cwd, ['ls-files', '--others', '--exclude-standard']));
  for (const f of untracked) {
    files.add(f);
    addedFiles.add(f);
  }

  const currentBranch = lines(git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))[0] ?? '';
  return { files: [...files], addedFiles: [...addedFiles], mergeBase: base, currentBranch };
}

function main() {
  const cwd = process.cwd();
  let diff;

  try {
    diff = gatherCurrentDiff(cwd);
  } catch (err) {
    console.error(
      `❌ verify:pr-prereqs could not inspect branch diff: ${err.message}\nResolve git state and retry.`,
    );
    process.exit(1);
  }

  const result = evaluatePrereqs(diff.files, diff.addedFiles, cwd, {
    currentBranch: diff.currentBranch,
    mergeBase: diff.mergeBase,
  });
  const telemetryNote = telemetryCaptureNote(cwd, diff.files, diff.addedFiles);
  if (telemetryNote) {
    result.notes.push(telemetryNote);
  }
  if (!result.ok) {
    console.error(
      `❌ PR prerequisites are incomplete. Run these checks when execution is done, before opening PR.${result.failures.join(
        '',
      )}`,
    );
    if (result.notes.length > 0) {
      console.error(`\n[notes]${result.notes.join('')}`);
    }
    process.exit(1);
  }

  const noteSuffix = result.notes.length > 0 ? `\n[notes]${result.notes.join('')}` : '';
  console.log(`✅ PR prerequisites are satisfied (except final PR-title validation).${noteSuffix}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
