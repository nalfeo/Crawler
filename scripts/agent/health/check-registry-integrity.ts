#!/usr/bin/env node
/**
 * health/check-registry-integrity.ts — CI guard against data-registry ID
 * collisions, including CROSS-FILE collisions inside a shared ID namespace
 * that today's per-file loaders structurally cannot see.
 *
 * Exits 1 when any registered registry file contains:
 *   - a duplicate id within the file,
 *   - a duplicate id across sibling files sharing one logical namespace
 *     (e.g. achievements.floor1.json + achievements.floor2.json),
 *   - an empty, blank, or non-string id,
 *   - or fails to exist / parse / match its expected shape.
 *
 * This file is the thin I/O shell: it reads each `REGISTRY_FILES` spec off
 * disk, parses the JSON, and hands pre-parsed `RegistrySource`s to the pure
 * `checkRegistryIntegrity`. All logic — and all of its test coverage — lives in
 * `registry-integrity-lib.ts`.
 *
 * Pure JSON reads only (no sim, no git, no subprocess), so it is cheap enough
 * for `verify:fast`.
 */

import { readFileSync } from 'node:fs';
import { Report, fromRepo } from '../shared/report.js';
import {
  REGISTRY_FILES,
  checkRegistryIntegrity,
  countEntries,
  extractEntries,
  type RegistrySource,
} from './registry-integrity-lib.js';

const report = new Report('check-registry-integrity');

/** Read + parse + shape one registry file into a source (never throws). */
function loadSource(spec: (typeof REGISTRY_FILES)[number]): RegistrySource {
  const base = { id: spec.id, path: spec.path, scope: spec.scope, entries: [] } as const;

  let content: string;
  try {
    content = readFileSync(fromRepo(...spec.path.split('/')), 'utf8');
  } catch (e) {
    return { ...base, loadError: `file could not be read (${(e as Error).message})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { ...base, loadError: `file is not valid JSON (${(e as Error).message})` };
  }

  const result = extractEntries(parsed, spec);
  if (result.error !== undefined) {
    return { ...base, loadError: result.error };
  }
  return { ...base, entries: result.entries };
}

const sources = REGISTRY_FILES.map(loadSource);
const findings = checkRegistryIntegrity(sources);

for (const finding of findings) {
  report.error(`[${finding.kind}] ${finding.detail}`, {
    file: finding.file,
    remediation: finding.remediation,
  });
}

if (report.blockingCount() === 0) {
  const scopes = new Set(REGISTRY_FILES.map((s) => s.scope));
  report.info(
    `OK: ${countEntries(sources)} entries across ${sources.length} registry file(s) in ` +
      `${scopes.size} id namespace(s) — no duplicate, blank, or non-string ids.`,
  );
}

report.finish();
