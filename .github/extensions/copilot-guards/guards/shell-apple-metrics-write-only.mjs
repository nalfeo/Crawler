// shell-apple-metrics-write-only: block shell-based writes to apple metric files
// unless done through the dedicated writer CLI.

import { normalizeCommand, tokenize } from '../lib/shell.mjs';

const APPLES_DIR_TOKEN = 'docs/knowledge/metrics/apples/';
const WRITER_ALLOW_RE =
  /\b(?:npm\s+run\s+docs:apple:write|npx\s+tsx\s+scripts\/agent\/docs\/write-apple-metrics\.ts|tsx\s+scripts\/agent\/docs\/write-apple-metrics\.ts)\b/i;
const WRITE_PROGRAMS = new Set([
  'cp',
  'mv',
  'tee',
  'touch',
  'install',
  'truncate',
  'echo',
  'printf',
  'jq',
  'sed',
  'perl',
  'python',
  'python3',
  'node',
  'awk',
  'dd',
]);

function programName(segment) {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return '';
  return tokens[0]
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.exe$/, '');
}

export function isManualAppleWriteSegment(segment) {
  if (!segment.includes(APPLES_DIR_TOKEN)) return false;
  if (WRITER_ALLOW_RE.test(segment)) return false;
  // Match `>` / `>>` shell redirection as write intent, but ignore `>>>`-style
  // token runs by requiring the redirect to be at segment start or preceded by
  // a non-`>` character.
  if (/(^|[^>])>>?/.test(segment)) return true;
  return WRITE_PROGRAMS.has(programName(segment));
}

export default {
  id: 'shell-apple-metrics-write-only',
  category: 'shell',
  failClosed: false,
  matches(toolName, toolArgs) {
    if (toolName !== 'powershell' && toolName !== 'bash') return false;
    const cmd = String(toolArgs?.command || '');
    return cmd.includes(APPLES_DIR_TOKEN);
  },
  check(toolArgs) {
    const cmd = String(toolArgs?.command || '');
    for (const seg of normalizeCommand(cmd)) {
      if (!isManualAppleWriteSegment(seg)) continue;
      return {
        decision: 'deny',
        reason:
          `Refusing shell write to apple metrics via segment \`${seg}\`. ` +
          'Use `npm run docs:apple:write -- --date YYYY-MM-DD --session <slug> --estimated <1-5> --actual <0-10>`.',
      };
    }
    return { decision: 'allow' };
  },
};

export { APPLES_DIR_TOKEN, WRITER_ALLOW_RE, WRITE_PROGRAMS };
