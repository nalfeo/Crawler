/**
 * Goobers intake selection.
 *
 * `goobers-run.yml` must claim *at least* every issue the legacy issue-intake
 * reconciler would have picked up. Rather than restating the legacy selectors
 * in workflow YAML (where they would drift), this module normalizes `gh` CLI
 * JSON into the REST issue shape the canonical
 * `.github/scripts/ci-recovery/issue-intake-lib.mjs` eligibility functions
 * already consume, and defers every policy decision to them.
 *
 * CLI:
 *   node .github/scripts/goobers/intake-selection.mjs --candidates <file|->
 *     Reads `gh search issues --json number,labels,author,assignees,state,isPullRequest`
 *     output and prints one `<number>\t<cohort>` line per eligible issue,
 *     approved issues first, otherwise preserving the input order.
 *
 *   node .github/scripts/goobers/intake-selection.mjs --issue <file|->
 *     Reads a single `gh issue view --json number,state,labels,assignees,author`
 *     payload and prints the decision as JSON. Always exits 0; the caller reads
 *     `.eligible`.
 *
 * Callers should prefer an explicit file path. `-` is supported (and hardened
 * against non-blocking pipes, below) but a file is the only wiring that cannot
 * lose the payload to a transient read error.
 */
import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { goobersIntakeEligibility } from '../ci-recovery/issue-intake-lib.mjs';

/**
 * `gh` strips the `[bot]` suffix from bot logins and reports `is_bot: true`
 * instead, so a raw `author.login` comparison would silently fail to recognize
 * `github-actions[bot]` as GitHub Actions and drop the whole automation-opened
 * cohort.
 */
export function normalizeGhLogin(actor) {
  const login = String((typeof actor === 'string' ? actor : (actor?.login ?? '')) || '').trim();
  if (!login) return '';
  const isBot = actor?.is_bot === true || actor?.isBot === true;
  return isBot && !login.endsWith('[bot]') ? `${login}[bot]` : login;
}

/** Maps one `gh` issue/search record onto the REST issue shape. */
export function normalizeGhIssue(entry) {
  const number = Number(entry?.number);
  const normalized = {
    number: Number.isInteger(number) && number > 0 ? number : undefined,
    state: String(entry?.state ?? '').toLowerCase(),
    user: { login: normalizeGhLogin(entry?.author) },
    labels: (Array.isArray(entry?.labels) ? entry.labels : []).map((label) => ({
      name: String((typeof label === 'string' ? label : (label?.name ?? '')) || ''),
    })),
    assignees: (Array.isArray(entry?.assignees) ? entry.assignees : []).map((assignee) => ({
      login: normalizeGhLogin(assignee),
    })),
  };
  if (entry?.isPullRequest === true || entry?.pull_request) {
    normalized.pull_request = { url: String(entry?.url ?? '') };
  }
  return normalized;
}

/** Decision for one `gh` record, with the issue number attached. */
export function decideGhIssue(entry, options = {}) {
  const issue = normalizeGhIssue(entry);
  return { number: issue.number ?? null, ...goobersIntakeEligibility(issue, options) };
}

/**
 * Eligible issues in dispatch order: explicitly approved issues first (so the
 * maintainer's queue is never starved by the newly transferred parity cohort),
 * then the parity cohort. Within a cohort the caller's order — oldest-created
 * first, from the search qualifiers — is preserved.
 *
 * Candidates may legitimately repeat (the caller runs one narrow approved query
 * and one broad parity query so the approved queue can never fall off the far
 * side of the Search API's result cap), so the first decision per issue number
 * wins.
 */
export function selectGoobersIntakeIssues(candidates, options = {}) {
  const decisions = (Array.isArray(candidates) ? candidates : []).map((entry) =>
    decideGhIssue(entry, options),
  );
  const seen = new Set();
  const eligible = decisions.filter((decision) => {
    if (!decision.eligible || !Number.isInteger(decision.number)) return false;
    if (seen.has(decision.number)) return false;
    seen.add(decision.number);
    return true;
  });
  return [
    ...eligible.filter((decision) => decision.cohort === 'approved'),
    ...eligible.filter((decision) => decision.cohort !== 'approved'),
  ];
}

const STDIN_RETRY_SLEEP_MS = 5;
const STDIN_TIMEOUT_MS = 30_000;
const STDIN_CHUNK_BYTES = 64 * 1024;

/** Blocks the current thread without spinning the CPU. */
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Reads a whole stream from `fd` synchronously, tolerating a non-blocking pipe.
 *
 * `fs.readFileSync(0)` throws `EAGAIN` the moment stdin is a pipe carrying the
 * `O_NONBLOCK` flag — which is exactly what `gh ... | node ...` produced on the
 * GitHub Actions runner, killing live Goobers intake with
 * `could not parse issue JSON from '-'`. EAGAIN on a non-blocking pipe means
 * "the writer has not produced the next bytes yet", not "this read failed", so
 * the only correct response is to wait and read again until EOF.
 *
 * `read`/`sleep`/`now` are injectable so the retry path is unit-testable
 * without depending on the host kernel's pipe scheduling.
 */
export function readAllSync(fd, options = {}) {
  const {
    read = (buffer) => fs.readSync(fd, buffer, 0, buffer.length, null),
    sleep = sleepSync,
    now = Date.now,
    timeoutMs = STDIN_TIMEOUT_MS,
    retrySleepMs = STDIN_RETRY_SLEEP_MS,
  } = options;
  const buffer = Buffer.alloc(STDIN_CHUNK_BYTES);
  const chunks = [];
  const deadline = now() + timeoutMs;
  for (;;) {
    let bytesRead;
    try {
      bytesRead = read(buffer);
    } catch (error) {
      if (error?.code === 'EAGAIN') {
        if (now() >= deadline) {
          throw new Error(
            `timed out after ${timeoutMs}ms waiting for data (stdin stayed non-blocking/EAGAIN)`,
          );
        }
        sleep(retrySleepMs);
        continue;
      }
      // A pipe closed by the writer surfaces as EOF on some platforms.
      if (error?.code === 'EOF') break;
      throw error;
    }
    if (!bytesRead) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function readInput(source) {
  const raw = source === '-' ? readAllSync(0) : fs.readFileSync(source, 'utf8');
  return raw.replace(/^\uFEFF/, '');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    options[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[(index += 1)] : true;
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = parseArgs(process.argv.slice(2));
  const maintainerLogin = String(process.env.ISSUE_OWNER || 'nalfeo');
  const source = typeof args.candidates === 'string' ? args.candidates : args.issue;
  if (typeof source !== 'string') {
    process.stderr.write(
      'Usage: intake-selection.mjs (--candidates <file|-> | --issue <file|->)\n',
    );
    process.exit(2);
  }

  let raw;
  try {
    raw = readInput(source);
  } catch (error) {
    const remediation =
      source === '-'
        ? "intake-selection: pass an explicit file path instead of '-' " +
          '(e.g. `gh issue view ... > "$f" && node .github/scripts/goobers/intake-selection.mjs --issue "$f"`).\n'
        : '';
    process.stderr.write(
      `intake-selection: could not read issue JSON from '${source}': ${error.message}\n${remediation}`,
    );
    process.exit(2);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(
      `intake-selection: could not parse issue JSON from '${source}': ${error.message}\n`,
    );
    process.exit(2);
  }

  if (typeof args.candidates === 'string') {
    for (const decision of selectGoobersIntakeIssues(payload, { maintainerLogin })) {
      process.stdout.write(`${decision.number}\t${decision.cohort}\n`);
    }
  } else {
    process.stdout.write(`${JSON.stringify(decideGhIssue(payload, { maintainerLogin }))}\n`);
  }
}
