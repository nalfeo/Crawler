import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  envWithWslPassthrough,
  resolveBashShell,
  ShellResolutionError,
  windowsPathToWslPath,
} from './shell-resolver.js';

const [, , script, ...args] = process.argv;

if (!script) {
  console.error('Usage: tsx scripts/agent/run-bash-wrapper.ts <script.sh> [args...]');
  process.exit(2);
}

try {
  const shell = resolveBashShell();
  const scriptPath = shell.kind === 'wsl' ? windowsPathToWslPath(path.resolve(script)) : script;
  const env = shell.kind === 'wsl' ? envWithWslPassthrough(process.env) : process.env;
  const result = spawnSync(shell.command, [scriptPath, ...args], {
    stdio: 'inherit',
    env,
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
