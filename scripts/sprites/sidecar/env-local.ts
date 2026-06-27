/**
 * Shared `.env.local` loader for the sprite sidecar entrypoints.
 *
 * Merges `key=value` pairs from `<repoRoot>/.env.local` into an environment
 * map **without** overwriting variables already set by the shell or a parent
 * process. This lets the sidecar (`cli.ts`) and the gallery launcher
 * (`launcher.ts`) pick up the Azure credentials written by
 * `scripts/setup-azure-env.ps1` without the caller having to source the file
 * manually.
 *
 * Precedence: real shell/parent env wins over `.env.local`, so an explicit
 * `SPRITES_RUN_STORE=local` on the command line still beats the file.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function loadEnvLocal(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const envFile = path.join(repoRoot, '.env.local');
  if (!existsSync(envFile)) return;
  const lines = readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in env)) {
      env[key] = value;
    }
  }
}
