#!/usr/bin/env node
/**
 * shared/wrap-step.ts — Run an arbitrary command, stream its stdout/stderr,
 * exit with the same code, AND write a `ReportSummary` JSON to
 * `$AUTOMATION_REPORT_DIR/<name>.json` so the aggregator picks it up.
 *
 * Used in workflows to wrap steps that don't natively use the shared `Report`
 * class (npm audit, the bash-based security scans). Without this, those
 * steps' findings would be missing from the aggregated tracking issue even
 * if the steps failed — defeating the point of the loop.
 *
 * Usage:
 *   tsx wrap-step.ts --name <script-name> -- <cmd> [args...]
 *
 * Exit code is always the wrapped command's exit code. Workflow `continue-on-error`
 * still applies normally.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const sepIdx = argv.indexOf('--');
if (sepIdx === -1) {
  process.stderr.write('wrap-step: missing `--` separator before the command.\n');
  process.exit(2);
}
const flags = argv.slice(0, sepIdx);
const cmdParts = argv.slice(sepIdx + 1);
const nameIdx = flags.indexOf('--name');
const name = nameIdx >= 0 ? flags[nameIdx + 1] : undefined;
if (!name || cmdParts.length === 0) {
  process.stderr.write('wrap-step: usage: --name <script-name> -- <cmd> [args...]\n');
  process.exit(2);
}

const started = new Date().toISOString();
const [cmd, ...rest] = cmdParts as [string, ...string[]];
let stdoutBuf = '';
let stderrBuf = '';

const child = spawn(cmd, rest, { stdio: ['inherit', 'pipe', 'pipe'] });
child.stdout.on('data', (d: Buffer) => {
  const s = d.toString('utf8');
  stdoutBuf += s;
  process.stdout.write(s);
});
child.stderr.on('data', (d: Buffer) => {
  const s = d.toString('utf8');
  stderrBuf += s;
  process.stderr.write(s);
});
child.on('close', (code, signal) => {
  // Node sets code=null when the child is terminated by a signal (SIGKILL
  // from OOM killer, SIGTERM from runner timeout, etc.). Treating that as
  // success would silently swallow CI failures, so default unknown exits to
  // 1 and surface the signal in the message.
  const status = code ?? 1;
  const killedBySignal = code === null && signal !== null;
  const dir = process.env.AUTOMATION_REPORT_DIR;
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // already exists
    }
    // Keep the tail — issue body would otherwise blow past GitHub's 65k limit
    // if a noisy tool (e.g. npm audit) dumps the world.
    const combined = (stdoutBuf + stderrBuf).slice(-4000).trim();
    const cmdline = cmdParts.join(' ');
    const findings =
      status === 0
        ? [{ severity: 'info' as const, message: `OK (\`${cmdline}\`)` }]
        : [
            {
              severity: 'error' as const,
              message:
                `Command failed (${killedBySignal ? `killed by ${signal}` : `exit ${status}`}): \`${cmdline}\`\n\n` +
                '```\n' +
                (combined || '(no output)') +
                '\n```',
            },
          ];
    writeFileSync(
      path.join(dir, `${name}.json`),
      JSON.stringify(
        {
          script: name,
          startedAt: started,
          finishedAt: new Date().toISOString(),
          findings,
          blocking: status === 0 ? 0 : 1,
        },
        null,
        2,
      ),
    );
  }
  process.exit(status);
});
