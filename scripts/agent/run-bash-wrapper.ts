import { spawnSync } from 'node:child_process';
import { resolveBashShell, ShellResolutionError } from './shell-resolver.js';

const [, , script, ...args] = process.argv;

if (!script) {
  console.error('Usage: tsx scripts/agent/run-bash-wrapper.ts <script.sh> [args...]');
  process.exit(2);
}

try {
  const shell = resolveBashShell();
  const result = spawnSync(shell.command, [script, ...args], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
} catch (error) {
  if (error instanceof ShellResolutionError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
