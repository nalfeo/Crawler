/* global console, process */

import fs from 'node:fs';

const summaryPath = process.env.COVERAGE_SUMMARY_JSON;
const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;

function unavailable() {
  return `\n📊 Coverage: unavailable ([deploy artifact](${runUrl}))`;
}

function pct(total, key) {
  const value = total?.[key]?.pct;
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : 'n/a';
}

try {
  if (!summaryPath || !fs.existsSync(summaryPath)) {
    process.stdout.write(unavailable());
    process.exit(0);
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const total = summary.total || {};
  process.stdout.write(
    `\n📊 Coverage: lines ${pct(total, 'lines')}, branches ${pct(total, 'branches')}, functions ${pct(total, 'functions')}, statements ${pct(total, 'statements')} ([summary artifact](${runUrl}))`,
  );
} catch (error) {
  console.log(`::warning::Failed to format coverage summary: ${error.message}`);
  process.stdout.write(unavailable());
}
