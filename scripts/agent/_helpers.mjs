import { spawn } from 'node:child_process';
import path from 'node:path';

export const isWindows = process.platform === 'win32';
export const npmExecutable = isWindows ? 'npm.cmd' : 'npm';
export const npxExecutable = isWindows ? 'npx.cmd' : 'npx';

export function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

export function parseCsvList(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function runCommand(
  command,
  args,
  { cwd = process.cwd(), capture = false, allowFailure = false } = {},
) {
  return new Promise((resolve, reject) => {
    const needsCmdWrapper = isWindows && /\.(cmd|bat)$/i.test(command);
    const wrappedArgs = needsCmdWrapper
      ? ['/d', '/s', '/c', [command, ...args].map(quoteForCmd).join(' ')]
      : args;
    const wrappedCommand = needsCmdWrapper ? 'cmd.exe' : command;

    const child = spawn(wrappedCommand, wrappedArgs, {
      cwd,
      env: process.env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    if (capture) {
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    function quoteForCmd(value) {
      if (!/[\s"&()^|<>]/.test(value)) {
        return value;
      }

      return `"${value.replace(/"/g, '\\"')}"`;
    }

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      const result = {
        code: code ?? 1,
        stdout,
        stderr,
      };

      if (!allowFailure && result.code !== 0) {
        const error = new Error(
          `Command failed: ${command} ${args.join(' ')} (exit ${result.code})`,
        );
        error.result = result;
        reject(error);
        return;
      }

      resolve(result);
    });
  });
}

export async function gitOutput(args, cwd = process.cwd()) {
  const result = await runCommand('git', args, {
    cwd,
    capture: true,
  });
  return result.stdout.trim();
}

export function repoRelative(rootDir, filePath) {
  return normalizePath(path.relative(rootDir, filePath));
}
