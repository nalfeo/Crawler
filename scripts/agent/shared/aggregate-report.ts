#!/usr/bin/env node
/**
 * shared/aggregate-report.ts — Combine all per-script `*.json` summaries from
 * `$AUTOMATION_REPORT_DIR` into a single Markdown issue body on stdout.
 *
 * The workflow pipes this output into `gh issue create --body-file`.
 *
 * GitHub imposes a 65 536-character limit on issue bodies.
 * `withTrackingIssueRunMetadata` (called by the workflow step) prepends ~200
 * characters of HTML-comment metadata, so we cap at GITHUB_BODY_LIMIT minus a
 * conservative overhead before writing to stdout.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { ReportSummary } from './report.js';

/** GitHub REST API hard limit for issue/PR body text (characters). */
const GITHUB_BODY_LIMIT = 65_536;
/** Reserved headroom for metadata prepended by withTrackingIssueRunMetadata. */
const METADATA_OVERHEAD = 400;
const MAX_BODY_CHARS = GITHUB_BODY_LIMIT - METADATA_OVERHEAD;

const dir = process.env.AUTOMATION_REPORT_DIR;
if (!dir) {
  process.stderr.write('AUTOMATION_REPORT_DIR not set.\n');
  process.exit(1);
}

const title = process.env.AUTOMATION_TITLE ?? 'automation: scheduled report';
const workflow = process.env.GITHUB_WORKFLOW ?? 'unknown';
const runUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

const summaries: ReportSummary[] = [];
for (const entry of readdirSync(dir).sort()) {
  if (!entry.endsWith('.json')) continue;
  try {
    summaries.push(JSON.parse(readFileSync(path.join(dir, entry), 'utf8')) as ReportSummary);
  } catch (err) {
    process.stderr.write(`Skipping unreadable summary ${entry}: ${String(err)}\n`);
  }
}

const totalBlocking = summaries.reduce((acc, s) => acc + s.blocking, 0);
const totalFindings = summaries.reduce((acc, s) => acc + s.findings.length, 0);

const lines: string[] = [];
lines.push(`# ${title}`);
lines.push('');
lines.push(`Workflow: \`${workflow}\``);
if (runUrl) lines.push(`Run: ${runUrl}`);
lines.push('');
lines.push(
  `**Findings:** ${totalFindings} across ${summaries.length} script(s) (${totalBlocking} blocking)`,
);
lines.push('');
for (const s of summaries) {
  lines.push(`## ${s.script} — ${s.findings.length} finding(s), ${s.blocking} blocking`);
  lines.push('');
  if (s.findings.length === 0) {
    lines.push('_clean_');
    lines.push('');
    continue;
  }
  for (const f of s.findings) {
    const label = `\`${f.severity}\``;
    const loc = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
    lines.push(`- ${label}${loc} ${f.message}`);
    if (f.remediation) lines.push(`  - ↳ ${f.remediation}`);
  }
  lines.push('');
}

const body = lines.join('\n');
if (body.length > MAX_BODY_CHARS) {
  const truncationNotice =
    `\n\n---\n_Report truncated: body exceeded ${MAX_BODY_CHARS} characters. ` +
    `${totalFindings} findings total across ${summaries.length} script(s). ` +
    `See the [workflow run](${runUrl ?? '#'}) for the full output._`;
  const trimmed = body.slice(0, MAX_BODY_CHARS - truncationNotice.length) + truncationNotice;
  process.stdout.write(trimmed);
} else {
  process.stdout.write(body);
}

// Non-zero exit means "issue should be created"; zero means "all clean".
process.exit(totalBlocking > 0 || hasNonInformational(summaries) ? 1 : 0);

function hasNonInformational(items: ReportSummary[]): boolean {
  return items.some((s) => s.findings.some((f) => f.severity === 'error' || f.severity === 'warn'));
}
