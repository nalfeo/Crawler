import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SERIALIZED_ACTIONS = new Set(['state', 'item-review', 'set-review', 'advance']);
const SET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function listAuthoredThemeSetIds(repoRoot) {
  let entries;
  try {
    entries = readdirSync(path.join(repoRoot, 'data', 'theme-equipment-sets'), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .filter((id) => SET_ID_PATTERN.test(id))
    .sort();
}

export function resolveThemeSetId(repoRoot, requestedSetId) {
  if (requestedSetId) return requestedSetId;
  const available = listAuthoredThemeSetIds(repoRoot);
  if (available.length === 1) return available[0];
  if (available.length === 0) {
    throw new Error(
      'No authored theme-equipment sets were found in data/theme-equipment-sets. Author a set plan, then reopen this canvas.',
    );
  }
  throw new Error(
    `Multiple theme-equipment sets are available (${available.join(', ')}). Reopen this canvas with an explicit setId.`,
  );
}

export function createSerializedThemeEquipmentReviewRunner(execute) {
  const tails = new Map();
  return (command) => {
    if (!SERIALIZED_ACTIONS.has(command.action)) return execute(command);
    const previous = tails.get(command.setId) ?? Promise.resolve();
    const current = previous.then(() => execute(command));
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    tails.set(command.setId, tail);
    void tail.finally(() => {
      if (tails.get(command.setId) === tail) tails.delete(command.setId);
    });
    return current;
  };
}

export async function runThemeEquipmentReviewCommand(command, repoRoot) {
  const script = path.join(repoRoot, 'scripts', 'sprites', 'theme-equipment-review-cli.ts');
  const encoded = Buffer.from(JSON.stringify(command), 'utf8').toString('base64url');
  const env = loadRepoEnv(repoRoot);
  try {
    const { stdout } = await execFileAsync('node', ['--import', 'tsx', script, encoded], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      maxBuffer: 24 * 1024 * 1024,
      windowsHide: true,
      timeout: 120_000,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const detail = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(detail || error?.message || String(error));
  }
}

export async function dispatchThemeEquipmentWorkflow(repoRoot, setId, action) {
  if (action !== 'init' && action !== 'run-phase' && action !== 'publish') {
    throw new Error(`Unsupported theme-equipment workflow action "${action}".`);
  }
  const args = [
    'workflow',
    'run',
    'theme-equipment.yml',
    '--field',
    `action=${action}`,
    '--field',
    `set_id=${setId}`,
  ];
  if (action === 'init') {
    args.push('--field', `plan_path=data/theme-equipment-sets/${setId}.json`);
  }
  try {
    await execFileAsync('gh', args, {
      cwd: repoRoot,
      env: loadRepoEnv(repoRoot),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    return { dispatched: true, action, setId };
  } catch (error) {
    const detail = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(detail || error?.message || String(error));
  }
}

export function loadRepoEnv(repoRoot, baseEnv = process.env) {
  const env = { ...baseEnv };
  const envPath = path.join(repoRoot, '.env.local');
  if (!existsSync(envPath)) return env;
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}
