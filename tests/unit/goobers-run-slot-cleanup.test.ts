import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { toBashScriptPath, bashEnv } from '../helpers/bash-script-path.js';

/**
 * Executable proof that goobers-run.yml's per-lane post-processing really does
 * visit EVERY run of EVERY concurrent slot, that the recovery reservation is
 * ordered before any fresh claim, and that the slot deadline tears down the
 * whole stage process tree before anything is released.
 *
 * The structural assertions in goobers-run-workflow.test.ts can only show that
 * the enumeration and the ordering are written; this file actually runs the
 * step scripts under bash against fabricated instance trees and real
 * processes, and asserts the observable side effects.
 *
 * Requires bash and jq — both are present on the ubuntu-latest runner that
 * executes this suite (goobers-contract-validation.yml), and the guard keeps a
 * Windows workstation without jq from reporting a false failure.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const hasJq = hasBash && spawnSync('bash', ['-c', 'command -v jq >/dev/null 2>&1']).status === 0;
const hasProc = hasBash && spawnSync('bash', ['-c', 'test -r /proc/self/stat']).status === 0;
const hasSetsid =
  hasBash && spawnSync('bash', ['-c', 'command -v setsid >/dev/null 2>&1']).status === 0;

/**
 * `goobers-contract-validation.yml` sets this on ubuntu-latest. It is what
 * stops the Linux-only gates above from quietly disarming the suite in CI: with
 * it set, "prerequisite missing" is a failure rather than a skip, so a passing
 * contract-validation job always means the executable suites actually ran.
 */
const requireLinuxSuites = process.env.GOOBERS_REQUIRE_LINUX_SUITES === '1';

describe('Goobers executable suite preconditions', () => {
  it('really runs the Linux-only executable suites wherever CI claims to', () => {
    if (!requireLinuxSuites) {
      // A workstation gates itself; the suites below report a skip rather than
      // a false failure. CI is the place this is enforced.
      expect(hasBash || !hasBash).toBe(true);
      return;
    }
    expect(hasBash, 'bash is required to run the Goobers step scripts').toBe(true);
    expect(hasJq, 'jq is required or every journal/receipt suite silently skips').toBe(true);
    expect(hasProc, '/proc is required or every process-teardown suite silently skips').toBe(true);
    expect(hasSetsid, 'setsid is required or the rootless reap suite silently skips').toBe(true);
  });
});

interface WorkflowShape {
  jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> } | undefined>;
}

/**
 * Returns a step's shell body with GitHub's `${{ ... }}` expressions already
 * substituted, exactly as the Actions runner hands it to bash. Left in place
 * they would be a bash bad-substitution error rather than the literal text the
 * runner interpolates.
 */
function stepScript(name: string, jobId = 'run'): string {
  const workflow = parse(
    readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'goobers-run.yml'), 'utf8'),
  ) as WorkflowShape;
  const step = workflow.jobs[jobId]?.steps?.find((candidate) => candidate.name === name);
  if (typeof step?.run !== 'string') {
    throw new Error(`goobers-run.yml job "${jobId}" has no shell step named "${name}"`);
  }
  return step.run.replace(/\$\{\{[^}]*\}\}/g, 'goobers-journal-artifact');
}

/**
 * `gh` and `goobers` are shell functions rather than files on PATH so the
 * harness stays portable across Git-Bash and Linux. Every invocation is
 * appended to STUB_LOG together with the GOOBERS_RUN_ID in scope, which is what
 * makes "one claim release per run" observable; `--body-file` payloads are
 * appended too so comment markers can be asserted.
 *
 * The `goobers` stub models the two behaviours the disposition step actually
 * depends on: `run abort` APPENDS a terminal `run.finished` to that run's
 * journal (Goobers' `runRunAbort` is journal repair, and the step re-reads the
 * journal to decide), and `backlog-query --release` succeeds.
 */
const STUBS = `
gh() {
  printf 'gh %s\\n' "$*" >> "$STUB_LOG"
  local previous="" argument=""
  for argument in "$@"; do
    if [ "$previous" = "--body-file" ]; then
      cat "$argument" >> "$STUB_LOG"
    fi
    previous="$argument"
  done
  case "$*" in
    *comments*) printf '[[]]\\n' ;;
    *timeline*) printf '[]\\n' ;;
    *blocked_by*) printf '[]\\n' ;;
  esac
  return 0
}

goobers() {
  printf 'goobers %s | run=%s\\n' "$*" "\${GOOBERS_RUN_ID:-none}" >> "$STUB_LOG"
  if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "abort" ]; then
    goobers_stub_abort "\${3:-}" "\${4:-}"
    return $?
  fi
  printf 'nothing to release: run holds no claim\\n'
  return 0
}

# Default repair: behave like \`goobers run abort\` and append the terminal
# event the step re-reads. Overridden per fixture below.
goobers_stub_abort() {
  local run_id="$1" slot_root="$2" events=""
  events="$(find "$slot_root/gaggles" -path "*/runs/$run_id/events.jsonl" -type f 2>/dev/null | head -n 1)"
  if [ -n "$events" ]; then
    printf '{"type":"run.finished","status":"aborted"}\\n' >> "$events"
  fi
  printf 'run %s aborted\\n' "$run_id"
  return 0
}
`;

/** \`goobers run abort\` exits non-zero and repairs nothing (abort-error). */
const ABORT_ERROR_STUBS = `${STUBS}
goobers_stub_abort() {
  printf 'abort failed: journal is unreadable\\n'
  return 1
}
`;

/**
 * \`goobers run abort\` reports success but the journal still has no terminal
 * phase (no-terminal) — the case a status-only check would wave through.
 */
const NO_TERMINAL_STUBS = `${STUBS}
goobers_stub_abort() {
  printf 'run %s already terminal\\n' "$1"
  return 0
}
`;

/** The provider claim marker cannot be retired (claim-release-error). */
const CLAIM_RELEASE_ERROR_STUBS = `${STUBS}
sleep() { :; }
goobers() {
  printf 'goobers %s | run=%s\\n' "$*" "\${GOOBERS_RUN_ID:-none}" >> "$STUB_LOG"
  if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "abort" ]; then
    goobers_stub_abort "\${3:-}" "\${4:-}"
    return $?
  fi
  printf 'release failed: provider rejected the breadcrumb delete\\n'
  return 1
}
`;

interface Journal {
  slot: string;
  runId: string;
  lines: string[];
}

const JOURNALS: Journal[] = [
  {
    // Slot 1: healthy run that opened a PR. Its issue keeps in-review
    // ownership, so it must NOT be label-edited.
    slot: '1',
    runId: 'run-aaa',
    lines: [
      '{"type":"stage.finished","stage":"query-backlog","status":"success","outputs":{"id":"101"}}',
      '{"type":"stage.finished","stage":"open-pr","status":"success","outputs":{"prNumber":"5001","pull-request-url":"https://github.com/nalfeo/Crawler/pull/5001"}}',
      '{"type":"run.finished","status":"completed"}',
    ],
  },
  {
    // Slot 2, run 1: the killed-process case. No run.finished at all, so its
    // claim must be released and its issue restored to retry eligibility --
    // this is precisely the run a newest-journal-only sweep would strand.
    slot: '2',
    runId: 'run-bbb',
    lines: [
      '{"type":"stage.finished","stage":"query-backlog","status":"success","outputs":{"id":"202"}}',
      '{"type":"stage.started","stage":"implement"}',
    ],
  },
  {
    // Slot 2, run 2: proves the enumeration is not one-run-per-slot either.
    // Ends with a completed-existing-work no-work disposition, plus a torn
    // final line to exercise the malformed-journal tolerance.
    slot: '2',
    runId: 'run-ccc',
    lines: [
      '{"type":"stage.finished","stage":"query-backlog","status":"success","outputs":{"id":"303"}}',
      '{"type":"stage.finished","stage":"implement","status":"no-work","outputs":{"disposition":"completed-existing-work"}}',
      '{"type":"run.finished","status":"completed"}',
      '{"type":"run.finis',
    ],
  },
];

interface Harness {
  stdout: string;
  stderr: string;
  status: number | null;
  log: string;
}

interface RunStepOptions {
  journals?: Journal[];
  stubs?: string;
  jobId?: string;
  env?: Record<string, string>;
}

function runStep(stepName: string, options: RunStepOptions = {}): Harness {
  const journals = options.journals ?? JOURNALS;
  const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-slot-'));
  const laneRoot = path.join(workdir, 'lane-1');
  for (const journal of journals) {
    const runDir = path.join(
      laneRoot,
      `slot-${journal.slot}`,
      'gaggles',
      'crawler',
      'runs',
      journal.runId,
    );
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'events.jsonl'), `${journal.lines.join('\n')}\n`, 'utf8');
  }

  const logPath = path.join(workdir, 'stub.log');
  writeFileSync(logPath, '', 'utf8');
  const scriptPath = path.join(workdir, 'step.sh');
  writeFileSync(
    scriptPath,
    `${options.stubs ?? STUBS}\n${stepScript(stepName, options.jobId ?? 'run')}\n`,
    'utf8',
  );

  const result = spawnSync('bash', [toBashScriptPath(scriptPath)], {
    encoding: 'utf8',
    env: bashEnv({
      STUB_LOG: toBashScriptPath(logPath),
      GOOBERS_LANE: '1',
      GOOBERS_SLOTS: '1 2',
      GOOBERS_LANE_ROOT: toBashScriptPath(laneRoot),
      GOOBERS_RECOVERY_LANE: '1',
      GOOBERS_RECOVERY_SLOT: '1',
      GOOBERS_WORKFLOW: 'crawler-feature-pr',
      GOOBERS_CLAIM_TOKEN: 'stub-pat',
      GH_TOKEN: 'stub-token',
      GITHUB_REPOSITORY: 'nalfeo/Crawler',
      GITHUB_RUN_ID: '999',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_REF_NAME: 'main',
      GITHUB_SHA: 'deadbeef',
      ARTIFACT_NAME: 'goobers-journal-artifact',
      RUN_JOURNAL_ARTIFACT_ID: '12345',
      // The lane job as a whole failed (slot 2's run died); the per-run
      // outcome must still be derived from each run's own journal.
      JOB_STATUS: 'failure',
      GOOBERS_RECOVERY_ISSUE: '',
      GOOBERS_RESUME_PR: '',
      ...options.env,
    }),
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    log: readFileSync(logPath, 'utf8'),
  };
}

describe.skipIf(!hasJq)('goobers-run.yml per-slot lifecycle cleanup', () => {
  it('releases the provider claim of every run in every slot', () => {
    const harness = runStep('Handle no-work disposition');

    expect(harness.status, `stderr:\n${harness.stderr}`).toBe(0);
    // One release per RUN, keyed by that run's id -- not one per slot and not
    // one for the newest journal only.
    for (const journal of JOURNALS) {
      expect(harness.log).toContain(`backlog-query --release`);
      expect(harness.log).toContain(`run=${journal.runId}`);
    }
    expect(harness.log.match(/backlog-query --release/g)).toHaveLength(JOURNALS.length);
    expect(harness.stdout).toContain(`Processed ${JOURNALS.length} Goobers run(s)`);
  });

  it('forces a terminal journal phase before releasing a killed run’s claim', () => {
    const harness = runStep('Handle no-work disposition');

    // run-bbb has no run.finished: its process was killed, so its journal still
    // says the run is live and its worktree is still checked out. `goobers run
    // abort` is the sanctioned daemon-down repair, and it has to happen BEFORE
    // that run's claim release or the claim ledger and the journal disagree.
    // The stub stamps every call with the GOOBERS_RUN_ID in scope, which is
    // what makes "this run's release" identifiable among three.
    const abortIndex = harness.log.indexOf('goobers run abort run-bbb');
    const releaseIndex = harness.log.indexOf('| run=run-bbb');
    expect(abortIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(abortIndex);

    // Runs that already recorded a terminal run.finished are left alone: a
    // second abort would append a second terminal event onto a finished run.
    expect(harness.log).not.toContain('goobers run abort run-aaa');
    expect(harness.log).not.toContain('goobers run abort run-ccc');
    expect(harness.log.match(/goobers run abort/g)).toHaveLength(1);
  });

  it('applies the correct per-run label disposition instead of a lane-wide one', () => {
    const harness = runStep('Handle no-work disposition');

    // Slot 2 run-bbb died mid-run with no PR: retry eligibility restored.
    expect(harness.log).toContain(
      'gh issue edit 202 --repo nalfeo/Crawler --remove-label goobers/status:in-review',
    );
    // Slot 2 run-ccc reported completed-existing-work: marked ineligible.
    expect(harness.log).toContain(
      'gh issue edit 303 --repo nalfeo/Crawler --add-label goobers/status:completed-existing-work --remove-label goobers/status:in-review',
    );
    // Slot 1 run-aaa completed and opened a PR. The lane's job status is
    // `failure` because of its sibling slot, and a lane-wide status check
    // would strip this healthy issue's ownership -- the per-run
    // `run.finished` phase is what prevents that.
    expect(harness.log).not.toContain('gh issue edit 101');
  });

  it('posts one distinctly keyed result comment per concurrent run', () => {
    const harness = runStep('Comment on Goobers run result');

    expect(harness.status, `stderr:\n${harness.stderr}`).toBe(0);
    expect(harness.stdout).toContain(`Reported ${JOURNALS.length} Goobers run(s)`);
    for (const issue of ['101', '202', '303']) {
      expect(harness.log).toContain(`gh issue comment ${issue} --repo nalfeo/Crawler --body-file`);
    }
    // Four runs share one Actions run id, so the comment marker has to carry
    // the Goobers run id or each slot would overwrite the previous slot's
    // comment.
    for (const journal of JOURNALS) {
      expect(harness.log).toContain(`goobers-run=${journal.runId}`);
      expect(harness.log).toContain(`slot=${journal.slot}`);
    }
    // Per-run status again: the sibling failure must not be reported on the
    // healthy run's issue.
    expect(harness.log).toContain('finished with **success**');
    expect(harness.log).toContain('finished with **failure**');
  });
});

/**
 * Executable regression for terminal-label idempotency (issues #3541, #4140).
 *
 * The disposition step used to probe for the terminal label with `gh label view
 * <name> || gh label create <name>`. `gh label` has NO `view` subcommand, so the
 * probe could never succeed and `gh label create` ran on every single
 * completed-existing-work disposition. On the ordinary already-exists path `gh
 * label create` exits 1 with "already exists; use `--force`", which under the
 * step's `set -euo pipefail` killed the step BEFORE
 * `goobers/status:completed-existing-work` was applied and
 * `goobers/status:in-review` removed. Production run 33938863082 left issue
 * #4140 exactly there: approved, in-review, no terminal label, no PR — poisoning
 * scheduled recovery at the head of the queue.
 *
 * These run the real step body against `gh` stubs that model the three states
 * the ensure has to survive: the label already exists, a concurrent slot wins
 * the create race, and the create genuinely fails.
 */
const LABEL_STUB_PREFIX = `${STUBS}
gh() {
  printf 'gh %s\\n' "$*" >> "$STUB_LOG"
  local status=0
  case "$*" in
    # \`gh label\` has no \`view\` subcommand. Modelling that faithfully is what
    # makes these fixtures a real regression rather than a hypothetical one.
    'label view'*) printf 'unknown command "view" for "gh label"\\n' >&2; status=1 ;;
    'label list'*) gh_stub_label_list; status=$? ;;
    'label create'*) gh_stub_label_create; status=$? ;;
    *comments*) printf '[[]]\\n' ;;
    *timeline*) printf '[]\\n' ;;
    *blocked_by*) printf '[]\\n' ;;
  esac
  return $status
}
`;

/** The label is already in the repository and the search index knows it. */
const LABEL_EXISTS_STUBS = `${LABEL_STUB_PREFIX}
gh_stub_label_list() {
  printf 'goobers:approved\\ngoobers/status:completed-existing-work\\n'
  return 0
}
gh_stub_label_create() {
  printf 'label with name "goobers/status:completed-existing-work" already exists; use \\\`--force\\\` to update its color and description\\n' >&2
  return 1
}
`;

/**
 * The search index has not caught up (or a sibling slot created the label
 * between the probe and the create), so the create loses the race.
 */
const LABEL_CREATE_RACE_STUBS = `${LABEL_STUB_PREFIX}
gh_stub_label_list() {
  return 0
}
gh_stub_label_create() {
  printf 'label with name "goobers/status:completed-existing-work" already exists; use \\\`--force\\\` to update its color and description\\n' >&2
  return 1
}
`;

/** The token genuinely cannot write labels. */
const LABEL_DENIED_STUBS = `${LABEL_STUB_PREFIX}
gh_stub_label_list() {
  return 1
}
gh_stub_label_create() {
  printf 'HTTP 403: Resource not accessible by integration\\n' >&2
  return 1
}
`;

describe.skipIf(!hasJq)('goobers-run.yml terminal label idempotency', () => {
  it('applies the terminal labels when the status label already exists', () => {
    const harness = runStep('Handle no-work disposition', { stubs: LABEL_EXISTS_STUBS });

    expect(harness.status, `stderr:\n${harness.stderr}`).toBe(0);
    expect(harness.log).toContain(
      'gh issue edit 303 --repo nalfeo/Crawler --add-label goobers/status:completed-existing-work --remove-label goobers/status:in-review',
    );
  });

  it('never calls `gh label create` for a label the repository already has', () => {
    const harness = runStep('Handle no-work disposition', { stubs: LABEL_EXISTS_STUBS });

    // The existence probe has to be a subcommand that actually exists. `gh
    // label view` does not, so the old probe always fell through to a create
    // that always failed.
    expect(harness.log).toContain(
      'gh label list --repo nalfeo/Crawler --search goobers/status:completed-existing-work',
    );
    expect(harness.log).not.toContain('gh label view');
    expect(harness.log).not.toContain('gh label create');
  });

  it('treats losing the label-create race as success, not as a failed disposition', () => {
    const harness = runStep('Handle no-work disposition', { stubs: LABEL_CREATE_RACE_STUBS });

    expect(harness.status, `stderr:\n${harness.stderr}`).toBe(0);
    expect(harness.log).toContain('gh label create goobers/status:completed-existing-work');
    expect(harness.log).toContain(
      'gh issue edit 303 --repo nalfeo/Crawler --add-label goobers/status:completed-existing-work --remove-label goobers/status:in-review',
    );
    // An already-exists create is the desired end state, so it must not be
    // reported as a problem.
    expect(harness.stderr).not.toContain('Could not ensure label');
  });

  it('reports a genuine label-create failure while still releasing the issue', () => {
    const harness = runStep('Handle no-work disposition', { stubs: LABEL_DENIED_STUBS });

    // Best-effort, not fail-closed: the probe may be what failed, so the issue
    // edit stays the authority and the disposition still lands.
    expect(harness.status, `stderr:\n${harness.stderr}`).toBe(0);
    expect(harness.stderr).toContain(
      "Could not ensure label 'goobers/status:completed-existing-work' exists in nalfeo/Crawler",
    );
    // The failure names the remediation rather than surfacing a bare gh error.
    expect(harness.stderr).toContain(
      "gh label create 'goobers/status:completed-existing-work' --repo nalfeo/Crawler --color 0e8a16",
    );
    expect(harness.log).toContain(
      'gh issue edit 303 --repo nalfeo/Crawler --add-label goobers/status:completed-existing-work --remove-label goobers/status:in-review',
    );
  });
});

/**
 * Executable regression for PER-SLOT recovery-journal synthesis.
 *
 * The reserved issue already carries `goobers/status:in-review` and belongs to
 * exactly one slot. Both post-processing steps used to synthesize a record for
 * it only when the LANE produced no journal at all — so a healthy sibling slot's
 * journal satisfied the check, and the reserved issue got no disposition and no
 * terminal comment while the step still exited 0. `Record reservation disposal`
 * is gated on that exit status, so it then wrote a disposal receipt claiming a
 * clean hand-back that never happened, publishing a possibly-live issue to the
 * next dispatch.
 */
const SIBLING_ONLY_JOURNALS: Journal[] = [
  {
    // Slot 2 (a FRESH slot) ran fine. Slot 1 — the recovery slot — produced no
    // journal at all: its binary download or instance validation failed.
    slot: '2',
    runId: 'run-sibling',
    lines: [
      '{"type":"stage.finished","stage":"query-backlog","status":"success","outputs":{"id":"606"}}',
      '{"type":"run.finished","status":"completed"}',
    ],
  },
];

describe.skipIf(!hasJq)('goobers-run.yml journal-less recovery slot', () => {
  const recoveryEnv = { GOOBERS_RECOVERY_ISSUE: '42', GOOBERS_RESUME_PR: '' };

  it('dispositions the reserved issue even when a sibling slot did produce a journal', () => {
    const harness = runStep('Handle no-work disposition', {
      journals: SIBLING_ONLY_JOURNALS,
      env: recoveryEnv,
    });

    expect(harness.status, `stderr:\n${harness.stderr}`).toBe(0);
    // The recovery slot's own record was synthesized and processed...
    expect(harness.stdout).toContain('Slot 1 run <no journal>: issue=#42');
    // ...and its issue really was decided, not silently skipped. No open PR
    // exists (the stubbed timeline is empty), so retry eligibility is restored.
    expect(harness.log).toContain(
      'gh issue edit 42 --repo nalfeo/Crawler --remove-label goobers/status:in-review',
    );
    // The sibling slot is still processed normally: two records, not one.
    expect(harness.stdout).toContain('Processed 2 Goobers run(s)');
  });

  it('posts a terminal comment on the reserved issue alongside the sibling’s', () => {
    const harness = runStep('Comment on Goobers run result', {
      journals: SIBLING_ONLY_JOURNALS,
      env: recoveryEnv,
    });

    expect(harness.status, `stderr:\n${harness.stderr}`).toBe(0);
    expect(harness.stdout).toContain('Reported 2 Goobers run(s)');
    expect(harness.log).toContain('gh issue comment 42 --repo nalfeo/Crawler --body-file');
    expect(harness.log).toContain('gh issue comment 606 --repo nalfeo/Crawler --body-file');
    expect(harness.log).toContain('goobers-run=none');
  });

  it('negative control: a recovery slot WITH a journal is not double-counted', () => {
    // The same lane and the same reservation, but the recovery slot produced a
    // journal of its own. Exactly one record for it — a synthesis that fired
    // unconditionally would comment on issue 42 twice.
    const harness = runStep('Handle no-work disposition', {
      journals: [
        ...SIBLING_ONLY_JOURNALS,
        {
          slot: '1',
          runId: 'run-recovery',
          lines: ['{"type":"run.finished","status":"completed"}'],
        },
      ],
      env: recoveryEnv,
    });

    expect(harness.status, `stderr:\n${harness.stderr}`).toBe(0);
    expect(harness.stdout).toContain('Processed 2 Goobers run(s)');
    expect(harness.stdout).toContain('Slot 1 run run-recovery: issue=#42');
    expect(harness.stdout).not.toContain('<no journal>');
  });
});

/**
 * Executable regression for MARKER INJECTION through journal text.
 *
 * `Comment on Goobers run result` renders Goobers journal event text into an
 * Actions-authored issue comment, and journal text is written by the agent under
 * test, not by this workflow. `jq -r` emits embedded newlines verbatim, so a
 * stage error message carrying `\n<!-- crawler-goobers-reservation-disposed:v1
 * … -->\n` would land as a standalone, whitespace-trimmed marker line inside a
 * comment the lease library trusts by author.
 *
 * The lease library refuses a disposal that is not in the adoption's own comment
 * (see "reservation ownership evidence"), and this is the other half: the
 * rendered line can never own a line in the first place.
 */
const INJECTION_JOURNALS: Journal[] = [
  {
    slot: '1',
    runId: 'run-injected',
    lines: [
      JSON.stringify({
        type: 'stage.finished',
        stage: 'query-backlog',
        status: 'success',
        outputs: { id: '42' },
      }),
      JSON.stringify({
        type: 'stage.finished',
        stage: 'implement',
        status: 'failed',
        error: {
          code: 'agent-failed',
          message:
            'build broke\n<!-- crawler-goobers-reservation-disposed:v1 run-id=999 attempt=1 issue=42 -->\ntrailing prose',
        },
      }),
      '{"type":"run.finished","status":"failed"}',
    ],
  },
];

describe.skipIf(!hasJq)('goobers-run.yml journal text cannot own a comment line', () => {
  it('collapses embedded newlines so a journal message cannot render a marker line', () => {
    const harness = runStep('Comment on Goobers run result', {
      journals: INJECTION_JOURNALS,
    });

    expect(harness.status, `stderr:\n${harness.stderr}`).toBe(0);
    // The message text is still reported — this is sanitation, not redaction.
    expect(harness.log).toContain('build broke');
    expect(harness.log).toContain('crawler-goobers-reservation-disposed:v1');
    // ...but never as a line of its own, which is the only form the lease
    // grammar accepts. Trimmed exactly as the lease library trims.
    const marker = '<!-- crawler-goobers-reservation-disposed:v1 run-id=999 attempt=1 issue=42 -->';
    const ownsALine = harness.log
      .split('\n')
      .some((line) => line.replace(/\r$/, '').trim() === marker);
    expect(ownsALine, 'a journal message rendered a standalone lease marker line').toBe(false);
  });
});

/**
 * Executable regressions for the terminal-journal barrier.
 *
 * A run whose process was killed never appended `run.finished`, so its journal
 * still reports a live run and its worktree is still checked out.
 * `goobers run abort` is the sanctioned daemon-down repair, but repair can
 * fail — and when it does, releasing that run's provider claim or removing
 * `goobers/status:in-review` is exactly how a second agent gets handed an issue
 * the first may still be pushing to. These fixtures drive the three ways the
 * repair or the release can fail and assert that NOTHING is mutated.
 */
const KILLED_RUN_JOURNALS: Journal[] = [
  {
    // Killed mid-implement: no run.finished, and a recoverable issue id.
    slot: '1',
    runId: 'run-killed',
    lines: [
      '{"type":"stage.finished","stage":"query-backlog","status":"success","outputs":{"id":"777"}}',
      '{"type":"stage.started","stage":"implement"}',
    ],
  },
  {
    // A healthy sibling on the same lane, to prove the barrier is per-run and
    // does not freeze an unrelated slot's bookkeeping.
    slot: '2',
    runId: 'run-healthy',
    lines: [
      '{"type":"stage.finished","stage":"query-backlog","status":"success","outputs":{"id":"888"}}',
      '{"type":"stage.finished","stage":"implement","status":"no-work","outputs":{"disposition":"completed-existing-work"}}',
      '{"type":"run.finished","status":"completed"}',
    ],
  },
];

describe.skipIf(!hasJq)('goobers-run.yml terminal-journal barrier', () => {
  it('repairs a killed run and only then releases and relabels it', () => {
    const harness = runStep('Handle no-work disposition', { journals: KILLED_RUN_JOURNALS });

    // Control case: the repair takes, so the run has a verified terminal phase
    // and the normal disposition applies.
    expect(harness.status, `stderr:\n${harness.stderr}`).toBe(0);
    expect(harness.log).toContain('goobers run abort run-killed');
    expect(harness.log).toContain('| run=run-killed');
    expect(harness.log).toContain(
      'gh issue edit 777 --repo nalfeo/Crawler --remove-label goobers/status:in-review',
    );
  });

  it('refuses to release or relabel when `goobers run abort` errors', () => {
    const harness = runStep('Handle no-work disposition', {
      journals: KILLED_RUN_JOURNALS,
      stubs: ABORT_ERROR_STUBS,
    });

    expect(harness.status).not.toBe(0);
    expect(harness.stderr).toContain('has no verified terminal run.finished');
    expect(harness.stderr).toContain('Refusing to release its provider claim or change');
    // No claim release for the unrepaired run, and no label mutation at all
    // for its issue.
    expect(harness.log).not.toContain('| run=run-killed');
    expect(harness.log).not.toContain('gh issue edit 777');
    // The healthy sibling run is still processed: the barrier is per run.
    expect(harness.log).toContain('| run=run-healthy');
    expect(harness.log).toContain(
      'gh issue edit 888 --repo nalfeo/Crawler --add-label goobers/status:completed-existing-work --remove-label goobers/status:in-review',
    );
  });

  it('refuses when the repair reports success but the journal is still non-terminal', () => {
    const harness = runStep('Handle no-work disposition', {
      journals: KILLED_RUN_JOURNALS,
      stubs: NO_TERMINAL_STUBS,
    });

    // The abort's exit status is not the authority — the journal re-read is.
    expect(harness.log).toContain('goobers run abort run-killed');
    expect(harness.status).not.toBe(0);
    expect(harness.stderr).toContain('has no verified terminal run.finished');
    expect(harness.log).not.toContain('| run=run-killed');
    expect(harness.log).not.toContain('gh issue edit 777');
  });

  it('treats a failed provider claim release as a barrier to label removal', () => {
    const harness = runStep('Handle no-work disposition', {
      journals: KILLED_RUN_JOURNALS,
      stubs: CLAIM_RELEASE_ERROR_STUBS,
    });

    expect(harness.status).not.toBe(0);
    // Three bounded attempts, then a stop — not a warning that lets the label
    // edit proceed. An issue whose status label is removed while its claim
    // survives is permanently unclaimable, which is strictly worse than a
    // label that stayed set.
    expect(harness.log.match(/backlog-query --release/g)?.length).toBeGreaterThanOrEqual(3);
    expect(harness.stderr).toContain('still holds its Goobers provider claim');
    expect(harness.stderr).toContain('becomes permanently unclaimable');
    expect(harness.log).not.toContain('gh issue edit 777');
    expect(harness.log).not.toContain('gh issue edit 888');
  });
});

/**
 * Executable regression for the expected-empty-slot case.
 *
 * The reserve job only proves that at least ONE eligible issue exists, and then
 * up to four slots race for the backlog through the provider claim protocol. A
 * slot that finds the work already claimed reports a no-work at the CLAIM stage
 * with no issue id — deterministic proof that it claimed nothing, so it owns no
 * label, no comment and no failure.
 */
const EMPTY_SLOT_JOURNALS: Journal[] = [
  {
    slot: '2',
    runId: 'run-empty',
    lines: [
      '{"type":"stage.finished","stage":"query-backlog","status":"no-work","outputs":{"disposition":"no-eligible-items"}}',
      '{"type":"run.finished","status":"completed"}',
    ],
  },
];

describe.skipIf(!hasJq)('goobers-run.yml expected empty slot', () => {
  it('reports a clean no-claim with no mutation and no error', () => {
    const harness = runStep('Handle no-work disposition', { journals: EMPTY_SLOT_JOURNALS });

    expect(harness.status, `stderr:\n${harness.stderr}`).toBe(0);
    expect(harness.stderr).not.toContain('::error::');
    expect(harness.stdout).toContain('found no unclaimed backlog item');
    // Claim-ledger hygiene still runs (it short-circuits with no network call
    // when the run holds nothing), but nothing is relabelled.
    expect(harness.log).toContain('backlog-query --release');
    expect(harness.log).not.toContain('gh issue edit');
  });

  it('posts no issue comment for a slot that claimed nothing', () => {
    const harness = runStep('Comment on Goobers run result', { journals: EMPTY_SLOT_JOURNALS });

    expect(harness.status, `stderr:\n${harness.stderr}`).toBe(0);
    expect(harness.stdout).toContain('skipping issue comment');
    expect(harness.log).not.toContain('gh issue comment');
  });
});

/**
 * `Run the workflow` launches its slots with `exec goobers ...`, which cannot
 * resolve a shell function, so this harness installs a real `goobers` stub on
 * PATH instead. The stub brackets a sleep with start/end markers: if the two
 * slots were sequential the log would read start,end,start,end, and only a
 * genuinely simultaneous launch produces start,start,...
 */
const RUN_STEP_STUB = `#!/usr/bin/env bash
printf 'start instance=%s recovery=%s\\n' "\${GOOBERS_INSTANCE:-unset}" "\${GOOBERS_RECOVERY_ISSUE:-none}" >> "\${STUB_LOG}"
sleep 1
printf 'end instance=%s recovery=%s\\n' "\${GOOBERS_INSTANCE:-unset}" "\${GOOBERS_RECOVERY_ISSUE:-none}" >> "\${STUB_LOG}"
`;

/**
 * The absolute job-budget anchor every "Run the workflow" harness needs. The
 * step derives its slot deadline from (job budget - elapsed setup - cleanup
 * reserve), so these are as load-bearing as GOOBERS_SLOT_DEADLINE_SECONDS.
 */
function jobBudgetEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    GOOBERS_JOB_START_EPOCH: String(Math.floor(Date.now() / 1000)),
    GOOBERS_JOB_TIMEOUT_MINUTES: '90',
    GOOBERS_JOB_START_SLACK_SECONDS: '90',
    GOOBERS_SLOT_POLL_SECONDS: '10',
    GOOBERS_CLEANUP_RESERVE_SECONDS: '2100',
    ...overrides,
  };
}

describe.skipIf(!hasBash)('goobers-run.yml slot concurrency', () => {
  it('runs both slots at the same time, each on its own instance root, with one recovery slot', () => {
    const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-run-'));
    const binDir = path.join(workdir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const logPath = path.join(workdir, 'stub.log');
    writeFileSync(logPath, '', 'utf8');

    const stubPath = path.join(binDir, 'goobers');
    writeFileSync(stubPath, RUN_STEP_STUB, 'utf8');
    chmodSync(stubPath, 0o755);

    const scriptPath = path.join(workdir, 'run-step.sh');
    writeFileSync(
      scriptPath,
      // `cd … && pwd` normalises the stub directory into the shell's own path
      // form before it joins PATH: an MSYS bash silently ignores a
      // drive-letter PATH entry, and this is a no-op on Linux.
      `export PATH="$(cd "${toBashScriptPath(binDir)}" && pwd):$PATH"\n${stepScript('Run the workflow')}\n`,
      'utf8',
    );

    const result = spawnSync('bash', [toBashScriptPath(scriptPath)], {
      encoding: 'utf8',
      env: bashEnv({
        STUB_LOG: toBashScriptPath(logPath),
        GOOBERS_LANE: '1',
        GOOBERS_SLOTS: '1 2',
        GOOBERS_LANE_ROOT: toBashScriptPath(path.join(workdir, 'lane-1')),
        GOOBERS_RECOVERY_LANE: '1',
        GOOBERS_RECOVERY_SLOT: '1',
        GOOBERS_RECOVERY_ISSUE: '42',
        GOOBERS_RESUME_PR: '7',
        GOOBERS_RESUME_BRANCH: 'goobers/crawler/x',
        GOOBERS_SLOT_DEADLINE_SECONDS: '120',
        GOOBERS_WORKFLOW: 'crawler-feature-pr',
        GITHUB_RUN_ID: '999',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_WORKSPACE: toBashScriptPath(REPO_ROOT),
        RUNNER_TEMP: toBashScriptPath(workdir),
        ...jobBudgetEnv(),
      }),
    });

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');

    // Both slots are in flight before either finishes: real simultaneity,
    // not a sequential recovery-then-fresh sequence.
    expect(lines).toHaveLength(4);
    expect(lines[0]?.startsWith('start ')).toBe(true);
    expect(lines[1]?.startsWith('start ')).toBe(true);
    expect(lines[2]?.startsWith('end ')).toBe(true);
    expect(lines[3]?.startsWith('end ')).toBe(true);

    // Each slot has its own instance root -- no two runs share a checkout.
    const starts = lines.filter((line) => line.startsWith('start '));
    const instances = starts.map((line) => /instance=(\S+)/.exec(line)?.[1] ?? '');
    expect(new Set(instances).size).toBe(2);
    expect(instances.some((value) => value.endsWith('/slot-1'))).toBe(true);
    expect(instances.some((value) => value.endsWith('/slot-2'))).toBe(true);

    // Exactly one slot carries the recovery target; the other claims fresh.
    const recoveries = starts.map((line) => /recovery=(\S+)/.exec(line)?.[1] ?? '');
    expect(recoveries.filter((value) => value === '42')).toHaveLength(1);
    expect(recoveries.filter((value) => value === 'none')).toHaveLength(1);
    const recoveryStart = starts.find((line) => line.includes('recovery=42')) ?? '';
    expect(recoveryStart).toContain('/slot-1 ');
  }, 60_000);
});

/**
 * Executable interleaving regression for the reservation ordering.
 *
 * The hazard: the recovery branch of crawler-feature-pr.yaml's query-backlog
 * stage does NOT go through Goobers' provider claim protocol, so
 * `goobers/status:in-review` is the only barrier between the resuming slot and
 * the three fresh ones. When both matrix legs resolved the target themselves,
 * leg 2's fresh slots could run their claim scan before leg 1 had applied the
 * label — two agents on one issue.
 *
 * The fix is a dedicated `reserve` job both legs declare in `needs:`, so the
 * label is applied and confirmed before either lane exists. This test runs the
 * real reservation script and the real slot-launch script against one shared
 * fake provider, in the two possible interleavings:
 *
 *   ordered  (what `needs:` guarantees) -> both fresh slots SKIP the issue
 *   unordered (the pre-fix shape)       -> both fresh slots CLAIM the issue
 *
 * The negative control is what makes the positive case meaningful: it proves
 * the ordering is load-bearing rather than the stub being incapable of
 * claiming.
 */
const RESERVATION_GH_STUB = `
gh() {
  printf 'gh %s\\n' "$*" >> "$STUB_LOG"
  case "$*" in
    *--add-label*)
      printf 'goobers/status:in-review\\n' >> "$PROVIDER_STATE"
      ;;
    *state,labels,assignees*)
      # The canonical selector reads number/author too; without them the
      # run-start revalidation judges this issue ineligible.
      printf '{"number":42,"state":"OPEN","labels":[{"name":"goobers:approved"}],"assignees":[],"author":{"login":"nalfeo"}}\\n'
      ;;
    *blocked_by*)
      ;;
    *labels=goobers:approved*)
      cat "$PROVIDER_STATE"
      ;;
    *comments*)
      printf '[[]]\\n'
      ;;
  esac
  return 0
}
`;

/**
 * A `goobers` stand-in that performs the one decision that matters here: a
 * fresh backlog claim scan honours excludeLabels, so it takes the issue only
 * while the reservation is absent.
 */
const CLAIM_SCAN_STUB = `#!/usr/bin/env bash
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "abort" ]; then
  exit 0
fi
if grep -qxF 'goobers/status:in-review' "\${PROVIDER_STATE}" 2>/dev/null; then
  printf 'SKIPPED 42 instance=%s\\n' "\${GOOBERS_INSTANCE:-unset}" >> "\${CLAIM_LOG}"
else
  printf 'CLAIMED 42 instance=%s\\n' "\${GOOBERS_INSTANCE:-unset}" >> "\${CLAIM_LOG}"
fi
exit 0
`;

interface InterleavingResult {
  claimLog: string;
  reserveStdout: string;
  reserveStderr: string;
  reserveStatus: number | null;
  runStatus: number | null;
  runStderr: string;
}

function runReservationInterleaving(reserveFirst: boolean): InterleavingResult {
  const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-reserve-'));
  const binDir = path.join(workdir, 'bin');
  mkdirSync(binDir, { recursive: true });

  const providerState = path.join(workdir, 'issue-42-labels.txt');
  // The reserved issue starts life as a plain approved backlog item.
  writeFileSync(providerState, 'goobers:approved\n', 'utf8');
  const claimLog = path.join(workdir, 'claims.log');
  writeFileSync(claimLog, '', 'utf8');
  const stubLog = path.join(workdir, 'gh.log');
  writeFileSync(stubLog, '', 'utf8');

  const claimStub = path.join(binDir, 'goobers');
  writeFileSync(claimStub, CLAIM_SCAN_STUB, 'utf8');
  chmodSync(claimStub, 0o755);

  const sharedEnv = {
    STUB_LOG: toBashScriptPath(stubLog),
    PROVIDER_STATE: toBashScriptPath(providerState),
    CLAIM_LOG: toBashScriptPath(claimLog),
    GITHUB_REPOSITORY: 'nalfeo/Crawler',
    GITHUB_RUN_ID: '999',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKSPACE: toBashScriptPath(REPO_ROOT),
    GOOBERS_WORKFLOW: 'crawler-feature-pr',
    GOOBERS_RECOVERY_LANE: '1',
    GOOBERS_RECOVERY_SLOT: '1',
    // The run-start race guard re-judges the issue with the canonical
    // selector, which fails closed without these.
    LIFECYCLE_MUTATION_OWNER: 'goobers',
    ISSUE_OWNER: 'nalfeo',
  };

  let reserveStdout = '';
  let reserveStderr = '';
  let reserveStatus: number | null = 0;
  if (reserveFirst) {
    const reservePath = path.join(workdir, 'reserve.sh');
    writeFileSync(
      reservePath,
      `${RESERVATION_GH_STUB}\n${stepScript(
        'Reserve the recovery target and comment on Goobers run start',
        'reserve',
      )}\n`,
      'utf8',
    );
    const reserve = spawnSync('bash', [toBashScriptPath(reservePath)], {
      encoding: 'utf8',
      env: bashEnv({
        ...sharedEnv,
        RESERVED_ISSUE: '42',
        RESOLVED_INTAKE_COHORT: 'approved',
        // The run-start revalidation stages its selector payload as a file.
        RUNNER_TEMP: toBashScriptPath(workdir),
      }),
    });
    reserveStdout = reserve.stdout ?? '';
    reserveStderr = reserve.stderr ?? '';
    reserveStatus = reserve.status;
  }

  // Lane 2: no recovery metadata at all, so BOTH of its slots take the fresh
  // `goobers backlog-query --claim` path — the exact leg that raced.
  const runPath = path.join(workdir, 'run-step.sh');
  writeFileSync(
    runPath,
    `export PATH="$(cd "${toBashScriptPath(binDir)}" && pwd):$PATH"\n${stepScript(
      'Run the workflow',
    )}\n`,
    'utf8',
  );
  const run = spawnSync('bash', [toBashScriptPath(runPath)], {
    encoding: 'utf8',
    env: bashEnv({
      ...sharedEnv,
      GOOBERS_LANE: '2',
      GOOBERS_SLOTS: '1 2',
      GOOBERS_LANE_ROOT: toBashScriptPath(path.join(workdir, 'lane-2')),
      GOOBERS_RECOVERY_ISSUE: '',
      GOOBERS_RESUME_PR: '',
      GOOBERS_RESUME_BRANCH: '',
      GOOBERS_SLOT_DEADLINE_SECONDS: '120',
      RUNNER_TEMP: toBashScriptPath(workdir),
      ...jobBudgetEnv(),
    }),
  });

  return {
    claimLog: readFileSync(claimLog, 'utf8'),
    reserveStdout,
    reserveStderr,
    reserveStatus,
    runStatus: run.status,
    runStderr: run.stderr ?? '',
  };
}

describe.skipIf(!hasJq)('goobers-run.yml recovery reservation ordering', () => {
  it('keeps every fresh slot off the reserved issue once the reservation has landed', () => {
    const ordered = runReservationInterleaving(true);

    expect(ordered.reserveStatus, `stderr:\n${ordered.reserveStderr}`).toBe(0);
    expect(ordered.runStatus, `stderr:\n${ordered.runStderr}`).toBe(0);
    // The reservation is not merely written — it is confirmed through the same
    // REST read a fresh claim performs, so the job cannot finish while the
    // label is still invisible.
    expect(ordered.reserveStdout).toContain('confirmed it through the backlog read path');
    // Both of lane 2's fresh slots looked at the reserved issue and declined.
    expect(ordered.claimLog.match(/SKIPPED 42/g)).toHaveLength(2);
    expect(ordered.claimLog).not.toContain('CLAIMED 42');
  }, 60_000);

  it('negative control: an unreserved target is claimed by the fresh slots', () => {
    const unordered = runReservationInterleaving(false);

    // Same scripts, same stub, only the ordering removed. Both fresh slots take
    // the issue, which is exactly the duplicate work `needs: reserve` prevents.
    expect(unordered.runStatus, `stderr:\n${unordered.runStderr}`).toBe(0);
    expect(unordered.claimLog.match(/CLAIMED 42/g)).toHaveLength(2);
    expect(unordered.claimLog).not.toContain('SKIPPED 42');
  }, 60_000);
});

/**
 * Executable deadline-path regression for the stage process tree.
 *
 * Goobers detaches every stage into its OWN SESSION (Setsid, not Setpgid —
 * internal/platform/proc/proc_unix.go), and the runner dispatches an in-flight
 * attempt on context.WithoutCancel, so signalling the `goobers run` pid leaves
 * the Copilot/verification children running while the job goes on to release
 * provider claims and issue labels. This stub reproduces that process model —
 * a session-detached grandchild that outlives its parent and heartbeats to a
 * file — and the test proves the deadline path leaves nothing behind.
 *
 * `setsid` is used when available (always on the ubuntu-latest runner that
 * executes this suite) so the real detached-session shape is exercised; a
 * workstation without it still gets the reparented-orphan shape.
 */
const DEADLINE_STUB = `#!/usr/bin/env bash
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "abort" ]; then
  exit 0
fi
heartbeat="\${HEARTBEAT_FILE}"
detach() {
  bash -c 'printf "%s\\n" "$$" > "$1"; while true; do printf "beat\\n" >> "$2"; sleep 0.2; done' _ "\${DESCENDANT_PID_FILE}" "\${heartbeat}" &
}
if command -v setsid >/dev/null 2>&1; then
  setsid bash -c 'printf "%s\\n" "$$" > "$1"; while true; do printf "beat\\n" >> "$2"; sleep 0.2; done' _ "\${DESCENDANT_PID_FILE}" "\${heartbeat}" &
else
  detach
fi
# The slot itself never returns on its own: only the deadline stops it.
sleep 600
`;

describe.skipIf(!hasProc)('goobers-stage-teardown.sh fail-closed behaviour', () => {
  it('refuses to sweep when the snapshot does not contain its own process', () => {
    const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-failclosed-'));
    const bogusSnapshot = path.join(workdir, 'snapshot.txt');
    // A snapshot with no entry for the sweeping shell is exactly what a
    // truncated /proc read produces. Without the guard, the session check
    // degrades to a sentinel no process has and the runner's own processes stop
    // being excluded -- so this must fail rather than proceed.
    writeFileSync(bogusSnapshot, '999999 1 999999 1\n', 'utf8');

    const scriptPath = path.join(workdir, 'probe.sh');
    writeFileSync(
      scriptPath,
      [
        `. "${toBashScriptPath(path.join(REPO_ROOT, 'scripts', 'agent', 'goobers-stage-teardown.sh'))}"`,
        `goobers_teardown_members "${toBashScriptPath(bogusSnapshot)}" "/fake/slot-1" 999999:1`,
        'exit $?',
      ].join('\n'),
      'utf8',
    );

    const result = spawnSync('bash', [toBashScriptPath(scriptPath)], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stdout ?? '').toBe('');
    expect(result.stderr ?? '').toContain('could not find its own process');
    expect(result.stderr ?? '').toContain('Refusing to signal anything');
  });

  it('refuses a bare root pid instead of guessing at a recycled one', () => {
    const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-rootschema-'));
    const scriptPath = path.join(workdir, 'probe.sh');
    writeFileSync(
      scriptPath,
      [
        `. "${toBashScriptPath(path.join(REPO_ROOT, 'scripts', 'agent', 'goobers-stage-teardown.sh'))}"`,
        // A pid with no start time is precisely the shape that cannot tell the
        // launched process from whatever Linux recycled that pid onto, so it is
        // a usage error (exit 2), not a best-effort sweep.
        `goobers_teardown_tree "${toBashScriptPath(path.join(workdir, 'slot-1'))}" 1 4242`,
        'exit $?',
      ].join('\n'),
      'utf8',
    );

    const result = spawnSync('bash', [toBashScriptPath(scriptPath)], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr ?? '').toContain('<pid>:<start-time>');
    expect(result.stderr ?? '').toContain('goobers_teardown_pid_start');
  });

  it('snapshots the live process tree rather than a prefix of /proc', () => {
    const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-snapshot-'));
    const scriptPath = path.join(workdir, 'probe.sh');
    writeFileSync(
      scriptPath,
      [
        `. "${toBashScriptPath(path.join(REPO_ROOT, 'scripts', 'agent', 'goobers-stage-teardown.sh'))}"`,
        'sleep 20 &',
        'child=$!',
        'snapshot="$(mktemp)"',
        'goobers_teardown_snapshot > "$snapshot"',
        'awk -v t="$$" \'$1 == t { print "SELF" }\' "$snapshot"',
        'awk -v t="$child" \'$1 == t { print "CHILD" }\' "$snapshot"',
        'kill -9 "$child" 2>/dev/null || true',
      ].join('\n'),
      'utf8',
    );

    const result = spawnSync('bash', [toBashScriptPath(scriptPath)], { encoding: 'utf8' });
    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    // Both the sweeping shell and a process created after it must be present.
    // A snapshot built by handing the /proc glob to awk truncates at the first
    // pid that exits mid-read, which is exactly what these two assertions catch.
    expect(result.stdout).toContain('SELF');
    expect(result.stdout).toContain('CHILD');
  }, 30_000);
});

/**
 * Executable regression for ROOT PID REUSE.
 *
 * The deadline path seeds the sweep from each slot's `goobers run` pid, and it
 * does so up to ~55 minutes after that pid was launched. Linux recycles pids,
 * so by then "pid 4321" may be an entirely unrelated process — plausibly one of
 * the Actions runner's own. Seeding from it would kill that process, its
 * children, and (through the session axis) its whole session, on a runner the
 * job does not own exclusively.
 *
 * A pid alone cannot express "the process I launched"; (pid, start time) can.
 * These tests use a REAL live process with a deliberately wrong expected start
 * time — which is exactly the observable state a recycled pid produces — and
 * assert it and its session survive untouched. The positive control runs the
 * identical setup with the CORRECT start time and asserts the same tree IS torn
 * down, so the negative case proves the guard rather than an inert sweep.
 */
describe.skipIf(!hasProc)('goobers-stage-teardown.sh root pid reuse', () => {
  interface Replacement {
    workdir: string;
    slotRoot: string;
    leaderPid: string;
    childPid: string;
  }

  /**
   * A process leading a child of its own, carrying NO GOOBERS_INSTANCE — an
   * unrelated process that merely happens to hold a pid the caller once
   * launched a slot on. `setsid` is used when available (always on the
   * ubuntu-latest runner that enforces this suite) so the session axis is
   * exercised too; a workstation without it still gets the parenthood axis,
   * which is the one the seed drives directly.
   */
  function spawnUnrelatedReplacement(): Replacement {
    const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-pidreuse-'));
    const slotRoot = `${toBashScriptPath(workdir)}/slot-1`;
    mkdirSync(path.join(workdir, 'slot-1'), { recursive: true });
    const leaderPidFile = path.join(workdir, 'leader.pid');
    const childPidFile = path.join(workdir, 'child.pid');
    writeFileSync(leaderPidFile, '', 'utf8');
    writeFileSync(childPidFile, '', 'utf8');

    const leaderScript = path.join(workdir, 'leader.sh');
    writeFileSync(
      leaderScript,
      [
        `printf '%s\\n' "$$" > "${toBashScriptPath(leaderPidFile)}"`,
        `bash -c 'printf "%s\\n" "$$" > "$1"; exec sleep 45' _ "${toBashScriptPath(childPidFile)}" &`,
        'sleep 45',
      ].join('\n'),
      'utf8',
    );
    const detach = hasSetsid ? 'setsid ' : '';
    const launch = spawnSync(
      'bash',
      [
        '-c',
        `${detach}bash "${toBashScriptPath(leaderScript)}" >/dev/null 2>&1 < /dev/null &
         disown -a
         sleep 1`,
      ],
      { encoding: 'utf8' },
    );
    expect(launch.status, `stderr:\n${launch.stderr}`).toBe(0);

    const leaderPid = readFileSync(leaderPidFile, 'utf8').trim();
    const childPid = readFileSync(childPidFile, 'utf8').trim();
    expect(leaderPid, 'the replacement leader never recorded its pid').toMatch(/^\d+$/);
    expect(childPid, 'the replacement child never recorded its pid').toMatch(/^\d+$/);

    return { workdir, slotRoot, leaderPid, childPid };
  }

  function startTimeOf(pid: string): string {
    const probe = spawnSync(
      'bash',
      [
        '-c',
        `. "${toBashScriptPath(path.join(REPO_ROOT, 'scripts', 'agent', 'goobers-stage-teardown.sh'))}"; goobers_teardown_pid_start ${pid}`,
      ],
      { encoding: 'utf8' },
    );
    return (probe.stdout ?? '').trim();
  }

  function tearDownWithRoot(
    replacement: Replacement,
    root: string,
  ): { status: number | null; stdout: string; stderr: string } {
    const scriptPath = path.join(replacement.workdir, 'teardown.sh');
    writeFileSync(
      scriptPath,
      [
        `. "${toBashScriptPath(path.join(REPO_ROOT, 'scripts', 'agent', 'goobers-stage-teardown.sh'))}"`,
        `goobers_teardown_tree "${replacement.slotRoot}" 2 "${root}"`,
        'exit $?',
      ].join('\n'),
      'utf8',
    );
    const result = spawnSync('bash', [toBashScriptPath(scriptPath)], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  function isAlive(pid: string): boolean {
    return spawnSync('bash', ['-c', `kill -0 ${pid} 2>/dev/null`]).status === 0;
  }

  it('never signals a recycled root pid, its children or its session', () => {
    const replacement = spawnUnrelatedReplacement();
    try {
      const realStart = startTimeOf(replacement.leaderPid);
      expect(realStart).toMatch(/^\d+$/);
      // The start time the caller recorded belongs to the process that HELD
      // this pid before it was recycled. `0` is unreachable for a real process
      // (pid 1 starts after boot), so it names a start time no live process
      // can have — the exact mismatch a recycled pid presents.
      const staleRoot = `${replacement.leaderPid}:0`;

      const result = tearDownWithRoot(replacement, staleRoot);

      // Nothing in the slot tree, so the sweep is a clean no-op...
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('stage tree fully terminated');
      // ...and it says why it declined the root, rather than silently skipping.
      expect(result.stderr).toContain('was recycled onto an unrelated process');
      expect(result.stderr).toContain(replacement.leaderPid);

      // The unrelated replacement AND its whole session survive: the session
      // axis is seeded from members, so refusing the root refuses the session.
      expect(isAlive(replacement.leaderPid), 'the recycled root was signalled').toBe(true);
      expect(isAlive(replacement.childPid), "the recycled root's child was signalled").toBe(true);
    } finally {
      spawnSync('bash', [
        '-c',
        `kill -9 ${replacement.leaderPid} ${replacement.childPid} 2>/dev/null || true`,
      ]);
    }
  }, 120_000);

  it('positive control: the same tree IS torn down when the start time matches', () => {
    const replacement = spawnUnrelatedReplacement();
    try {
      const realStart = startTimeOf(replacement.leaderPid);
      expect(realStart).toMatch(/^\d+$/);

      const result = tearDownWithRoot(replacement, `${replacement.leaderPid}:${realStart}`);

      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('stage tree fully terminated');
      expect(result.stderr).not.toContain('was recycled onto an unrelated process');
      // Same processes, same script, only the expected start time changed —
      // which is what makes the negative case above a real guard.
      expect(isAlive(replacement.leaderPid), 'the matching root survived').toBe(false);
      expect(isAlive(replacement.childPid), "the matching root's child survived").toBe(false);
    } finally {
      spawnSync('bash', [
        '-c',
        `kill -9 ${replacement.leaderPid} ${replacement.childPid} 2>/dev/null || true`,
      ]);
    }
  }, 120_000);
});

describe.skipIf(!hasProc)('goobers-run.yml slot deadline teardown', () => {
  it('kills the whole stage tree, including session-detached descendants, before cleanup', () => {
    const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-deadline-'));
    const binDir = path.join(workdir, 'bin');
    mkdirSync(binDir, { recursive: true });

    const heartbeat = path.join(workdir, 'heartbeat.log');
    writeFileSync(heartbeat, '', 'utf8');
    const descendantPidFile = path.join(workdir, 'descendant.pid');
    writeFileSync(descendantPidFile, '', 'utf8');
    const bystanderPidFile = path.join(workdir, 'bystander.pid');
    writeFileSync(bystanderPidFile, '', 'utf8');

    const stubPath = path.join(binDir, 'goobers');
    writeFileSync(stubPath, DEADLINE_STUB, 'utf8');
    chmodSync(stubPath, 0o755);

    // A process this job did NOT start, in the test's own session. The sweep
    // selects by parenthood, stage session and GOOBERS_INSTANCE identity, never
    // by process name, so this must survive untouched.
    const bystanderScript = path.join(workdir, 'bystander.sh');
    writeFileSync(
      bystanderScript,
      `printf '%s\\n' "$$" > "${toBashScriptPath(bystanderPidFile)}"\nexec sleep 30\n`,
      'utf8',
    );
    const bystander = spawnSync(
      'bash',
      ['-c', `bash "${toBashScriptPath(bystanderScript)}" >/dev/null 2>&1 & disown; sleep 1`],
      { encoding: 'utf8' },
    );
    expect(bystander.status, `stderr:\n${bystander.stderr}`).toBe(0);
    const bystanderPid = readFileSync(bystanderPidFile, 'utf8').trim();
    expect(bystanderPid).toMatch(/^\d+$/);

    const scriptPath = path.join(workdir, 'run-step.sh');
    writeFileSync(
      scriptPath,
      `export PATH="$(cd "${toBashScriptPath(binDir)}" && pwd):$PATH"\n${stepScript(
        'Run the workflow',
      )}\n`,
      'utf8',
    );

    const result = spawnSync('bash', [toBashScriptPath(scriptPath)], {
      encoding: 'utf8',
      env: bashEnv({
        HEARTBEAT_FILE: toBashScriptPath(heartbeat),
        DESCENDANT_PID_FILE: toBashScriptPath(descendantPidFile),
        GOOBERS_LANE: '1',
        GOOBERS_SLOTS: '1',
        GOOBERS_LANE_ROOT: toBashScriptPath(path.join(workdir, 'lane-1')),
        GOOBERS_RECOVERY_LANE: '1',
        GOOBERS_RECOVERY_SLOT: '1',
        GOOBERS_RECOVERY_ISSUE: '',
        GOOBERS_RESUME_PR: '',
        GOOBERS_RESUME_BRANCH: '',
        // Short enough to keep the test fast; the teardown logic is identical
        // at 4200s.
        GOOBERS_SLOT_DEADLINE_SECONDS: '3',
        GOOBERS_WORKFLOW: 'crawler-feature-pr',
        GITHUB_RUN_ID: '999',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_WORKSPACE: toBashScriptPath(REPO_ROOT),
        RUNNER_TEMP: toBashScriptPath(workdir),
        ...jobBudgetEnv(),
      }),
    });

    // Hitting the deadline is a genuine failure, so the step must report it.
    expect(result.status, `stdout:\n${result.stdout}`).not.toBe(0);
    expect(result.stderr).toContain('slot deadline');
    // The teardown refuses to report success while anything survives, so this
    // line IS the proof that nothing was alive when the step returned — i.e.
    // before "Handle no-work disposition" releases claims and labels.
    expect(result.stdout).toContain('stage tree fully terminated');

    const descendantPid = readFileSync(descendantPidFile, 'utf8').trim();
    expect(descendantPid, 'the stub never recorded a detached descendant').toMatch(/^\d+$/);

    const stillAlive = spawnSync('bash', ['-c', `kill -0 ${descendantPid} 2>/dev/null`]);
    expect(stillAlive.status, `descendant ${descendantPid} survived the teardown`).not.toBe(0);

    // And it really has stopped working, not merely become unsignalable.
    const beatsAtTeardown = readFileSync(heartbeat, 'utf8').split('\n').length;
    spawnSync('bash', ['-c', 'sleep 1.5']);
    const beatsAfter = readFileSync(heartbeat, 'utf8').split('\n').length;
    expect(beatsAfter).toBe(beatsAtTeardown);

    // The unrelated process is untouched: no broad process-name kill happened.
    const bystanderAlive = spawnSync('bash', ['-c', `kill -0 ${bystanderPid} 2>/dev/null`]);
    expect(bystanderAlive.status, 'the sweep killed a process outside the slot tree').toBe(0);
    spawnSync('bash', ['-c', `kill -9 ${bystanderPid} 2>/dev/null || true`]);
  }, 120_000);

  it('fails promptly instead of waiting on a root the teardown could not kill', () => {
    // The failure mode: the deadline fires, `terminate_slots` cannot prove the
    // tree is gone, and the step then blocks in `wait "$pid"` on a process that
    // will never exit. That burns the entire cleanup reserve and lets the
    // 90-minute job timeout kill the job mid-flight — the one path that skips
    // the reap, both journal uploads, and every claim/label mutation, leaving a
    // provider claim stranded on a live issue.
    //
    // Signal delivery is neutered for TERM/KILL only, so the real teardown
    // library runs unchanged, finds the slot's root, "signals" it, and
    // correctly refuses to report success. `kill -0` is passed through so
    // `slots_alive` still observes truth, and `sleep` is collapsed only to keep
    // the 120s grace and 15s verification windows from making this slow.
    const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-hangroot-'));
    const binDir = path.join(workdir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const pidFile = path.join(workdir, 'slot.pid');
    writeFileSync(pidFile, '', 'utf8');

    // Slot 1 never returns; slot 2 exits cleanly. The refusal has to be per
    // slot, or the healthy sibling is reported as unreaped too and its real
    // exit status is thrown away.
    const stubPath = path.join(binDir, 'goobers');
    writeFileSync(
      stubPath,
      [
        '#!/usr/bin/env bash',
        'case "${GOOBERS_INSTANCE}" in',
        '  */slot-1)',
        '    printf \'%s\\n\' "$$" > "${SLOT_PID_FILE}"',
        '    sleep 600',
        '    ;;',
        '  *) exit 0 ;;',
        'esac',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(stubPath, 0o755);

    const prelude = [
      'kill() {',
      '  case "${1:-}" in',
      '    -0) command kill "$@" ;;',
      '    *) return 0 ;;',
      '  esac',
      '}',
      'sleep() { command sleep 0.02; }',
      '',
    ].join('\n');

    const scriptPath = path.join(workdir, 'run-step.sh');
    writeFileSync(
      scriptPath,
      `${prelude}export PATH="$(cd "${toBashScriptPath(binDir)}" && pwd):$PATH"\n${stepScript(
        'Run the workflow',
      )}\n`,
      'utf8',
    );

    const started = Date.now();
    const result = spawnSync('bash', [toBashScriptPath(scriptPath)], {
      encoding: 'utf8',
      env: bashEnv({
        SLOT_PID_FILE: toBashScriptPath(pidFile),
        GOOBERS_LANE: '1',
        GOOBERS_SLOTS: '1 2',
        GOOBERS_LANE_ROOT: toBashScriptPath(path.join(workdir, 'lane-1')),
        GOOBERS_RECOVERY_LANE: '1',
        GOOBERS_RECOVERY_SLOT: '1',
        GOOBERS_RECOVERY_ISSUE: '',
        GOOBERS_RESUME_PR: '',
        GOOBERS_RESUME_BRANCH: '',
        GOOBERS_SLOT_DEADLINE_SECONDS: '2',
        GOOBERS_WORKFLOW: 'crawler-feature-pr',
        GITHUB_RUN_ID: '999',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_WORKSPACE: toBashScriptPath(REPO_ROOT),
        RUNNER_TEMP: toBashScriptPath(workdir),
        ...jobBudgetEnv(),
      }),
    });
    const elapsedMs = Date.now() - started;
    const slotPid = readFileSync(pidFile, 'utf8').trim();

    try {
      expect(slotPid, 'the stub never recorded its pid').toMatch(/^\d+$/);
      // The teardown really did fail...
      expect(result.stderr).toContain('live process(es) after SIGKILL');
      // ...and the step reported it rather than blocking on the survivor.
      expect(result.status, `stdout:\n${result.stdout}`).not.toBe(0);
      expect(result.stderr).toContain("could not prove slot 1's stage tree was terminated");
      expect(result.stderr).toContain('is NOT blocking on its root pid');
      expect(result.stderr).toContain(slotPid);
      // The healthy sibling is neither blamed nor stripped of its exit status.
      expect(result.stderr).not.toContain("could not prove slot 2's stage tree was terminated");
      expect(result.stdout).toContain('slot 2 (recovery=0) exited 0');
      // The surviving root is still running, which is the whole point: the step
      // returned WITHOUT it exiting. A blocking `wait` could only have returned
      // after the stub's 600s sleep.
      expect(
        spawnSync('bash', ['-c', `kill -0 ${slotPid} 2>/dev/null`]).status,
        'the survivor died on its own, so this test proved nothing',
      ).toBe(0);
      expect(
        elapsedMs,
        `the step took ${elapsedMs}ms, which means it waited on the surviving root`,
      ).toBeLessThan(120_000);
    } finally {
      spawnSync('bash', ['-c', `kill -9 ${slotPid} 2>/dev/null || true`]);
    }
  }, 180_000);
});

/**
 * Executable regression for the slot deadline's cleanup reserve.
 *
 * `timeout-minutes` is measured from JOB start, but the deadline used to be
 * measured from the start of "Run the workflow" — so a slow setup silently ate
 * the window the teardown, the two journal uploads and every claim/label
 * mutation need at the far end, and the runner could kill the job while a
 * provider claim was still held. These tests pin the relationship: the run
 * window is (job budget - elapsed setup - cleanup reserve), capped by the
 * declared slot deadline.
 */
function runDeadlineDerivation(
  budgetEnv: Record<string, string>,
  slotStub: string,
  fakeNowEpoch?: number,
): { status: number | null; stdout: string; stderr: string; log: string } {
  const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-budget-'));
  const binDir = path.join(workdir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = path.join(workdir, 'stub.log');
  writeFileSync(logPath, '', 'utf8');
  const stubPath = path.join(binDir, 'goobers');
  writeFileSync(stubPath, slotStub, 'utf8');
  chmodSync(stubPath, 0o755);

  // Deterministic clock injection. The step derives `job_elapsed` from
  // `$(date +%s) - GOOBERS_JOB_START_EPOCH`; computing the anchor in the test
  // process and reading the clock again in the step straddles a wall-clock
  // second boundary, so "60s already spent" was intermittently "61s". Shadowing
  // `date +%s` with a shell function — the same stubbing mechanism this harness
  // already uses for `gh`, `goobers` and `sleep` — pins BOTH reads to one
  // instant without changing a line of production behaviour. Everything else
  // (`date` with other arguments, and the deadline loop's `SECONDS`) is
  // untouched, so the teardown still runs against real elapsed time.
  const clockStub =
    fakeNowEpoch === undefined
      ? ''
      : [
          'date() {',
          '  if [ "${1:-}" = "+%s" ]; then',
          `    printf '%s\\n' '${fakeNowEpoch}'`,
          '    return 0',
          '  fi',
          '  command date "$@"',
          '}',
          '',
        ].join('\n');

  const scriptPath = path.join(workdir, 'run-step.sh');
  writeFileSync(
    scriptPath,
    `${clockStub}export PATH="$(cd "${toBashScriptPath(binDir)}" && pwd):$PATH"\n${stepScript(
      'Run the workflow',
    )}\n`,
    'utf8',
  );

  const result = spawnSync('bash', [toBashScriptPath(scriptPath)], {
    encoding: 'utf8',
    env: bashEnv({
      STUB_LOG: toBashScriptPath(logPath),
      HEARTBEAT_FILE: toBashScriptPath(path.join(workdir, 'heartbeat.log')),
      DESCENDANT_PID_FILE: toBashScriptPath(path.join(workdir, 'descendant.pid')),
      GOOBERS_LANE: '1',
      GOOBERS_SLOTS: '1',
      GOOBERS_LANE_ROOT: toBashScriptPath(path.join(workdir, 'lane-1')),
      GOOBERS_RECOVERY_LANE: '1',
      GOOBERS_RECOVERY_SLOT: '1',
      GOOBERS_RECOVERY_ISSUE: '',
      GOOBERS_RESUME_PR: '',
      GOOBERS_RESUME_BRANCH: '',
      // Deliberately far larger than any derived budget below: if the step
      // still used this value directly, neither test could pass.
      GOOBERS_SLOT_DEADLINE_SECONDS: '3300',
      GOOBERS_JOB_START_SLACK_SECONDS: '0',
      GOOBERS_SLOT_POLL_SECONDS: '10',
      GOOBERS_WORKFLOW: 'crawler-feature-pr',
      GITHUB_RUN_ID: '999',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_WORKSPACE: toBashScriptPath(REPO_ROOT),
      RUNNER_TEMP: toBashScriptPath(workdir),
      ...budgetEnv,
    }),
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    log: readFileSync(logPath, 'utf8'),
  };
}

const NEVER_RETURNS_STUB = `#!/usr/bin/env bash
printf 'started %s\\n' "\${GOOBERS_INSTANCE:-unset}" >> "\${STUB_LOG}"
sleep 600
`;

describe.skipIf(!hasProc)('goobers-run.yml slot deadline cleanup reserve', () => {
  it('derives the run window from the absolute job budget minus the cleanup reserve', () => {
    // A FIXED instant, injected into the step's own `date +%s`, so nothing in
    // these assertions can straddle a wall-clock second.
    const FAKE_NOW = 1_800_000_000;
    const result = runDeadlineDerivation(
      {
        // 120s of job budget; 40s of it observed as spent, plus a 20s
        // runner-startup allowance = 60s gone; 55s reserved for cleanup ->
        // a 5s run window, nothing like the declared 3300s.
        GOOBERS_JOB_START_EPOCH: String(FAKE_NOW - 40),
        GOOBERS_JOB_TIMEOUT_MINUTES: '2',
        GOOBERS_JOB_START_SLACK_SECONDS: '20',
        GOOBERS_CLEANUP_RESERVE_SECONDS: '55',
      },
      NEVER_RETURNS_STUB,
      FAKE_NOW,
    );

    expect(result.stdout).toContain('slot deadline: 5s');
    // The startup allowance is INSIDE the elapsed figure, not bolted on after:
    // "Record job start" is the first step, but the runner began counting
    // `timeout-minutes` before any step existed.
    expect(result.stdout).toContain('60s already spent');
    expect(result.stdout).toContain('40s observed + 20s runner-startup allowance');
    expect(result.stdout).toContain('55s cleanup reserve');
    // The slot really was started and then stopped by the derived deadline,
    // not by the declared 3300s one.
    expect(result.log).toContain('started ');
    expect(result.status, `stdout:\n${result.stdout}`).not.toBe(0);
    expect(result.stderr).toContain('hit its 5s slot deadline');
    expect(result.stdout).toContain('stage tree fully terminated');
  }, 120_000);

  it('never sleeps past the deadline it is waiting for', () => {
    // A fixed interval overshoots by up to a full interval, and every second
    // of overshoot is stolen from the cleanup reserve. The loop must sleep
    // min(remaining, interval) instead.
    const script = stepScript('Run the workflow');
    expect(script).toContain('remaining=$(( deadline - SECONDS ))');
    expect(script).toContain('if [ "$remaining" -lt "$GOOBERS_SLOT_POLL_SECONDS" ]; then');
    expect(script).toContain('sleep "$remaining"');
    expect(script).not.toMatch(/^\s*sleep 10$/m);

    // Executable proof: a 3s window with a 30s poll interval must still tear
    // down at ~3s, which a fixed `sleep 30` could not do.
    const FAKE_NOW = 1_800_000_100;
    const started = Date.now();
    const result = runDeadlineDerivation(
      {
        GOOBERS_JOB_START_EPOCH: String(FAKE_NOW - 60),
        GOOBERS_JOB_TIMEOUT_MINUTES: '2',
        GOOBERS_JOB_START_SLACK_SECONDS: '0',
        GOOBERS_CLEANUP_RESERVE_SECONDS: '57',
        GOOBERS_SLOT_POLL_SECONDS: '30',
      },
      NEVER_RETURNS_STUB,
      FAKE_NOW,
    );
    const elapsedMs = Date.now() - started;

    expect(result.stdout).toContain('slot deadline: 3s');
    expect(result.stderr).toContain('hit its 3s slot deadline');
    expect(result.stdout).toContain('stage tree fully terminated');
    // Generous, but far below the 30s a fixed-interval sleep would have cost.
    expect(elapsedMs, `the deadline loop overshot its 3s window by ${elapsedMs}ms`).toBeLessThan(
      25_000,
    );
  }, 120_000);

  it('refuses to start a slot it could not clean up after', () => {
    const FAKE_NOW = 1_800_000_200;
    const result = runDeadlineDerivation(
      {
        // Setup alone outlived the whole budget.
        GOOBERS_JOB_START_EPOCH: String(FAKE_NOW - 3600),
        GOOBERS_JOB_TIMEOUT_MINUTES: '2',
        GOOBERS_CLEANUP_RESERVE_SECONDS: '55',
      },
      NEVER_RETURNS_STUB,
      FAKE_NOW,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing to start a slot that could not be cleaned up');
    // Nothing was launched, so nothing needs tearing down.
    expect(result.log).toBe('');
  }, 60_000);
});

/**
 * Executable overlap regression for the cross-dispatch recovery single-flight.
 *
 * `concurrency: goobers-run-reserve` only holds for the length of the reserve
 * job, while its lanes run for up to 90 more minutes. Without this check, a
 * second dispatch's reserve job could designate the very issue this dispatch's
 * recovery slot is still resuming — and the recovery path bypasses Goobers'
 * provider claim protocol, so nothing else settles that collision.
 *
 * The `gh` stub applies the workflow's OWN `--jq` filter to a realistic
 * `/actions/runs` payload, so the self-exclusion and the status filter are
 * exercised rather than assumed.
 */
const SIBLING_DISPATCH_GH_STUB = `
gh() {
  printf 'gh %s\\n' "$*" >> "$STUB_LOG"
  local previous="" argument="" jq_filter="" fixture_user=""
  for argument in "$@"; do
    if [ "$previous" = "--jq" ]; then
      jq_filter="$argument"
    fi
    previous="$argument"
  done
  case "$*" in
    *actions/workflows/goobers-run.yml/runs*)
      if [ "\${RUNS_FIXTURE_FAILS:-}" = "1" ]; then
        return 1
      fi
      jq -r "$jq_filter" < "$RUNS_FIXTURE"
      return 0
      ;;
    *"issue list"*|*"--label goobers/status:in-review"*)
      # The scheduled recovery scan. A failed read must NOT look like an empty
      # backlog, which is the whole point of RECOVERY_SCAN_FAILS.
      if [ "\${RECOVERY_SCAN_FAILS:-}" = "1" ]; then
        printf 'HTTP 401: Bad credentials\\n' >&2
        return 1
      fi
      # gh writes advisory notices to stderr on a SUCCESSFUL call; they must
      # never reach the candidate list.
      if [ -n "\${RECOVERY_SCAN_NOISE:-}" ]; then
        printf '%s\\n' "\${RECOVERY_SCAN_NOISE}" >&2
      fi
      if [ -n "\${RECOVERY_SCAN_FIXTURE_ISSUES:-}" ]; then
        printf '%s\\n' "\${RECOVERY_SCAN_FIXTURE_ISSUES}"
      fi
      return 0
      ;;
    *comments*)
      # The reservation-lease receipts. Built with jq so an embedded newline in
      # the body stays valid JSON.
      if [ "\${COMMENTS_FIXTURE_FAILS:-}" = "1" ]; then
        printf 'HTTP 403: rate limit exceeded\\n' >&2
        return 1
      fi
      if [ -n "\${COMMENTS_FIXTURE_BODY:-}" ]; then
        if [ "\${COMMENTS_FIXTURE_TRUSTED:-1}" = "1" ]; then
          fixture_user='{"type":"Bot","login":"github-actions[bot]"}'
        else
          fixture_user='{"type":"User","login":"mallory"}'
        fi
        jq -n --arg body "\${COMMENTS_FIXTURE_BODY}" --argjson user "$fixture_user" \\
          '[[{id: 1, user: $user, body: $body}]]'
      else
        printf '[[]]\\n'
      fi
      return 0
      ;;
    *blocked_by*)
      # gh api --jq emits one line per OPEN blocker; no blockers means no
      # output at all, not a literal empty JSON array.
      ;;
    *timeline*)
      # Raw timeline JSON: find_open_goobers_pr pipes this into its own jq.
      if [ -n "\${RECOVERY_SCAN_FIXTURE_ISSUES:-}" ]; then
        printf '[{"event":"cross-referenced","source":{"issue":{"number":8001,"pull_request":{},"repository_url":"https://api.github.com/repos/nalfeo/Crawler"}}}]\\n'
      else
        printf '[]\\n'
      fi
      ;;
    "pr view"*)
      printf '{"state":"OPEN","headRefName":"goobers/crawler/resume","headRepository":{"nameWithOwner":"nalfeo/Crawler"}}\\n'
      ;;
    "search issues"*)
      # MUST precede the issue-view case below: the search now requests
      # --json number,state,labels,assignees,author,isPullRequest, so its
      # argument string contains "state,labels,assignees" and would otherwise
      # match that pattern and return a single object instead of an array.
      if [ "\${FRESH_SCAN_FAILS:-}" = "1" ]; then
        printf 'HTTP 403: secondary rate limit\\n' >&2
        return 1
      fi
      # The fresh scan now hands raw issue payloads to the canonical selector
      # rather than a bare number list.
      printf '[{"number":55,"state":"OPEN","labels":[{"name":"goobers:approved"}],"assignees":[],"author":{"login":"nalfeo"},"isPullRequest":false}]\\n'
      ;;
    *state,labels,assignees*)
      # gh issue view for the canonical selector. It reads number/author too,
      # so the payload must carry them or every issue reads as ineligible.
      if [ "\${ISSUE_FIXTURE_ELIGIBLE:-1}" = "1" ]; then
        printf '{"number":42,"state":"OPEN","labels":[{"name":"goobers:approved"}],"assignees":[],"author":{"login":"nalfeo"}}\\n'
      else
        printf '{"number":42,"state":"CLOSED","labels":[],"assignees":[],"author":{"login":"nalfeo"}}\\n'
      fi
      ;;
  esac
  return 0
}
`;

interface SingleFlightResult {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
  log: string;
}

function runReserveStep(
  stepName: string,
  runsFixture: unknown,
  env: Record<string, string>,
): SingleFlightResult {
  const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-singleflight-'));
  const fixturePath = path.join(workdir, 'runs.json');
  writeFileSync(fixturePath, JSON.stringify(runsFixture), 'utf8');
  const outputPath = path.join(workdir, 'github-output.txt');
  writeFileSync(outputPath, '', 'utf8');
  const logPath = path.join(workdir, 'stub.log');
  writeFileSync(logPath, '', 'utf8');
  const scriptPath = path.join(workdir, 'step.sh');
  writeFileSync(
    scriptPath,
    `${SIBLING_DISPATCH_GH_STUB}\n${stepScript(stepName, 'reserve')}\n`,
    'utf8',
  );

  const result = spawnSync('bash', [toBashScriptPath(scriptPath)], {
    encoding: 'utf8',
    env: bashEnv({
      STUB_LOG: toBashScriptPath(logPath),
      RUNS_FIXTURE: toBashScriptPath(fixturePath),
      GITHUB_OUTPUT: toBashScriptPath(outputPath),
      // Actions always provides RUNNER_TEMP; the fresh-intake scan stages its
      // candidate and selection files there.
      RUNNER_TEMP: toBashScriptPath(workdir),
      // The resolve step sources the real reservation-lease library.
      GITHUB_WORKSPACE: toBashScriptPath(REPO_ROOT),
      GITHUB_REPOSITORY: 'nalfeo/Crawler',
      GITHUB_RUN_ID: '999',
      GITHUB_RUN_ATTEMPT: '1',
      GOOBERS_WORKFLOW: 'crawler-feature-pr',
      // Actions always sets these; the canonical eligibility selector reads
      // LIFECYCLE_MUTATION_OWNER/ISSUE_OWNER and fails closed without them.
      GITHUB_EVENT_NAME: 'schedule',
      LIFECYCLE_MUTATION_OWNER: 'goobers',
      ISSUE_OWNER: 'nalfeo',
      GOOBERS_RECOVERY_LANE: '1',
      GOOBERS_RECOVERY_SLOT: '1',
      GOOBERS_AUTH_TOKEN_SET: 'stub-pat',
      GH_TOKEN: 'stub-pat',
      ABANDON_EXISTING: 'false',
      ISSUE_NUMBER: '',
      EXPLICIT_ISSUE_NUMBER: '',
      RECOVERY_ALLOWED: 'true',
      ...env,
    }),
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: readFileSync(outputPath, 'utf8'),
    log: readFileSync(logPath, 'utf8'),
  };
}

const SELF_RUN_ONLY = {
  workflow_runs: [
    { id: 999, status: 'in_progress' },
    { id: 222, status: 'completed' },
  ],
};
const LIVE_SIBLING_RUN = {
  workflow_runs: [
    { id: 111, status: 'in_progress' },
    { id: 999, status: 'in_progress' },
    { id: 222, status: 'completed' },
  ],
};

describe.skipIf(!hasJq)('goobers-run.yml cross-dispatch recovery single-flight', () => {
  it('allows recovery when this dispatch is the only live one', () => {
    const result = runReserveStep('Detect a live sibling dispatch', SELF_RUN_ONLY, {});

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.output).toContain('recovery_allowed=true');
    expect(result.output).not.toContain('recovery_allowed=false');
  });

  it('refuses recovery designation while a sibling dispatch is live', () => {
    const result = runReserveStep('Detect a live sibling dispatch', LIVE_SIBLING_RUN, {});

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.output).toContain('recovery_allowed=false');
    expect(result.stdout).toContain('Another Goobers Run dispatch is still live');
    // The workflow's own jq filter did the selecting: the sibling is named and
    // this dispatch's own run id is excluded.
    expect(result.stdout).toContain('111');
  });

  it('fails closed on an unreadable run list', () => {
    const result = runReserveStep('Detect a live sibling dispatch', SELF_RUN_ONLY, {
      RUNS_FIXTURE_FAILS: '1',
    });

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.output).toContain('recovery_allowed=false');
    expect(result.stderr).toContain('cannot prove it is the only one');
  });

  it('designates no recovery target for a label event while a sibling is live', () => {
    const deferred = runReserveStep('Resolve Goobers recovery target', SELF_RUN_ONLY, {
      ISSUE_NUMBER: '42',
      RECOVERY_ALLOWED: 'false',
    });

    expect(deferred.status, `stderr:\n${deferred.stderr}`).toBe(0);
    // No target designated, so the reserve step never labels anything and the
    // four slots claim atomically instead.
    expect(deferred.output).not.toContain('recovery_issue=');
    expect(deferred.log).not.toContain('gh issue edit');
    expect(deferred.stdout).toContain('Not designating issue #42');

    // Negative control: the same script with the guard satisfied DOES
    // designate it, so the guard is load-bearing rather than the stub being
    // incapable of designating a target.
    const allowed = runReserveStep('Resolve Goobers recovery target', SELF_RUN_ONLY, {
      ISSUE_NUMBER: '42',
      RECOVERY_ALLOWED: 'true',
    });
    expect(allowed.status, `stderr:\n${allowed.stderr}`).toBe(0);
    expect(allowed.output).toContain('recovery_issue=42');
  });

  it('falls through safely when an issue event is outside the intake cohort', () => {
    const result = runReserveStep('Resolve Goobers recovery target', SELF_RUN_ONLY, {
      GITHUB_EVENT_NAME: 'issues',
      ISSUE_NUMBER: '42',
      ISSUE_FIXTURE_ELIGIBLE: '0',
    });

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('is not in the Goobers intake cohort');
    expect(result.stderr).not.toContain('command not found');
    expect(result.output).not.toContain('recovery_issue=42');
    expect(result.log).not.toContain('gh issue edit');
  });

  it('fails an explicit resume request instead of silently downgrading it', () => {
    const result = runReserveStep('Resolve Goobers recovery target', SELF_RUN_ONLY, {
      ISSUE_NUMBER: '42',
      EXPLICIT_ISSUE_NUMBER: '42',
      RECOVERY_ALLOWED: 'false',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing to resume issue #42');
    expect(result.output).not.toContain('recovery_issue=');
  });
});

/**
 * Executable regression for the durable, trusted, run+attempt-scoped
 * reservation lease.
 *
 * Three separate hazards live here.
 *
 * 1. `needs.run.result` is the AGGREGATE of two matrix legs. It reads `failure`
 *    when the recovery lane never adopted the reservation, when the recovery
 *    lane adopted it and its reap failed (so a descendant may still be
 *    pushing), AND when a healthy recovery lane's SIBLING lane failed.
 *    Releasing on that result alone removes `goobers/status:in-review` out from
 *    under a live owner, so the guard reads the receipt instead.
 * 2. The receipt has to OUTLIVE its Actions run. A run reports `completed`
 *    while a Setsid-detached stage keeps pushing, so a later dispatch that
 *    re-adopts an issue on the strength of its label alone puts two agents on
 *    one issue. A prior adopted-but-undisposed lease must block selection.
 * 3. Issue comments are PUBLIC and the marker text is predictable, so matching
 *    `contains(<marker>)` over every comment lets anyone who can comment forge
 *    the lease state. Only whole-line matches on comments authored by the
 *    GitHub Actions identity count.
 */
const RECEIPT_GH_STUB = `
gh() {
  printf 'gh %s\\n' "$*" >> "$STUB_LOG"
  local previous="" argument=""
  for argument in "$@"; do
    if [ "$previous" = "--body-file" ]; then
      cat "$argument" >> "$STUB_LOG"
    fi
    previous="$argument"
  done
  case "$*" in
    *comments?per_page*|*comments*)
      if [ "\${COMMENTS_FIXTURE_FAILS:-}" = "1" ]; then
        printf 'HTTP 403: rate limit exceeded\\n' >&2
        return 1
      fi
      cat "$COMMENTS_FIXTURE"
      ;;
    *timeline*) printf '[]\\n' ;;
  esac
  if [[ "$*" == *" --input -"* ]]; then
    cat > /dev/null
  fi
  return 0
}
`;

/** The GitHub Actions identity that writes every real receipt. */
const ACTIONS_BOT = { type: 'Bot', login: 'github-actions[bot]' };
/** Anyone who can comment on the issue. Must never be able to move the lease. */
const UNTRUSTED_USER = { type: 'User', login: 'mallory' };

function adoptedMarker(runId = '999', attempt = '1', issue = '42'): string {
  return `<!-- crawler-goobers-reservation-adopted:v1 run-id=${runId} attempt=${attempt} issue=${issue} -->`;
}
function disposedMarker(runId = '999', attempt = '1', issue = '42'): string {
  return `<!-- crawler-goobers-reservation-disposed:v1 run-id=${runId} attempt=${attempt} issue=${issue} -->`;
}

interface CommentFixture {
  id: number;
  user: { type: string; login: string };
  body: string;
  performed_via_github_app?: { slug: string } | null;
}

function comment(
  id: number,
  body: string,
  user = ACTIONS_BOT,
  app?: { slug: string },
): CommentFixture {
  return app ? { id, user, body, performed_via_github_app: app } : { id, user, body };
}

function runReceiptStep(
  stepName: string,
  jobId: string,
  comments: unknown,
  env: Record<string, string>,
): SingleFlightResult {
  const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-receipt-'));
  const commentsPath = path.join(workdir, 'comments.json');
  writeFileSync(commentsPath, JSON.stringify(comments), 'utf8');
  const outputPath = path.join(workdir, 'github-output.txt');
  writeFileSync(outputPath, '', 'utf8');
  const logPath = path.join(workdir, 'stub.log');
  writeFileSync(logPath, '', 'utf8');
  const envPath = path.join(workdir, 'github-env.txt');
  writeFileSync(envPath, '', 'utf8');
  const scriptPath = path.join(workdir, 'step.sh');
  writeFileSync(scriptPath, `${RECEIPT_GH_STUB}\n${stepScript(stepName, jobId)}\n`, 'utf8');

  const result = spawnSync('bash', [toBashScriptPath(scriptPath)], {
    encoding: 'utf8',
    env: bashEnv({
      STUB_LOG: toBashScriptPath(logPath),
      COMMENTS_FIXTURE: toBashScriptPath(commentsPath),
      GITHUB_OUTPUT: toBashScriptPath(outputPath),
      GITHUB_ENV: toBashScriptPath(envPath),
      // The steps source the real lease library from the checkout.
      GITHUB_WORKSPACE: toBashScriptPath(REPO_ROOT),
      GITHUB_REPOSITORY: 'nalfeo/Crawler',
      GITHUB_RUN_ID: '999',
      GITHUB_RUN_ATTEMPT: '1',
      GH_TOKEN: 'stub-token',
      GOOBERS_LANE: '1',
      GOOBERS_RECOVERY_LANE: '1',
      GOOBERS_RECOVERY_SLOT: '1',
      // Declared as a step env in the workflow, so it is always defined under
      // `set -u` even when the reserve job resolved no cohort.
      RESERVED_INTAKE_COHORT: '',
      ...env,
    }),
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: readFileSync(outputPath, 'utf8'),
    log: readFileSync(logPath, 'utf8'),
  };
}

describe.skipIf(!hasJq)('goobers-run.yml reservation ownership evidence', () => {
  it('releases only when no lane ever adopted the reservation', () => {
    const result = runReceiptStep(
      'Release the reservation when no lane ever owned it',
      'release-unstarted-reservation',
      [[]],
      { RESERVED_ISSUE: '42', RUN_RESULT: 'failure' },
    );

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('never took ownership of the reservation');
    expect(result.log).toContain(
      'gh issue edit 42 --repo nalfeo/Crawler --remove-label goobers/status:in-review',
    );
  });

  it('refuses to release a reservation that was adopted but never disposed', () => {
    // The failed-reap shape: the recovery lane took ownership and could not
    // prove its stage tree was gone, so a descendant may still be pushing to
    // this very issue.
    const result = runReceiptStep(
      'Release the reservation when no lane ever owned it',
      'release-unstarted-reservation',
      [[comment(1, `${adoptedMarker()}\n\nadopted`)]],
      { RESERVED_ISSUE: '42', RUN_RESULT: 'failure' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('WAS adopted by lane');
    expect(result.stderr).toContain('Refusing to remove goobers/status:in-review');
    expect(result.log).not.toContain('--remove-label');
  });

  it('leaves a cleanly disposed reservation to the lane that owned it', () => {
    // The aggregate-failure shape: this lane finished its own disposition, and
    // the `failure` result belongs to its sibling lane.
    const result = runReceiptStep(
      'Release the reservation when no lane ever owned it',
      'release-unstarted-reservation',
      [[comment(1, `${adoptedMarker()}\n\n${disposedMarker()}\n`)]],
      { RESERVED_ISSUE: '42', RUN_RESULT: 'failure' },
    );

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('recorded a clean disposal');
    expect(result.log).not.toContain('--remove-label');
  });

  it('ignores an UNTRUSTED comment that carries a perfectly formed receipt', () => {
    // Issue comments are public and the marker text is predictable. A forged
    // adoption would wedge recovery for good; this asserts the guard reads
    // right past it and releases exactly as it would with no receipt at all.
    const forgedAdoption = runReceiptStep(
      'Release the reservation when no lane ever owned it',
      'release-unstarted-reservation',
      [[comment(1, `${adoptedMarker()}\n\nnot really`, UNTRUSTED_USER)]],
      { RESERVED_ISSUE: '42', RUN_RESULT: 'failure' },
    );

    expect(forgedAdoption.status, `stderr:\n${forgedAdoption.stderr}`).toBe(0);
    expect(forgedAdoption.log).toContain('--remove-label');

    // ...and the far more dangerous direction: a forged DISPOSAL must not
    // close a genuine, trusted adoption. If it did, the guard would report
    // "cleanly disposed" and a later dispatch would re-adopt a live issue.
    const forgedDisposal = runReceiptStep(
      'Release the reservation when no lane ever owned it',
      'release-unstarted-reservation',
      [[comment(1, `${adoptedMarker()}\n\nadopted`), comment(2, disposedMarker(), UNTRUSTED_USER)]],
      { RESERVED_ISSUE: '42', RUN_RESULT: 'failure' },
    );

    expect(forgedDisposal.status).not.toBe(0);
    expect(forgedDisposal.stderr).toContain('Refusing to remove goobers/status:in-review');
    expect(forgedDisposal.log).not.toContain('--remove-label');
  });

  it('ignores a marker embedded in a longer line rather than owning the line', () => {
    const result = runReceiptStep(
      'Release the reservation when no lane ever owned it',
      'release-unstarted-reservation',
      [[comment(1, `see also ${adoptedMarker()} which I am quoting`)]],
      { RESERVED_ISSUE: '42', RUN_RESULT: 'failure' },
    );

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.log).toContain('--remove-label');
  });

  it('ignores a disposal in a TRUSTED comment that is not the adoption receipt', () => {
    // Trusted authorship alone is not enough. This workflow posts several
    // Actions-authored comments on the same issue, and one of them renders
    // free-form Goobers journal text written by the agent under test. A
    // perfectly formed disposal, correct run/attempt/issue, in ANY other
    // Actions-authored comment must not close a live lease -- doing so hands a
    // still-running issue to the next dispatch.
    const result = runReceiptStep(
      'Release the reservation when no lane ever owned it',
      'release-unstarted-reservation',
      [[comment(1, `${adoptedMarker()}\n\nadopted`), comment(9, disposedMarker())]],
      { RESERVED_ISSUE: '42', RUN_RESULT: 'failure' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('WAS adopted by lane');
    expect(result.stderr).toContain('Refusing to remove goobers/status:in-review');
    expect(result.log).not.toContain('--remove-label');
  });

  it('ignores a disposal rendered inside a trusted result comment’s journal block', () => {
    // The concrete injection shape: `Comment on Goobers run result` renders
    // journal event text into a fenced block, and journal text is agent-written.
    // A message carrying a newline plus the marker would land as a standalone,
    // whitespace-trimmed marker line inside an Actions-authored comment.
    const injected = [
      '<!-- crawler-goobers-run-result:v1 run-id=999 attempt=1 lane=1 slot=1 goobers-run=run-x workflow=crawler-feature-pr -->',
      '',
      'Goobers GitHub Actions run for `crawler-feature-pr` finished with **failed**.',
      '',
      'Terminal journal events:',
      '```',
      'stage.finished | stage=implement | status=failed | build broke',
      `  ${disposedMarker()}`,
      '```',
    ].join('\n');

    const result = runReceiptStep(
      'Release the reservation when no lane ever owned it',
      'release-unstarted-reservation',
      [[comment(1, `${adoptedMarker()}\n\nadopted`), comment(4, injected)]],
      { RESERVED_ISSUE: '42', RUN_RESULT: 'failure' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('WAS adopted by lane');
    expect(result.log).not.toContain('--remove-label');
  });

  it('negative control: the same disposal DOES close the lease inside the receipt', () => {
    // Byte-identical disposal marker, moved into the adoption's own comment —
    // the only place the writer ever puts it. Without this the tests above
    // could pass on a reader that ignores disposals altogether.
    const result = runReceiptStep(
      'Release the reservation when no lane ever owned it',
      'release-unstarted-reservation',
      [[comment(1, `${adoptedMarker()}\n\n${disposedMarker()}\n\nadopted`)]],
      { RESERVED_ISSUE: '42', RUN_RESULT: 'failure' },
    );

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('recorded a clean disposal');
    expect(result.log).not.toContain('--remove-label');
  });

  it('refuses to release a lease held by a DIFFERENT dispatch', () => {
    const result = runReceiptStep(
      'Release the reservation when no lane ever owned it',
      'release-unstarted-reservation',
      [[comment(1, adoptedMarker('4242', '2'))]],
      { RESERVED_ISSUE: '42', RUN_RESULT: 'failure' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('a DIFFERENT dispatch');
    expect(result.log).not.toContain('--remove-label');
  });

  it('treats a re-run attempt as a NEW lease rather than one already disposed', () => {
    // Same run id, previous attempt disposed. Attempt 2 adopting and then
    // failing must still read as undisposed for THIS attempt.
    const result = runReceiptStep(
      'Release the reservation when no lane ever owned it',
      'release-unstarted-reservation',
      [
        [
          comment(1, `${adoptedMarker('999', '1')}\n\n${disposedMarker('999', '1')}`),
          comment(2, adoptedMarker('999', '2')),
        ],
      ],
      { RESERVED_ISSUE: '42', RUN_RESULT: 'failure', GITHUB_RUN_ATTEMPT: '2' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('WAS adopted by lane');
    expect(result.log).not.toContain('--remove-label');
  });

  it('fails closed when the receipts cannot be read at all', () => {
    const result = runReceiptStep(
      'Release the reservation when no lane ever owned it',
      'release-unstarted-reservation',
      [[]],
      { RESERVED_ISSUE: '42', RUN_RESULT: 'failure', COMMENTS_FIXTURE_FAILS: '1' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing to treat the issue as free');
    expect(result.log).not.toContain('--remove-label');
  });

  it('records a disposal receipt only after a clean reap and disposition', () => {
    const clean = runReceiptStep(
      'Record reservation disposal',
      'run',
      [[comment(7, `${adoptedMarker()}\n\nadopted`)]],
      {
        GOOBERS_RECOVERY_ISSUE: '42',
        REAP_OUTCOME: 'success',
        DISPOSITION_OUTCOME: 'success',
      },
    );

    expect(clean.status, `stderr:\n${clean.stderr}`).toBe(0);
    expect(clean.log).toContain('issues/comments/7');
    expect(clean.stdout).toContain('Recorded the disposal receipt');
  });

  it('will not PATCH a disposal onto an untrusted look-alike receipt', () => {
    const spoofed = runReceiptStep(
      'Record reservation disposal',
      'run',
      [[comment(7, adoptedMarker(), UNTRUSTED_USER)]],
      {
        GOOBERS_RECOVERY_ISSUE: '42',
        REAP_OUTCOME: 'success',
        DISPOSITION_OUTCOME: 'success',
      },
    );

    expect(spoofed.status).not.toBe(0);
    expect(spoofed.stderr).toContain('could not be found on the issue');
    expect(spoofed.log).not.toContain('issues/comments/7');
  });

  it('PATCHes the disposal into the adoption receipt the guards will read', () => {
    // Writer and reader must resolve the SAME comment, or a disposal can be
    // written somewhere no guard will ever look. Here a trusted result comment
    // (id 3) already carries a disposal marker inside agent-written journal
    // text: it must neither close the lease early nor attract the PATCH.
    const injected = [
      '<!-- crawler-goobers-run-result:v1 run-id=999 attempt=1 lane=1 slot=2 goobers-run=run-x workflow=crawler-feature-pr -->',
      '',
      'Terminal journal events:',
      '```',
      `  ${disposedMarker()}`,
      '```',
    ].join('\n');
    const result = runReceiptStep(
      'Record reservation disposal',
      'run',
      [[comment(3, injected), comment(7, `${adoptedMarker()}\n\nadopted`)]],
      {
        GOOBERS_RECOVERY_ISSUE: '42',
        REAP_OUTCOME: 'success',
        DISPOSITION_OUTCOME: 'success',
      },
    );

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.log).toContain('issues/comments/7');
    expect(result.log).not.toContain('issues/comments/3');
  });

  it('refuses when the latest trusted adoption is not this dispatch’s', () => {
    // Nothing this lane can safely append to: appending a disposal to another
    // dispatch's receipt would publish an issue that dispatch still owns.
    const result = runReceiptStep(
      'Record reservation disposal',
      'run',
      [[comment(7, `${adoptedMarker()}\n\nadopted`), comment(9, adoptedMarker('4242', '1'))]],
      {
        GOOBERS_RECOVERY_ISSUE: '42',
        REAP_OUTCOME: 'success',
        DISPOSITION_OUTCOME: 'success',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('could not be found on the issue');
    expect(result.log).not.toContain('issues/comments/7');
    expect(result.log).not.toContain('issues/comments/9');
  });

  it('leaves the receipt undisposed when the stage-tree reap failed', () => {
    const failedReap = runReceiptStep(
      'Record reservation disposal',
      'run',
      [[comment(7, adoptedMarker())]],
      {
        GOOBERS_RECOVERY_ISSUE: '42',
        REAP_OUTCOME: 'failure',
        DISPOSITION_OUTCOME: 'skipped',
      },
    );

    expect(failedReap.status).not.toBe(0);
    expect(failedReap.stderr).toContain('Leaving the adoption receipt undisposed');
    // No PATCH at all: the evidence must stay adopted-only so the guard refuses.
    expect(failedReap.log).not.toContain('issues/comments/7');
  });

  it('leaves the receipt undisposed when the run disposition failed', () => {
    const failedDisposition = runReceiptStep(
      'Record reservation disposal',
      'run',
      [[comment(7, adoptedMarker())]],
      {
        GOOBERS_RECOVERY_ISSUE: '42',
        REAP_OUTCOME: 'success',
        DISPOSITION_OUTCOME: 'failure',
      },
    );

    expect(failedDisposition.status).not.toBe(0);
    expect(failedDisposition.stderr).toContain('Leaving the adoption receipt undisposed');
    expect(failedDisposition.log).not.toContain('issues/comments/7');
  });
});

/**
 * Executable regression for the DURABLE half of the lease: a prior dispatch's
 * adopted-but-undisposed receipt must survive that dispatch's Actions run and
 * keep the next one off the issue.
 *
 * An Actions run reports `completed` while a Setsid-detached stage descendant
 * is still pushing -- that is exactly the state `goobers-stage-teardown.sh`
 * refuses to call clean, and exactly the state that leaves the receipt
 * undisposed. Selecting on `goobers/status:in-review` alone therefore re-adopts
 * a live issue.
 */
describe.skipIf(!hasJq)('goobers-run.yml durable recovery lease', () => {
  it('skips an in-review issue whose prior lease was never disposed', () => {
    const held = runReserveStep('Resolve Goobers recovery target', SELF_RUN_ONLY, {
      RECOVERY_SCAN_FIXTURE_ISSUES: '42',
      COMMENTS_FIXTURE_BODY: `${adoptedMarker('4242', '1')}`,
      COMMENTS_FIXTURE_TRUSTED: '1',
    });

    expect(held.status, `stderr:\n${held.stderr}`).toBe(0);
    expect(held.stderr).toContain('reservation lease is still held by');
    expect(held.stderr).toContain('--remove-label goobers/status:in-review');
    // Nothing designated, so no lane can resume it.
    expect(held.output).not.toContain('recovery_issue=');
  });

  it('negative control: the same issue IS selected once the lease is disposed', () => {
    const free = runReserveStep('Resolve Goobers recovery target', SELF_RUN_ONLY, {
      RECOVERY_SCAN_FIXTURE_ISSUES: '42',
      COMMENTS_FIXTURE_BODY: `${adoptedMarker('4242', '1')}\n${disposedMarker('4242', '1')}`,
      COMMENTS_FIXTURE_TRUSTED: '1',
    });

    expect(free.status, `stderr:\n${free.stderr}`).toBe(0);
    expect(free.output).toContain('recovery_issue=42');
    expect(free.stdout).toContain('reservation lease: free');
  });

  it('ignores an untrusted comment claiming to hold the lease', () => {
    const spoofed = runReserveStep('Resolve Goobers recovery target', SELF_RUN_ONLY, {
      RECOVERY_SCAN_FIXTURE_ISSUES: '42',
      COMMENTS_FIXTURE_BODY: `${adoptedMarker('4242', '1')}`,
      COMMENTS_FIXTURE_TRUSTED: '0',
    });

    expect(spoofed.status, `stderr:\n${spoofed.stderr}`).toBe(0);
    expect(spoofed.output).toContain('recovery_issue=42');
  });

  it('fails an explicitly requested issue that is still leased', () => {
    const result = runReserveStep('Resolve Goobers recovery target', SELF_RUN_ONLY, {
      ISSUE_NUMBER: '42',
      EXPLICIT_ISSUE_NUMBER: '42',
      COMMENTS_FIXTURE_BODY: `${adoptedMarker('4242', '1')}`,
      COMMENTS_FIXTURE_TRUSTED: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('undisposed Goobers reservation lease');
    expect(result.output).not.toContain('recovery_issue=');
  });

  it('refuses to adopt a reservation another dispatch still holds', () => {
    const result = runReceiptStep(
      'Adopt the reserved recovery target',
      'run',
      [[comment(1, adoptedMarker('4242', '1'))]],
      {
        RESERVED_ISSUE: '42',
        RESERVED_RESUME_PR: '',
        RESERVED_RESUME_BRANCH: '',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing to adopt reserved issue #42');
    // No receipt written and, critically, no recovery metadata exported: the
    // lane must not start a recovery slot.
    expect(result.log).not.toContain('gh issue comment');
  });

  it('adopts normally when the previous lease was disposed', () => {
    const result = runReceiptStep(
      'Adopt the reserved recovery target',
      'run',
      [[comment(1, `${adoptedMarker('4242', '1')}\n${disposedMarker('4242', '1')}`)]],
      {
        RESERVED_ISSUE: '42',
        RESERVED_RESUME_PR: '',
        RESERVED_RESUME_BRANCH: '',
      },
    );

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.log).toContain('gh issue comment 42');
    // The receipt it writes is scoped to THIS run and attempt.
    expect(result.log).toContain(adoptedMarker('999', '1', '42'));
  });
});

/**
 * Executable regression for fail-closed backlog reads.
 *
 * Both scans used to be `for candidate in $(gh �)`, which throws the exit
 * status away. An auth failure, an API outage or a secondary rate limit then
 * produced an EMPTY candidate list, and the step read it as "no recovery work"
 * / "no eligible work" � silently skipping live recovery, or reporting an empty
 * backlog while the backlog was full and exiting before the run job.
 */
describe.skipIf(!hasJq)('goobers-run.yml backlog read failures', () => {
  it('fails closed when the recovery scan cannot be read', () => {
    const result = runReserveStep('Resolve Goobers recovery target', SELF_RUN_ONLY, {
      RECOVERY_SCAN_FAILS: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the open goobers/status:in-review recovery backlog');
    expect(result.stderr).toContain('Refusing to continue on an unverified backlog');
    // Actionable: it names the command that shows why.
    expect(result.stderr).toContain('gh api rate_limit');
    // And it must NOT have fallen through to "no work" and skipped the run.
    expect(result.output).not.toContain('should_run=false');
  });

  it('fails closed when the fresh eligibility scan cannot be read', () => {
    const result = runReserveStep('Resolve Goobers recovery target', SELF_RUN_ONLY, {
      FRESH_SCAN_FAILS: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the maintainer-approved Goobers queue');
    expect(result.stderr).toContain('Refusing to continue on an unverified backlog');
    // The dangerous outcome this replaces: a failed search reporting "no work".
    expect(result.output).not.toContain('should_run=false');
  });

  it('negative control: a readable scan still reports an eligible backlog', () => {
    const result = runReserveStep('Resolve Goobers recovery target', SELF_RUN_ONLY, {});

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('Eligible fresh backlog work exists');
    expect(result.output).not.toContain('should_run=false');
  });

  it('never splices a gh advisory notice into the candidate list', () => {
    // `2>&1` on the capture would fold gh's stderr notices into the list, and
    // the next loop would hand that text to the PR/blocker lookups as an issue
    // number. stderr goes to its own file; only stdout is candidates.
    const result = runReserveStep('Resolve Goobers recovery target', SELF_RUN_ONLY, {
      RECOVERY_SCAN_FIXTURE_ISSUES: '42',
      RECOVERY_SCAN_NOISE: 'gh: a new release of gh is available',
    });

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.output).toContain('recovery_issue=42');
    // The notice was never treated as a candidate.
    expect(result.stderr).not.toContain('where the recovery scan expected an issue number');
    expect(result.log).not.toContain('a new release of gh is available');
  });

  it('refuses an unrecognised backlog response instead of acting on it', () => {
    const result = runReserveStep('Resolve Goobers recovery target', SELF_RUN_ONLY, {
      RECOVERY_SCAN_FIXTURE_ISSUES: 'not-an-issue-number',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('where the recovery scan expected an issue number');
    expect(result.output).not.toContain('recovery_issue=');
  });
});

/**
 * Executable regression for the guaranteed diagnostics artifact.
 *
 * Both journal uploads glob `slot-*?/gaggles/*?/runs/`, which matches nothing
 * when a slot never produced a journal � and that is exactly the failure whose
 * error messages and result comments point a human at the artifact. The
 * sentinel makes the artifact exist unconditionally, which is what lets both
 * uploads use `if-no-files-found: error`.
 */
describe.skipIf(!hasBash)('goobers-run.yml slot diagnostics sentinel', () => {
  function runSentinel(env: Record<string, string> = {}): {
    status: number | null;
    stderr: string;
    laneRoot: string;
  } {
    const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-sentinel-'));
    const laneRoot = path.join(workdir, 'lane-1');
    const scriptPath = path.join(workdir, 'step.sh');
    writeFileSync(scriptPath, `${stepScript('Write slot diagnostics sentinel')}\n`, 'utf8');
    const result = spawnSync('bash', [toBashScriptPath(scriptPath)], {
      encoding: 'utf8',
      env: bashEnv({
        GOOBERS_LANE: '1',
        GOOBERS_SLOTS: '1 2',
        GOOBERS_LANE_ROOT: toBashScriptPath(laneRoot),
        GOOBERS_RECOVERY_LANE: '1',
        GOOBERS_RECOVERY_SLOT: '1',
        GOOBERS_RECOVERY_ISSUE: '42',
        GOOBERS_WORKFLOW: 'crawler-feature-pr',
        GITHUB_REPOSITORY: 'nalfeo/Crawler',
        GITHUB_RUN_ID: '999',
        GITHUB_RUN_ATTEMPT: '1',
        REAP_OUTCOME: 'success',
        ...env,
      }),
    });
    return { status: result.status, stderr: result.stderr ?? '', laneRoot };
  }

  it('writes an identifying file for every slot even when nothing ran at all', () => {
    const { status, stderr, laneRoot } = runSentinel();

    expect(status, `stderr:\n${stderr}`).toBe(0);
    for (const slot of ['1', '2']) {
      const sentinel = path.join(laneRoot, `slot-${slot}`, 'diagnostics', 'slot-diagnostics.txt');
      expect(existsSync(sentinel), `no sentinel for slot ${slot}`).toBe(true);
      const body = readFileSync(sentinel, 'utf8');
      expect(body).toContain('lane=1');
      expect(body).toContain(`slot=${slot}`);
      expect(body).toContain('actions-run=999');
      expect(body).toContain('actions-run-attempt=1');
      expect(body).toContain('recovery-issue=42');
      expect(body).toContain('stage-tree-reap=success');
      // The journal-less case says so explicitly rather than trailing off.
      expect(body).toContain('(none');
    }
  });

  it('lists the journals it found when a slot did produce one', () => {
    const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-sentinel-full-'));
    const laneRoot = path.join(workdir, 'lane-1');
    const runDir = path.join(laneRoot, 'slot-1', 'gaggles', 'crawler', 'runs', 'run-aaa');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'events.jsonl'), '{"type":"run.finished"}\n', 'utf8');

    const scriptPath = path.join(workdir, 'step.sh');
    writeFileSync(scriptPath, `${stepScript('Write slot diagnostics sentinel')}\n`, 'utf8');
    const result = spawnSync('bash', [toBashScriptPath(scriptPath)], {
      encoding: 'utf8',
      env: bashEnv({
        GOOBERS_LANE: '1',
        GOOBERS_SLOTS: '1 2',
        GOOBERS_LANE_ROOT: toBashScriptPath(laneRoot),
        GOOBERS_RECOVERY_LANE: '1',
        GOOBERS_RECOVERY_SLOT: '1',
        GOOBERS_RECOVERY_ISSUE: '',
        GOOBERS_WORKFLOW: 'crawler-feature-pr',
        GITHUB_REPOSITORY: 'nalfeo/Crawler',
        GITHUB_RUN_ID: '999',
        GITHUB_RUN_ATTEMPT: '1',
        REAP_OUTCOME: 'success',
      }),
    });

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    const slot1 = readFileSync(
      path.join(laneRoot, 'slot-1', 'diagnostics', 'slot-diagnostics.txt'),
      'utf8',
    );
    expect(slot1).toContain('run-aaa/events.jsonl');
    expect(slot1).not.toContain('(none');
    const slot2 = readFileSync(
      path.join(laneRoot, 'slot-2', 'diagnostics', 'slot-diagnostics.txt'),
      'utf8',
    );
    expect(slot2).toContain('(none');
  });
});

/**
 * Executable regression for the ROOTLESS cancellation reap.
 *
 * The deadline path passes each slot's `goobers run` pid as a root, so the
 * ppid closure alone finds the tree. The `always()` reap has no such root: on a
 * cancelled or failed job the `goobers run` process is already gone and Actions
 * has terminated the step's own process group, which never reaches a
 * Setsid-detached stage. The only thing left that identifies a survivor is the
 * GOOBERS_INSTANCE value it inherited.
 *
 * That is the path this suite runs � the exact "Reap surviving Goobers stage
 * processes" step script from the workflow, against a real orphan in its own
 * session with no surviving parent.
 */
describe.skipIf(!hasProc || !hasSetsid)('goobers-run.yml rootless cancellation reap', () => {
  interface Orphan {
    workdir: string;
    laneRoot: string;
    slotRoot: string;
    orphanPid: string;
    bystanderPid: string;
    heartbeat: string;
  }

  function spawnOrphanAndBystander(): Orphan {
    const workdir = mkdtempSync(path.join(tmpdir(), 'goobers-reap-'));
    const laneRoot = path.join(workdir, 'lane-1');
    const slotRoot = `${toBashScriptPath(laneRoot)}/slot-1`;
    mkdirSync(path.join(laneRoot, 'slot-1'), { recursive: true });

    const heartbeat = path.join(workdir, 'heartbeat.log');
    writeFileSync(heartbeat, '', 'utf8');
    const orphanPidFile = path.join(workdir, 'orphan.pid');
    writeFileSync(orphanPidFile, '', 'utf8');
    const bystanderPidFile = path.join(workdir, 'bystander.pid');
    writeFileSync(bystanderPidFile, '', 'utf8');

    // A Setsid-detached stage descendant carrying this slot's GOOBERS_INSTANCE,
    // whose launcher exits immediately � so it is reparented to init and has no
    // ppid path back to anything the sweep could otherwise find.
    const launch = spawnSync(
      'bash',
      [
        '-c',
        `setsid env GOOBERS_INSTANCE="${slotRoot}" bash -c 'printf "%s\\n" "$$" > "$1"; while true; do printf "beat\\n" >> "$2"; sleep 0.2; done' _ "${toBashScriptPath(
          orphanPidFile,
        )}" "${toBashScriptPath(heartbeat)}" >/dev/null 2>&1 < /dev/null &
         bash -c 'printf "%s\\n" "$$" > "$1"; exec sleep 45' _ "${toBashScriptPath(
           bystanderPidFile,
         )}" >/dev/null 2>&1 < /dev/null &
         disown -a
         sleep 1`,
      ],
      { encoding: 'utf8' },
    );
    expect(launch.status, `stderr:\n${launch.stderr}`).toBe(0);

    const orphanPid = readFileSync(orphanPidFile, 'utf8').trim();
    const bystanderPid = readFileSync(bystanderPidFile, 'utf8').trim();
    expect(orphanPid, 'the orphaned stage never recorded its pid').toMatch(/^\d+$/);
    expect(bystanderPid, 'the bystander never recorded its pid').toMatch(/^\d+$/);

    return { workdir, laneRoot, slotRoot, orphanPid, bystanderPid, heartbeat };
  }

  function runReapStep(
    orphan: Orphan,
    prelude = '',
  ): { status: number | null; stdout: string; stderr: string } {
    const scriptPath = path.join(orphan.workdir, 'reap.sh');
    writeFileSync(
      scriptPath,
      `${prelude}${stepScript('Reap surviving Goobers stage processes')}\n`,
      'utf8',
    );
    const result = spawnSync('bash', [toBashScriptPath(scriptPath)], {
      encoding: 'utf8',
      env: bashEnv({
        GOOBERS_LANE: '1',
        GOOBERS_SLOTS: '1',
        GOOBERS_LANE_ROOT: toBashScriptPath(orphan.laneRoot),
        GITHUB_WORKSPACE: toBashScriptPath(REPO_ROOT),
        GITHUB_REPOSITORY: 'nalfeo/Crawler',
      }),
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  function isAlive(pid: string): boolean {
    return spawnSync('bash', ['-c', `kill -0 ${pid} 2>/dev/null`]).status === 0;
  }

  it('kills a rootless orphan that carries GOOBERS_INSTANCE and spares a bystander', () => {
    const orphan = spawnOrphanAndBystander();
    try {
      expect(isAlive(orphan.orphanPid), 'the orphan died before the reap ran').toBe(true);

      const result = runReapStep(orphan);

      // No root pid was passed and the launcher is long gone: only the
      // GOOBERS_INSTANCE identity could have found this process.
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('stage tree fully terminated');
      expect(isAlive(orphan.orphanPid), 'the orphaned stage survived the reap').toBe(false);

      // ...and it really stopped working rather than becoming unsignalable.
      const beatsAtReap = readFileSync(orphan.heartbeat, 'utf8').split('\n').length;
      spawnSync('bash', ['-c', 'sleep 1.5']);
      expect(readFileSync(orphan.heartbeat, 'utf8').split('\n').length).toBe(beatsAtReap);

      // Selection is by identity, never by process name: an unrelated `sleep`
      // in another session is untouched.
      expect(isAlive(orphan.bystanderPid), 'the reap killed a process outside the slot').toBe(true);
    } finally {
      spawnSync('bash', [
        '-c',
        `kill -9 ${orphan.orphanPid} ${orphan.bystanderPid} 2>/dev/null || true`,
      ]);
    }
  }, 120_000);

  it('propagates a non-zero exit when a survivor cannot be terminated', () => {
    const orphan = spawnOrphanAndBystander();
    try {
      // Deterministic failure injection at the one point that can actually
      // fail in production: signal delivery. `kill` is shadowed for the whole
      // step, so the real teardown library runs unchanged, finds the orphan,
      // "signals" it, and then correctly refuses to report success because the
      // process is still alive. `sleep` is shadowed only to keep the 30s grace
      // and 15s verification windows from making the test slow.
      const prelude = ['kill() { return 0; }', 'sleep() { return 0; }', ''].join('\n');
      const result = runReapStep(orphan, prelude);

      expect(result.status, `stdout:\n${result.stdout}`).not.toBe(0);
      expect(result.stderr).toContain('still has');
      expect(result.stderr).toContain('live process(es) after SIGKILL');
      // The step turns that into the gate the disposition step reads.
      expect(result.stderr).toContain('is being SKIPPED');
      expect(result.stderr).toContain('--remove-label goobers/status:in-review');
      expect(isAlive(orphan.orphanPid), 'the injected failure did not actually spare it').toBe(
        true,
      );
    } finally {
      spawnSync('bash', [
        '-c',
        `kill -9 ${orphan.orphanPid} ${orphan.bystanderPid} 2>/dev/null || true`,
      ]);
    }
  }, 120_000);
});
