// shell-blunt-merge-strategy: block blunt, side-wholesale merge resolution.
//
// Real regressions this prevents:
//   * `git merge -X theirs` clobbered .github/agents/set-piece-designer.agent.md.
//   * Two main-merges silently discarded upstream content (the test-only-exports.ts
//     wrapper; Don Paco boss-ability rows) because a conflict was resolved by
//     taking one side wholesale instead of per-path.
//   * An orphan `assets/queue` merge used --allow-unrelated-histories and pulled
//     unrelated non-art files into the merge.
//
// What is denied, on `git merge` / `rebase` / `cherry-pick` / `pull` segments:
//   -X theirs | -X ours | -Xtheirs | -Xours
//   --strategy-option=theirs|ours | --strategy-option theirs|ours
//   -s ours | -sours | --strategy=ours | --strategy ours
//   --allow-unrelated-histories, unless the command also carries the explicit
//   acknowledgement env var CRAWLER_ALLOW_UNRELATED_HISTORIES=1 (so the
//   sanctioned scripted path stays possible while an ad-hoc agent invocation
//   is blocked).
//
// What is NOT denied:
//   * `git checkout --theirs <path>` / `--ours <path>` — path-scoped conflict
//     resolution on a named file is legitimate and reviewable.
//   * `-X ignore-space-change`, `-s recursive`, `-s ort`, `--strategy=ort` —
//     these do not discard the other side.
//   * A branch literally named `ours`/`theirs`, or those words inside a quoted
//     commit message: detection is token-based and quote-aware.

import { isGit, normalizeCommand, tokenize } from '../lib/shell.mjs';

const MERGE_SUBCOMMANDS = new Set(['merge', 'rebase', 'cherry-pick', 'pull']);
const SIDE_OPTIONS = new Set(['theirs', 'ours']);
const ACK_ENV = 'CRAWLER_ALLOW_UNRELATED_HISTORIES';
const ACK_RE = new RegExp(`(^|[\\s;&|(])${ACK_ENV}=1(\\s|$)`);

const REMEDIATION =
  'Resolve per path instead: `git reset --hard <base>` then a path-scoped ' +
  '`git checkout <ref> -- <paths>`, staging only the paths you intend to change. ' +
  'That keeps every discarded line visible in the diff.';

/**
 * Drop leading `VAR=value` env assignments (and a leading `env`) so a command
 * like `FOO=1 git merge -X theirs` is still recognized as git.
 */
function stripEnvPrefix(tokens) {
  let i = 0;
  while (i < tokens.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
      i++;
      continue;
    }
    if (tokens[i] === 'env') {
      i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/**
 * Return { name, index } of the git subcommand, skipping global options
 * (`-C <path>`, `-c k=v`, `--no-pager`, ...). index is the token index of the
 * subcommand itself.
 */
function findSubcommand(tokens) {
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    i += tokens[i] === '-C' || tokens[i] === '-c' ? 2 : 1;
  }
  return i < tokens.length ? { name: tokens[i], index: i } : null;
}

function segmentDeniesBluntMerge(seg, ackPresent) {
  const tokens = stripEnvPrefix(tokenize(seg));
  if (tokens.length === 0) return null;
  if (!isGit(tokens.join(' '))) return null;

  const sub = findSubcommand(tokens);
  if (!sub || !MERGE_SUBCOMMANDS.has(sub.name)) return null;

  const args = tokens.slice(sub.index + 1);
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    const next = args[i + 1];

    // -X theirs / -X ours / -Xtheirs / -Xours
    if (tok === '-X' && SIDE_OPTIONS.has(next)) {
      return `Refusing \`git ${sub.name}\` with \`-X ${next}\`: it resolves every conflict by taking one side wholesale and silently discards the other side's content. Segment: \`${seg}\`. ${REMEDIATION}`;
    }
    const attachedX = /^-X(theirs|ours)$/.exec(tok);
    if (attachedX) {
      return `Refusing \`git ${sub.name}\` with \`-X${attachedX[1]}\`: it resolves every conflict by taking one side wholesale and silently discards the other side's content. Segment: \`${seg}\`. ${REMEDIATION}`;
    }

    // --strategy-option=theirs / --strategy-option theirs
    const attachedOpt = /^--strategy-option=(theirs|ours)$/.exec(tok);
    if (attachedOpt) {
      return `Refusing \`git ${sub.name}\` with \`--strategy-option=${attachedOpt[1]}\`: it resolves every conflict by taking one side wholesale and silently discards the other side's content. Segment: \`${seg}\`. ${REMEDIATION}`;
    }
    if (tok === '--strategy-option' && SIDE_OPTIONS.has(next)) {
      return `Refusing \`git ${sub.name}\` with \`--strategy-option ${next}\`: it resolves every conflict by taking one side wholesale and silently discards the other side's content. Segment: \`${seg}\`. ${REMEDIATION}`;
    }

    // -s ours / -sours / --strategy=ours / --strategy ours
    if ((tok === '-s' || tok === '--strategy') && next === 'ours') {
      return `Refusing \`git ${sub.name}\` with the \`ours\` merge strategy (\`${tok} ours\`): it records a merge while discarding the other side's tree entirely. Segment: \`${seg}\`. ${REMEDIATION}`;
    }
    if (tok === '-sours' || tok === '--strategy=ours') {
      return `Refusing \`git ${sub.name}\` with the \`ours\` merge strategy (\`${tok}\`): it records a merge while discarding the other side's tree entirely. Segment: \`${seg}\`. ${REMEDIATION}`;
    }

    // --allow-unrelated-histories without explicit acknowledgement
    if (tok === '--allow-unrelated-histories' && !ackPresent) {
      return `Refusing \`git ${sub.name} --allow-unrelated-histories\`: merging unrelated histories ad hoc pulls every file from the other root into this tree (this is how non-art files leaked in from the orphan \`assets/queue\` branch). Segment: \`${seg}\`. If this is the sanctioned scripted path, re-run it with the explicit acknowledgement \`${ACK_ENV}=1\` set on the same command. Otherwise: ${REMEDIATION}`;
    }
  }
  return null;
}

export default {
  id: 'shell-blunt-merge-strategy',
  category: 'shell',
  failClosed: true,
  matches(toolName, toolArgs) {
    if (toolName !== 'powershell' && toolName !== 'bash') return false;
    const cmd = String(toolArgs?.command || '');
    if (!/\bgit\b/.test(cmd)) return false;
    if (!/\b(merge|rebase|cherry-pick|pull)\b/.test(cmd)) return false;
    return /(-X|--strategy|--allow-unrelated-histories|(^|\s)-s(ours)?(\s|$))/.test(cmd);
  },
  check(toolArgs) {
    const cmd = String(toolArgs?.command || '');
    const ackPresent = ACK_RE.test(cmd);
    for (const seg of normalizeCommand(cmd)) {
      const reason = segmentDeniesBluntMerge(seg, ackPresent);
      if (reason) return { decision: 'deny', reason };
    }
    return { decision: 'allow' };
  },
};
