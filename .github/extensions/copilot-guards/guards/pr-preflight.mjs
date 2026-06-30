// pr-preflight: aggregator that runs all PR checks in one place and
// returns a combined report. Replaces individual pr-* guards so the
// agent sees every issue in a single round trip.
//
// Checks performed:
//   1. Semantic PR title (must match conventional commit allowlist).
//   2. Handoff required: a docs/knowledge/handoffs/YYYY-MM-DD-*.md
//      file must exist *in the branch diff* (not just present in the
//      repo). Skipped for trivial / docs-only diffs.
//   3. Lab gate: run scripts/agent/lab-gate-check.sh ONLY when the
//      diff touches src/core/systems/** or src/labs/**. Cached.
//   4. Forbidden paths: secrets, session-state, .copilot/ etc.
//   5. Cross-system change: additionalContext warning (not a deny)
//      when diff spans 2+ of src/core, src/engine, src/game and no
//      ADR is added in this branch.
//
// All findings are reported back together by the dispatcher.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { branchFiles, branchAddedFiles } from '../lib/git.mjs';

// ci-policy.md: feat|fix|chore|lab|docs|refactor|test|perf|ci|build
const CONVENTIONAL_TITLE_RE =
  /^(feat|fix|chore|lab|docs|refactor|test|perf|ci|build)(\([^)]+\))?!?: .+/;

// Files we never want committed.
const FORBIDDEN_PATTERNS = [
  { re: /^\.env(\..+)?$/, why: 'environment file (likely secrets)' },
  { re: /\.pem$/, why: 'private key' },
  { re: /\.key$/, why: 'private key material' },
  { re: /(^|\/)id_rsa(\.|$)/, why: 'SSH private key' },
  { re: /(^|\/)\.copilot\//, why: 'Copilot session state (.copilot/)' },
  { re: /(^|\/)session-state\//, why: 'session state directory' },
  { re: /^generated\//, why: 'generated/ build output' },
  { re: /\.log$/, why: 'log file' },
  { re: /^node_modules\//, why: 'node_modules' },
];

const LAB_GATE_TRIGGER_RE = /^src[\\/](core[\\/]systems|labs)[\\/]/;

const CORE_LAYER_RE = /^src[\\/]core[\\/]/;
const ENGINE_LAYER_RE = /^src[\\/]engine[\\/]/;
const GAME_LAYER_RE = /^src[\\/]game[\\/]/;
const ADR_RE = /^docs[\\/]knowledge[\\/]adr[\\/]/;
const HANDOFF_DATED_RE =
  /^docs[\\/]knowledge[\\/]handoffs[\\/]\d{4}-\d{2}-\d{2}-[a-z0-9][\w-]*\.md$/;

// Files we treat as "trivial" for handoff-required purposes.
// Any .md/.txt file outside src/ is trivial - markdown/plaintext cannot change
// game logic, so docs-only sessions don't need a session handoff. src/**/*.md
// and src/**/*.txt are explicitly excluded (use negative lookahead) because
// code directories could hold design notes that accompany real code changes.
const TRIVIAL_PATH_RE =
  /^(docs[\\/]|README\.md$|CHANGELOG\.md$|\.github[\\/](workflows|dependabot)|package(-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$|(?!src[\\/]).+\.(md|txt)$)/;

function extractTitle(args) {
  if (!args) return '';
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return '';
    try {
      return extractTitle(JSON.parse(trimmed));
    } catch {
      return trimmed;
    }
  }
  if (typeof args !== 'object') return '';
  const obj = args;
  const candidates = [
    obj.title,
    obj.pr_title,
    obj.pull_request_title,
    obj?.input?.title,
    obj?.parameters?.title,
    obj?.arguments?.title,
    obj?.request?.title,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

function checkSemanticTitle(args) {
  const title = extractTitle(args);
  if (!title) {
    return 'PR title is empty. Use a conventional-commit-style title: `<type>(scope?): <subject>` where type is one of feat|fix|chore|lab|docs|refactor|test|perf|ci|build.';
  }
  if (!CONVENTIONAL_TITLE_RE.test(title)) {
    return `PR title '${title}' is not semantic. Use \`<type>(scope?)!?: <subject>\` where type is one of feat|fix|chore|lab|docs|refactor|test|perf|ci|build (e.g. \`feat(ecs): add lifecycle hook\`).`;
  }
  return null;
}

function checkHandoff(files, addedFiles) {
  const allTrivial = files.length > 0 && files.every((f) => TRIVIAL_PATH_RE.test(f));
  if (allTrivial) return null;
  const hasNewHandoff = addedFiles.some((f) => HANDOFF_DATED_RE.test(f));
  if (hasNewHandoff) return null;
  return `No new handoff file added in this branch. Per docs/agent-os/policies/memory-policy.md, every session that touches code/config writes a handoff. Create a new \`docs/knowledge/handoffs/YYYY-MM-DD-<slug>.md\` containing: summary, files touched, verification run, unresolved issues, recommended next steps. Editing an existing handoff does not count. Skipped automatically for docs-only / dependency-only diffs.`;
}

function checkForbiddenPaths(files) {
  const hits = [];
  for (const f of files) {
    const norm = f.replace(/\\/g, '/');
    for (const p of FORBIDDEN_PATTERNS) {
      if (p.re.test(norm)) {
        hits.push(`  • ${norm}  (${p.why})`);
        break;
      }
    }
  }
  if (hits.length === 0) return null;
  return `Diff contains forbidden paths:\n${hits.join('\n')}`;
}

function checkLabGate(files, cwd) {
  const shouldRun = files.some((f) => LAB_GATE_TRIGGER_RE.test(f));
  if (!shouldRun) return null;
  const scriptRel = 'scripts/agent/lab-gate-check.sh';
  const scriptAbs = join(cwd, 'scripts', 'agent', 'lab-gate-check.sh');
  if (!existsSync(scriptAbs)) return null;
  try {
    execFileSync('bash', [scriptRel], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return null;
  } catch (err) {
    const out = (err.stdout?.toString() || '') + (err.stderr?.toString() || '');
    return `Lab gate failed (scripts/agent/lab-gate-check.sh):\n${out.trim()}`;
  }
}

function checkCrossSystemAdr(files) {
  const layers = [
    CORE_LAYER_RE.test.bind(CORE_LAYER_RE),
    ENGINE_LAYER_RE.test.bind(ENGINE_LAYER_RE),
    GAME_LAYER_RE.test.bind(GAME_LAYER_RE),
  ];
  const hitCount = layers.filter((test) => files.some((f) => test(f))).length;
  if (hitCount < 2) return null;
  const hasAdr = files.some((f) => ADR_RE.test(f));
  if (hasAdr) return null;
  return `Diff touches ${hitCount} architectural layers (src/core, src/engine, src/game). Per memory policy, every change affecting 2+ systems requires an ADR under docs/knowledge/adr/. Create one documenting: context, decision, consequences (positive/negative/risks), and alternatives considered.`;
}

function evaluatePreflightChecks({ files, addedFiles, cwd, toolArgs, skipSemanticTitle = false }) {
  const denyParts = [];
  if (!skipSemanticTitle) {
    const titleIssue = checkSemanticTitle(toolArgs);
    if (titleIssue) denyParts.push(titleIssue);
  }

  const handoffIssue = checkHandoff(files, addedFiles);
  if (handoffIssue) denyParts.push(handoffIssue);

  const forbiddenIssue = checkForbiddenPaths(files);
  if (forbiddenIssue) denyParts.push(forbiddenIssue);

  const labIssue = checkLabGate(files, cwd);
  if (labIssue) denyParts.push(labIssue);

  const adrIssue = checkCrossSystemAdr(files);
  if (adrIssue) denyParts.push(adrIssue);

  if (denyParts.length > 0) {
    const reason = denyParts.join('\n\n--- next finding ---\n\n');
    return {
      decision: 'deny',
      reason,
    };
  }

  return {
    decision: 'allow',
  };
}

export default {
  id: 'pr-preflight',
  category: 'pr',
  failClosed: false, // git failures shouldn't block PR creation
  matches(toolName) {
    return toolName === 'create_pull_request';
  },
  async check(toolArgs, ctx) {
    const cwd = ctx?.cwd || process.cwd();

    // Debug: log the shape of toolArgs so we can diagnose title extraction issues
    if (!toolArgs?.title) {
      await ctx
        ?.log?.(
          `[pr-preflight] toolArgs shape: ${JSON.stringify(Object.keys(toolArgs || {}))}, type: ${typeof toolArgs}`,
          { level: 'info' },
        )
        .catch(() => {});
    }

    let files;
    let addedFiles;
    try {
      files = branchFiles(cwd);
      addedFiles = branchAddedFiles(cwd);
    } catch (err) {
      return {
        decision: 'allow',
        additionalContext: `pr-preflight: skipped git-based checks (${err.message}). Verify branch state manually.`,
      };
    }

    return evaluatePreflightChecks({
      files,
      addedFiles,
      cwd,
      toolArgs,
    });
  },
};

export {
  checkSemanticTitle,
  checkHandoff,
  checkForbiddenPaths,
  checkLabGate,
  checkCrossSystemAdr,
  evaluatePreflightChecks,
  CONVENTIONAL_TITLE_RE,
  HANDOFF_DATED_RE,
  TRIVIAL_PATH_RE,
};
