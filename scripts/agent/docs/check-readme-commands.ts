#!/usr/bin/env node
/**
 * docs/check-readme-commands.ts — Ensure every `npm run X` referenced in
 * README.md and AGENTS.md actually exists as a script in package.json.
 *
 * Also flags scripts that exist in package.json but are completely missing
 * from both docs (informational — not every script needs to be documented).
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const NPM_RUN = /`npm run ([a-zA-Z0-9:_-]+)`/g;
const DIRECT_NPM = /`npm (test|run [a-zA-Z0-9:_-]+)`/g;

interface PackageJson {
  readonly scripts?: Readonly<Record<string, string>>;
}

function loadPackageScripts(): ReadonlyArray<string> {
  const text = readFileSync(fromRepo('package.json'), 'utf8');
  const json = JSON.parse(text) as PackageJson;
  return Object.keys(json.scripts ?? {});
}

function extractReferences(text: string): Set<string> {
  const refs = new Set<string>();
  let m: RegExpExecArray | null;
  const re1 = new RegExp(NPM_RUN.source, 'g');
  while ((m = re1.exec(text)) !== null) {
    if (m[1]) refs.add(m[1]);
  }
  const re2 = new RegExp(DIRECT_NPM.source, 'g');
  while ((m = re2.exec(text)) !== null) {
    const full = m[1];
    if (full === 'test') refs.add('test');
  }
  return refs;
}

async function main(): Promise<void> {
  const report = new Report('docs-check-readme-commands');
  const declared = new Set(loadPackageScripts());
  const docs: Array<readonly [string, string]> = [
    ['README.md', readFileSync(fromRepo('README.md'), 'utf8')],
    ['AGENTS.md', readFileSync(fromRepo('AGENTS.md'), 'utf8')],
  ];

  const allRefs = new Set<string>();
  for (const [file, text] of docs) {
    const refs = extractReferences(text);
    for (const r of refs) {
      allRefs.add(r);
      if (!declared.has(r)) {
        report.error(`Doc references missing npm script: \`npm run ${r}\``, {
          file,
          remediation: 'Add the script to package.json or update the doc.',
        });
      }
    }
  }

  for (const script of declared) {
    if (script.startsWith('pre') || script.startsWith('post')) continue;
    if (!allRefs.has(script) && script !== 'test') {
      report.info(`Script not documented in README/AGENTS: \`npm run ${script}\``);
    }
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(
    `check-readme-commands crashed: ${err instanceof Error ? err.stack : err}\n`,
  );
  process.exit(2);
});
