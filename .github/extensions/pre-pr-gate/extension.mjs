// Extension: pre-pr-gate
// Blocks PR creation until repo pre-PR checks pass

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinSession } from '@github/copilot-sdk/extension';

const execFileAsync = promisify(execFile);
const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(extensionDir, '..', '..', '..');
const prePrCheckScript = path.join(repoRoot, 'scripts', 'agent', 'pre-pr-check.mjs');

function isPrCreationAttempt(input) {
  if (input.toolName === 'create_pull_request') {
    return true;
  }

  if (input.toolName !== 'powershell') {
    return false;
  }

  const command = String(input.toolArgs?.command ?? '');
  return /\bgh\s+pr\s+create\b/i.test(command);
}

async function runPrePrCheck(workingDirectory) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [prePrCheckScript, '--json'], {
      cwd: workingDirectory,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    if (stdout.trim().startsWith('{')) {
      return JSON.parse(stdout);
    }
    throw error;
  }
}

function formatReason(result) {
  const lines = ['Pre-PR gate blocked PR creation.'];
  for (const error of result.errors ?? []) {
    lines.push(`- ${error}`);
  }
  if (result.latestHandoff) {
    lines.push(`- Latest handoff checked: ${result.latestHandoff}`);
  }
  if (result.requiredPersonas?.length) {
    lines.push(`- Required personas: ${result.requiredPersonas.join(', ')}`);
  }
  return lines.join('\n');
}

const session = await joinSession({
  hooks: {
    onSessionStart: async () => {
      await session.log('pre-pr-gate loaded', { ephemeral: true });
    },
    onPreToolUse: async (input) => {
      if (!isPrCreationAttempt(input)) {
        return;
      }

      try {
        const result = await runPrePrCheck(input.workingDirectory);
        if (result.ok) {
          return { permissionDecision: 'allow' };
        }

        const reason = formatReason(result);
        await session.log(reason, { level: 'warning' });
        return {
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        };
      } catch (error) {
        const reason = `Pre-PR gate failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
        await session.log(reason, { level: 'error' });
        return {
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        };
      }
    },
  },
});
