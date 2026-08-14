#!/usr/bin/env node
/**
 * docs/build-system-index.ts — Build docs/knowledge/handoffs/INDEX.md, a
 * per-system index of unarchived handoffs.
 *
 * For each handoff:
 *  1. If the handoff has a `## Systems touched` line, parse its comma-separated
 *     slug list.
 *  2. Otherwise (legacy handoffs written before this file existed), fall back
 *     to a filename-slug regex classifier that maps common substrings onto the
 *     canonical slug list in docs/systems/README.md.
 *  3. Log any handoff we can't classify as a `report.warn`.
 *
 * Emits INDEX.md grouped by system in the same order as docs/systems/README.md,
 * newest handoffs first within each section, capped at 20 per system with a
 * trailing "…and N older" note. Archived handoffs are excluded.
 *
 * Dry-run by default; pass `--apply` (or `AUTOMATION_APPLY=1`) to write the
 * file. The workflow uses --apply and picks up the diff via git.
 *
 * Exits 0 always — findings are informational.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Report, fromRepo } from '../shared/report.js';

const HANDOFFS_DIR = 'docs/knowledge/handoffs';
const SYSTEMS_DOC = 'docs/systems/README.md';
const INDEX_FILE = 'docs/knowledge/handoffs/INDEX.md';
const PER_SYSTEM_CAP = 20;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;

/**
 * Regex-based fallback classifier for legacy handoffs (those written before
 * the `## Systems touched` field existed). Applied to the filename slug
 * (everything after the YYYY-MM-DD- prefix, minus the .md). Order matters
 * only for readability — a handoff can match multiple systems.
 *
 * Keep this list generous. The goal is to give planners *some* coverage in
 * the index, not to be surgically precise for old sessions.
 */
const HEURISTICS: ReadonlyArray<readonly [RegExp, ReadonlyArray<string>]> = [
  // ai-pathfinding
  [/pathfind|flow-field|nav|sidestep|safe-gap|wedge|steering|dodge|diagonal/, ['ai-pathfinding']],
  // ai-combat-balance
  [/winrate|weapon-sweep|hill-climb|balance|calibration|coverage-threshold/, ['ai-combat-balance']],
  // ai-behavior-tree
  [
    /bt-ai|behavior-tree|threat|perception|opportunistic|harvesting|pickup|magic-ranged|ai-runner|ai-exploration|ai-provider|family-ai|player-ai/,
    ['ai-behavior-tree'],
  ],
  // sprite-workflow (matched before sprite-pipeline so more specific workflow slugs win)
  [
    /sprite-workflow|sprite-gallery|sprite-worker|sprite-checkin|sprite-catalog|sprite-reference|sprite-cli|placeholder|sidecar|azure-sheet|azure-sidecar|cache-sprite|sprite-gen-stuck|non-llm-sprite|brief-synth|vlm-judge|anchor-overlay|item-anchor|art-asset-plan|asset-request|asset-checkin|asset-ingestion|asset-checked/,
    ['sprite-workflow'],
  ],
  // sprite-pipeline
  [
    /sprite|postprocess|pixels-to-feet|px-to-feet|generated-sprite|template-driven-postprocess|smarter-sprite|palette|resize|slice|enclosed-bg|art-wiring|floor-1-pixel-art/,
    ['sprite-pipeline'],
  ],
  // mapgen
  [
    /mapgen|dungeon-generator|floor\d|cave|room-reachability|room-perimeter|set-piece|shop-|welcome-room|map-fixtures|double-map|special-room|seed\d+|terrain-tiling|blob-tile|tile-render|autotiling|muddy-tile|door-lock|safe-room|floor-config|floor-objective|floating-door|tile-postprocess/,
    ['mapgen'],
  ],
  // quests
  [
    /quest|meet-npcs|welcome-sign|waypoint|arrows|materials-harvesting|achievement|winrate-sweep-gate|npc-system|npc-spawn|death-screen/,
    ['quests'],
  ],
  // hud-ux
  [
    /\bhud\b|minimap|damage-number|health-bar|blurry|hidpi|floating-gems|dossier|loadout-modal|ux-art|ux-snapshot|visual-snapshot|tutorial-text/,
    ['hud-ux'],
  ],
  // mobile-ux
  [/mobile|touch|pinch|swipe/, ['mobile-ux']],
  // lighting
  [/lighting|light-field|fov|dynamic-light|ambient/, ['lighting']],
  // inventory
  [
    /inventory|\bgear\b|gold-coin|xp-|progression|drops|loot|item-icon|shop-gear|weight-component|health-lab/,
    ['inventory'],
  ],
  // vfx
  [
    /\bvfx\b|gore|corpse|effects-pipeline|missing-gore|spawn-vfx|spell-cast|playerhurt|round-damage|knockback/,
    ['vfx'],
  ],
  // weapons
  [
    /weapon|baseball-bat|abilities|spell|berserker-brew|skull-mace|corpse-explosion|combat-perf|status-effect|charm-effect|projectile|apply-damage|melee-returning|skill-system/,
    ['weapons'],
  ],
  // enemies
  [
    /\bmob\b|mob-|spawner|slime|rat|ratslime|enemy|baby-slime|red-placeholder|orientation-axis/,
    ['enemies'],
  ],
  // boss-rooms
  [/\bboss\b|post-boss|stairs-open|collapse-timer/, ['boss-rooms']],
  // azure-infra
  [/azure|github-pages|pages-generated/, ['azure-infra']],
  // ci-policy
  [
    /\bci\b|verify|review-|reviewer-|pr-shepherd|shepherd-|apple-calibration|complexity|deflake|guard-|anti-shortcut|approve-|auto-resolve|auto-run|auto-rebase|workflow|thread-first|setup-node|streamline|md-only|orphaned|characterization|prettier|playwright|copilot-setup|agent-merge|coverage-gap|coverage-|preexisting-failure|hook-gate|enforcement-hook|automation-loop|automation-speedup|e2e|build-perf|server-launch|harness-gap|lab-feedback|chronicle-telemetry|telemetry|reload-recovery/,
    ['ci-policy'],
  ],
  // agent-memory
  [/agent-memory|memory-system|memory-repair/, ['agent-memory']],
  // worktree-server
  [/worktree|runstore/, ['worktree-server']],
  // devtools
  [
    /devtools|prop-lab|delete-selected-run|progress-nav|perf-panel|playerinput-lab|projectilecleanup-lab|lab-viewport|batch-cli|synth-env|engine-manifest|manifest-loader|abortable-sleep|multi-sentence-brief|time-aware-bot/,
    ['devtools'],
  ],
  // agent-personas
  [
    /persona|producer|shepherd|reviewer|refactor-cleanup|refactor-campaign|fun-score|fun-rater/,
    ['agent-personas'],
  ],
  // mcp-tooling
  [/\bmcp\b|skills-tooling|mcp-and-skills/, ['mcp-tooling']],
  // docs-tooling
  [
    /docs-|adr-|handoff|template|specs-review|copilot-thread|game-design|observe-before-done|incremental-change|placeholder-audit/,
    ['docs-tooling'],
  ],
];

function readSystemsOrder(report: Report): string[] {
  const abs = fromRepo(SYSTEMS_DOC);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    report.warn(`Could not read ${SYSTEMS_DOC}; falling back to empty system list.`);
    return [];
  }
  const slugs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^##\s+([a-z0-9][a-z0-9-]*)\s*$/.exec(line);
    if (m && m[1]) slugs.push(m[1]);
  }
  return slugs;
}

interface HandoffEntry {
  readonly file: string;
  readonly date: string;
  readonly slug: string;
  readonly systems: ReadonlyArray<string>;
  readonly summary: string;
}

export function extractSystemsField(text: string): string[] | null {
  // Look for `## Systems touched` header, then grab non-comment lines until the
  // next `##` header.
  const lines = text.split(/\r?\n/);
  let i = 0;
  let inlineValue = '';
  while (i < lines.length) {
    const match = /^##\s+Systems touched(?:\s*:\s*(.*))?\s*$/i.exec(lines[i]!);
    if (match) {
      inlineValue = match[1] ?? '';
      break;
    }
    i++;
  }
  if (i >= lines.length) return null;
  i++;
  const collected: string[] = [inlineValue];
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s+/.test(line)) break;
    collected.push(line);
  }
  const joined = collected
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (!joined) return null;
  const slugs = joined
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z0-9][a-z0-9-]*$/.test(s));
  return slugs.length > 0 ? slugs : null;
}

function classifyBySlug(slug: string): string[] {
  const hits = new Set<string>();
  for (const [re, systems] of HEURISTICS) {
    if (re.test(slug)) {
      for (const s of systems) hits.add(s);
    }
  }
  return [...hits];
}

export function extractSummary(text: string, fallback: string): string {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^##\s+What Was Done\s*$/i.test(l));
  if (idx >= 0) {
    const paragraphLines: string[] = [];
    for (let i = idx + 1; i < lines.length; i++) {
      const raw = lines[i]!.trim();
      if (!raw) {
        if (paragraphLines.length > 0) break;
        continue;
      }
      if (raw.startsWith('<!--')) continue;
      if (raw.startsWith('##')) break;
      if (paragraphLines.length === 0) {
        paragraphLines.push(raw.replace(/^[-*]\s+/, ''));
      } else if (/^[-*#]/.test(raw) || raw.startsWith('|')) {
        break;
      } else {
        paragraphLines.push(raw);
      }
    }
    if (paragraphLines.length > 0) {
      return truncate(paragraphLines.join(' '));
    }
  }
  const h1 = lines.find((l) => /^#\s+/.test(l));
  if (h1) {
    return truncate(h1.replace(/^#\s+/, '').replace(/^Session Handoff:\s*/i, ''));
  }
  return fallback;
}

function truncate(s: string, max = 140): string {
  const clean = s
    .replace(/\\([*_`])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function renderIndex(
  systemsOrder: ReadonlyArray<string>,
  entriesBySystem: Map<string, HandoffEntry[]>,
  unclassified: ReadonlyArray<HandoffEntry>,
  timestamp?: string,
): string {
  const now = timestamp ?? new Date().toISOString();
  const parts: string[] = [];
  parts.push('# Handoff system-impact index');
  parts.push('');
  parts.push('Generated by `scripts/agent/docs/build-system-index.ts`. Do not edit by hand.');
  parts.push(`Last built: ${now}.`);
  parts.push('');
  parts.push('Planners: before starting work in a system below, skim the handoffs listed. This');
  parts.push("replaces the vague 'check recent handoffs' instruction — read the ones relevant");
  parts.push('to your system, not all of them.');
  parts.push('');
  parts.push('The canonical system slugs are defined by the headings in `docs/systems/README.md`.');
  parts.push('Handoffs declare which systems they touch via the `## Systems touched` field in');
  parts.push('their front matter; legacy handoffs are classified heuristically by filename.');
  parts.push('');

  for (const system of systemsOrder) {
    const list = entriesBySystem.get(system) ?? [];
    parts.push(`## ${system}`);
    parts.push('');
    if (list.length === 0) {
      parts.push('_No unarchived handoffs currently indexed under this system._');
      parts.push('');
      continue;
    }
    const shown = list.slice(0, PER_SYSTEM_CAP);
    for (const e of shown) {
      parts.push(`- [${e.date}-${e.slug}](${e.date}-${e.slug}.md) — ${e.summary}`);
    }
    const remaining = list.length - shown.length;
    if (remaining > 0) {
      parts.push('');
      parts.push(
        `_…and ${remaining} older unarchived handoff(s) in this directory (see \`archive/\` for older archived entries)._`,
      );
    }
    parts.push('');
  }

  if (unclassified.length > 0) {
    parts.push('## _unclassified_');
    parts.push('');
    parts.push('These handoffs lack a `## Systems touched` field and did not match any');
    parts.push('heuristic. Add a `## Systems touched` line to fix.');
    parts.push('');
    for (const e of unclassified.slice(0, PER_SYSTEM_CAP)) {
      parts.push(`- [${e.date}-${e.slug}](${e.date}-${e.slug}.md) — ${e.summary}`);
    }
    if (unclassified.length > PER_SYSTEM_CAP) {
      parts.push('');
      parts.push(`_…and ${unclassified.length - PER_SYSTEM_CAP} more._`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

async function main(): Promise<void> {
  const report = new Report('docs-build-system-index');
  const apply = process.argv.includes('--apply') || process.env.AUTOMATION_APPLY === '1';
  const systemsOrder = readSystemsOrder(report);
  const validSystems = new Set(systemsOrder);

  const absHandoffs = fromRepo(HANDOFFS_DIR);
  let entries: string[];
  try {
    entries = readdirSync(absHandoffs);
  } catch {
    report.warn(`No handoffs directory at ${HANDOFFS_DIR}; nothing to do.`);
    report.finish();
  }

  const collected: HandoffEntry[] = [];
  const unclassified: HandoffEntry[] = [];

  for (const entry of entries!) {
    if (entry === 'TEMPLATE.md' || entry === 'archive' || entry === 'assets') continue;
    if (entry === 'INDEX.md') continue;
    const abs = path.join(absHandoffs, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const m = DATE_RE.exec(entry);
    if (!m) {
      report.warn(`Handoff missing YYYY-MM-DD- prefix; skipping index entry.`, {
        file: `${HANDOFFS_DIR}/${entry}`,
      });
      continue;
    }
    const [, date, slug] = m as unknown as [string, string, string];
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    const declared = extractSystemsField(text);
    let systems: string[];
    if (declared && declared.length > 0) {
      systems = declared.filter((s) => {
        if (!validSystems.has(s)) {
          report.warn(
            `Handoff declares unknown system slug '${s}'; not in docs/systems/README.md.`,
            { file: `${HANDOFFS_DIR}/${entry}` },
          );
          return false;
        }
        return true;
      });
    } else {
      systems = classifyBySlug(slug).filter((s) => validSystems.has(s));
    }

    const summary = extractSummary(text, slug);
    const record: HandoffEntry = { file: entry, date, slug, systems, summary };

    if (systems.length === 0) {
      report.warn(`Could not classify handoff into any system.`, {
        file: `${HANDOFFS_DIR}/${entry}`,
        remediation: 'Add `## Systems touched: <slug1>, <slug2>` to the handoff.',
      });
      unclassified.push(record);
    } else {
      collected.push(record);
    }
  }

  // Group + sort newest-first within each system.
  const bySystem = new Map<string, HandoffEntry[]>();
  for (const s of systemsOrder) bySystem.set(s, []);
  for (const rec of collected) {
    for (const s of rec.systems) {
      const bucket = bySystem.get(s);
      if (bucket) bucket.push(rec);
    }
  }
  for (const list of bySystem.values()) {
    list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }
  unclassified.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // Suppress timestamp-only diffs: if the existing INDEX.md has the same body
  // (everything except the "Last built:" line), reuse its timestamp so the file
  // is byte-identical and the workflow does not create a no-op PR.
  const indexAbs = fromRepo(INDEX_FILE);
  let existingTimestamp: string | undefined;
  if (existsSync(indexAbs)) {
    const existing = readFileSync(indexAbs, 'utf8');
    const tsMatch = existing.match(/^Last built: (.+)\./m);
    if (tsMatch) {
      existingTimestamp = tsMatch[1];
    }
  }
  // Render once with existing timestamp (or fresh) to compare bodies.
  const rendered = renderIndex(systemsOrder, bySystem, unclassified, existingTimestamp);
  // If body matches with existing timestamp, rendered === existing — no write needed.
  // If body differs, render with a fresh timestamp.
  let finalRendered: string;
  if (existingTimestamp !== undefined && existsSync(indexAbs)) {
    const existing = readFileSync(indexAbs, 'utf8');
    if (rendered === existing) {
      finalRendered = rendered; // no-op: identical to existing
    } else {
      finalRendered = renderIndex(systemsOrder, bySystem, unclassified);
    }
  } else {
    finalRendered = rendered;
  }

  const populated = [...bySystem.values()].filter((v) => v.length > 0).length;
  report.info(
    `Indexed ${collected.length} handoff(s) across ${populated}/${systemsOrder.length} system(s); ${unclassified.length} unclassified.`,
  );

  if (apply) {
    writeFileSync(indexAbs, finalRendered);
    report.info(`Wrote ${INDEX_FILE}.`);
  } else {
    process.stdout.write(finalRendered);
    process.stdout.write('\n');
    report.info(`Dry-run: pass --apply to write ${INDEX_FILE}.`);
  }

  report.finish();
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((err) => {
    process.stderr.write(`build-system-index crashed: ${err instanceof Error ? err.stack : err}\n`);
    process.exit(2);
  });
}
