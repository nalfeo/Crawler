import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSessionServerPorts, normalizeWorkspaceKey } from '../../shared/session-server-ports.js';
import { ensureAzureEnvLocal } from './env-bootstrap.js';
import { loadEnvLocal } from './env-local.js';
import {
  SIDECAR_SHUTDOWN_HEADER,
  SPRITE_SIDECAR_SERVICE_VERSION,
  type SidecarServiceIdentity,
} from './service-contract.js';

const REGISTRY_SCHEMA = 1;
const START_TIMEOUT_MS = 60_000;
/** Grace period (ms) beyond START_TIMEOUT_MS before a joiner reclaims a stale registry.
 *  Gives the claimant time to win its own timeout cleanup before joiners evict it. */
const JOINER_GRACE_MS = 5_000;
/** Grace period (ms) before reclaiming an invalid/non-parseable registry snapshot. */
const INVALID_REGISTRY_GRACE_MS = 3_000;
const PROBE_TIMEOUT_MS = 1_500;
const POLL_INTERVAL_MS = 300;
/** Maximum sidecar log size before the file is rotated (renamed to `.old`). */
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

interface SidecarHealth {
  readonly status?: string;
  readonly repoRoot?: string;
  readonly version?: string;
  readonly queueBackend?: string;
  readonly worker?: { readonly running?: boolean };
  readonly issueIngester?: { readonly running?: boolean };
  readonly service?: SidecarServiceIdentity;
}

interface ServiceRegistry {
  readonly schema: typeof REGISTRY_SCHEMA;
  readonly repoRoot: string;
  readonly port: number;
  readonly version: string;
  readonly instanceId: string;
  readonly shutdownToken: string;
  readonly startedAt: string;
  readonly logPath: string;
  readonly pid: number | null;
  /** Git HEAD commit hash of the checkout that started this service. */
  readonly codeProvenance?: string;
}

export interface SidecarServiceResult {
  readonly state: 'started' | 'reused';
  readonly baseUrl: string;
  readonly logPath: string | null;
  readonly pid: number | null;
  readonly version: string;
}

interface SpawnedService {
  readonly pid: number;
}

export interface SidecarServiceManagerDeps {
  readonly registryRoot?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly bootstrap?: (repoRoot: string) => void;
  readonly probeHealth?: (baseUrl: string) => Promise<SidecarHealth | null>;
  readonly spawnService?: (
    repoRoot: string,
    registry: ServiceRegistry,
    env: NodeJS.ProcessEnv,
    registryPath: string,
  ) => SpawnedService;
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Terminate a specific process by PID (cross-platform). Only ever called for
   *  a PID that this invocation itself spawned; never for arbitrary registry PIDs. */
  readonly terminateProcess?: (pid: number) => void;
  /** Compute a deterministic code identity string for the given repo root.
   *  Committed code changes should produce a different value; dirty dev changes
   *  need not. Defaults to the git HEAD commit hash. */
  readonly computeProvenance?: (repoRoot: string) => string;
}

function canonicalRepoRoot(repoRoot: string): string {
  return realpathSync.native(path.resolve(repoRoot));
}

function repoRootsMatch(left: string, right: string): boolean {
  return normalizeWorkspaceKey(left) === normalizeWorkspaceKey(right);
}

function defaultRegistryRoot(): string {
  return path.join(os.tmpdir(), 'crawler-sprite-sidecars');
}

export function registryPathFor(repoRoot: string, root = defaultRegistryRoot()): string {
  const key = createHash('sha256')
    .update(normalizeWorkspaceKey(repoRoot))
    .digest('hex')
    .slice(0, 24);
  return path.join(root, `${key}.json`);
}

function readRegistry(filePath: string): ServiceRegistry | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ServiceRegistry>;
    if (
      parsed.schema !== REGISTRY_SCHEMA ||
      typeof parsed.repoRoot !== 'string' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.version !== 'string' ||
      typeof parsed.instanceId !== 'string' ||
      typeof parsed.shutdownToken !== 'string' ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.logPath !== 'string' ||
      (parsed.pid !== null && typeof parsed.pid !== 'number')
    ) {
      return null;
    }
    return parsed as ServiceRegistry;
  } catch {
    return null;
  }
}

function writeRegistry(filePath: string, registry: ServiceRegistry): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function claimRegistry(filePath: string, registry: ServiceRegistry): boolean {
  mkdirSync(path.dirname(filePath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(filePath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
  return true;
}

function registryAgeMs(filePath: string, nowMs: number): number | null {
  try {
    return Math.max(0, nowMs - statSync(filePath).mtimeMs);
  } catch {
    return null;
  }
}

function reclaimInvalidRegistry(filePath: string): boolean {
  const recoveryPath = `${filePath}.recovering.${process.pid}.${randomUUID()}`;
  try {
    renameSync(filePath, recoveryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw error;
  }
  rmSync(recoveryPath, { force: true });
  return true;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely terminate a specific process by PID, cross-platform. Used ONLY for
 * a child this invocation itself spawned; never for arbitrary registry PIDs.
 */
function defaultTerminateProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process may have already exited; ignore.
  }
}

/**
 * Compute a deterministic code identity from the checkout. Uses the git HEAD
 * commit hash so that committed branch or code changes trigger a managed
 * restart while dirty dev changes in the working tree do not.
 */
export function computeCodeProvenance(repoRoot: string): string {
  try {
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 3_000,
    }).trim();
    return hash || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function defaultProbeHealth(baseUrl: string): Promise<SidecarHealth | null> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as SidecarHealth;
  } catch {
    return null;
  }
}

function isReady(health: SidecarHealth, repoRoot: string): boolean {
  if (
    health.status !== 'ok' ||
    typeof health.repoRoot !== 'string' ||
    !repoRootsMatch(health.repoRoot, repoRoot) ||
    health.version !== SPRITE_SIDECAR_SERVICE_VERSION
  ) {
    return false;
  }
  if (health.queueBackend === 'azure-queue') {
    return health.worker?.running === true && health.issueIngester?.running === true;
  }
  return true;
}

/**
 * Rotate the sidecar log file when it exceeds LOG_MAX_BYTES. The current log
 * is renamed to `<logPath>.old` so the next append opens a fresh file. Only
 * ever called for the managed sidecar's own log, not arbitrary paths.
 */
export function rotateLogIfNeeded(logPath: string): void {
  try {
    if (statSync(logPath).size > LOG_MAX_BYTES) {
      renameSync(logPath, `${logPath}.old`);
    }
  } catch {
    // File doesn't exist yet or stat failed; no rotation needed.
  }
}

function defaultBootstrap(repoRoot: string): void {
  loadEnvLocal(repoRoot);
  ensureAzureEnvLocal({ repoRoot });
  loadEnvLocal(repoRoot);
}

function defaultSpawnService(
  repoRoot: string,
  registry: ServiceRegistry,
  env: NodeJS.ProcessEnv,
  registryPath: string,
): SpawnedService {
  const sidecarCli = path.join(repoRoot, 'scripts', 'sprites', 'sidecar', 'cli.ts');
  rotateLogIfNeeded(registry.logPath);
  const logFd = openSync(registry.logPath, 'a', 0o600);
  let child: ChildProcess;
  try {
    // Use --import tsx so Node.js loads the TypeScript file directly in the
    // spawned process (no tsx wrapper subprocess). This ensures child.pid is
    // the actual service process PID, not a transient tsx CLI shim.
    child = spawn(process.execPath, ['--import', 'tsx', sidecarCli], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: {
        ...env,
        CRAWLER_SIDECAR_MANAGED: '1',
        CRAWLER_SIDECAR_INSTANCE_ID: registry.instanceId,
        CRAWLER_SIDECAR_SHUTDOWN_TOKEN: registry.shutdownToken,
        CRAWLER_SIDECAR_REGISTRY_PATH: registryPath,
        CRAWLER_SIDECAR_STARTED_AT: registry.startedAt,
        ...(registry.codeProvenance
          ? { CRAWLER_SIDECAR_CODE_PROVENANCE: registry.codeProvenance }
          : {}),
      },
    });
  } finally {
    closeSync(logFd);
  }
  if (child.pid === undefined) {
    throw new Error('Managed sprite sidecar did not report a child PID.');
  }
  child.unref();
  return { pid: child.pid };
}

async function requestManagedShutdown(
  baseUrl: string,
  registry: ServiceRegistry,
  probeHealth: (baseUrl: string) => Promise<SidecarHealth | null>,
): Promise<boolean> {
  const health = await probeHealth(baseUrl);
  if (
    health?.service?.managed !== true ||
    health.service.instanceId !== registry.instanceId ||
    health.service.pid !== registry.pid
  ) {
    return false;
  }
  try {
    const response = await fetch(`${baseUrl}/api/service/shutdown`, {
      method: 'POST',
      headers: { [SIDECAR_SHUTDOWN_HEADER]: registry.shutdownToken },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureSidecarService(
  repoRootInput: string,
  deps: SidecarServiceManagerDeps = {},
): Promise<SidecarServiceResult> {
  const repoRoot = canonicalRepoRoot(repoRootInput);
  loadEnvLocal(repoRoot);
  const registryRoot = deps.registryRoot ?? defaultRegistryRoot();
  const registryPath = registryPathFor(repoRoot, registryRoot);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const bootstrap = deps.bootstrap ?? defaultBootstrap;
  const probeHealth = deps.probeHealth ?? defaultProbeHealth;
  const spawnService = deps.spawnService ?? defaultSpawnService;
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const terminateProcess = deps.terminateProcess ?? defaultTerminateProcess;
  const computeProvenance = deps.computeProvenance ?? computeCodeProvenance;
  const deadline = now() + START_TIMEOUT_MS;

  // Compute current provenance once upfront; deferred bootstrap runs only when
  // this invocation actually proceeds to spawn (healthy reuse never needs Azure).
  const currentProvenance = computeProvenance(repoRoot);

  while (now() < deadline) {
    const existingRegistry = readRegistry(registryPath);
    const desiredPorts = getSessionServerPorts({ cwd: repoRoot, env: process.env });
    const probePort = existingRegistry?.port ?? desiredPorts.sidecarPort;
    const baseUrl = `http://127.0.0.1:${probePort}`;
    const health = await probeHealth(baseUrl);
    if (health) {
      if (typeof health.repoRoot === 'string' && !repoRootsMatch(health.repoRoot, repoRoot)) {
        throw new Error(
          `Sprite sidecar port ${probePort} belongs to another checkout (${health.repoRoot}).`,
        );
      }
      if (
        currentProvenance !== 'unknown' &&
        health.service?.codeProvenance != null &&
        health.service.codeProvenance !== currentProvenance
      ) {
        const registry = readRegistry(registryPath);
        if (registry && (await requestManagedShutdown(baseUrl, registry, probeHealth))) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        throw new Error(
          `Sprite sidecar at ${baseUrl} was started from a different code revision ` +
            `(running: ${health.service.codeProvenance}, current: ${currentProvenance}). ` +
            `Stop it and retry.`,
        );
      }
      if (isReady(health, repoRoot)) {
        const registry = readRegistry(registryPath);
        return {
          state: 'reused',
          baseUrl,
          logPath: registry?.logPath ?? null,
          pid: health.service?.pid ?? registry?.pid ?? null,
          version: SPRITE_SIDECAR_SERVICE_VERSION,
        };
      }
      if (health.version && health.version !== SPRITE_SIDECAR_SERVICE_VERSION) {
        const registry = readRegistry(registryPath);
        if (!registry || !(await requestManagedShutdown(baseUrl, registry, probeHealth))) {
          throw new Error(
            `An unmanaged stale sprite sidecar (${health.version}) is running at ${baseUrl}; stop it before retrying.`,
          );
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      // Health is present, same repo, same version (or no version yet), but not
      // ready. Wait for the existing service to finish starting rather than trying
      // to claim the port and spawning a duplicate unmanaged service.
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const startedAt = new Date(now()).toISOString();
    const instanceId = randomUUID();
    const logPath = path.join(registryRoot, `${path.basename(registryPath, '.json')}.log`);
    if (desiredPorts.sidecarPort === 0) {
      throw new Error(
        'SPRITES_SIDECAR_PORT=0 (bind-any-port) is not supported for the managed sidecar ' +
          'service; set a specific port number or omit the variable to use the default.',
      );
    }
    const candidate: ServiceRegistry = {
      schema: REGISTRY_SCHEMA,
      repoRoot,
      port: desiredPorts.sidecarPort,
      version: SPRITE_SIDECAR_SERVICE_VERSION,
      instanceId,
      shutdownToken: randomUUID(),
      startedAt,
      logPath,
      pid: null,
      codeProvenance: currentProvenance,
    };

    if (claimRegistry(registryPath, candidate)) {
      try {
        // Bootstrap (Azure credential setup) only when this caller is about to spawn.
        // A healthy reuse in the probe above never reaches here, so bootstrap is
        // skipped entirely in that case — the caller never needs Azure credentials.
        // Placed inside try/catch so a bootstrap failure releases the claimed registry.
        bootstrap(repoRoot);
        if (now() >= deadline) {
          throw new Error(`Sprite sidecar did not become ready within 60 seconds. See ${logPath}`);
        }
        const ownedRegistry = readRegistry(registryPath);
        if (!ownedRegistry || ownedRegistry.instanceId !== instanceId) {
          throw new Error('Sprite sidecar startup ownership was replaced before spawn.');
        }
        const spawned = spawnService(repoRoot, candidate, process.env, registryPath);
        const claimed = { ...candidate, pid: spawned.pid };
        const claimedBaseUrl = `http://127.0.0.1:${claimed.port}`;
        writeRegistry(registryPath, claimed);
        while (now() < deadline) {
          const startedHealth = await probeHealth(claimedBaseUrl);
          if (
            startedHealth &&
            isReady(startedHealth, repoRoot) &&
            startedHealth.service?.managed === true &&
            startedHealth.service.instanceId === claimed.instanceId
          ) {
            const servicePid = startedHealth.service?.pid ?? spawned.pid;
            writeRegistry(registryPath, { ...claimed, pid: servicePid });
            return {
              state: 'started',
              baseUrl,
              logPath,
              pid: servicePid,
              version: SPRITE_SIDECAR_SERVICE_VERSION,
            };
          }
          if (!isProcessAlive(spawned.pid)) {
            releaseSidecarRegistry(registryPath, instanceId);
            throw new Error(`Sprite sidecar exited during startup. See ${logPath}`);
          }
          await sleep(POLL_INTERVAL_MS);
        }
        // Startup timeout — attempt authenticated managed shutdown first; fall back
        // to terminating the exact child we spawned (never an arbitrary registry PID).
        const shutdownSent = await requestManagedShutdown(claimedBaseUrl, claimed, probeHealth);
        if (shutdownSent) {
          let stopped = false;
          for (let i = 0; i < 20; i++) {
            // Require both health gone AND pid exited: health null only proves
            // Fastify stopped, not that the detached process fully drained.
            if (!(await probeHealth(baseUrl)) && !isProcessAlive(spawned.pid)) {
              stopped = true;
              break;
            }
            await sleep(100);
          }
          if (!stopped) {
            terminateProcess(spawned.pid);
          }
        } else {
          terminateProcess(spawned.pid);
        }
        throw new Error(`Sprite sidecar did not become ready within 60 seconds. See ${logPath}`);
      } catch (error) {
        releaseSidecarRegistry(registryPath, instanceId);
        throw error;
      }
    }

    const existing = readRegistry(registryPath);
    if (!existing) {
      // Registry may be mid-write by the current owner (or briefly absent after
      // owner cleanup). Wait a bounded grace period before reclaiming invalid data.
      const ageMs = registryAgeMs(registryPath, now());
      if (ageMs !== null && ageMs >= INVALID_REGISTRY_GRACE_MS) {
        reclaimInvalidRegistry(registryPath);
        continue;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (existing.pid !== null && !isProcessAlive(existing.pid)) {
      releaseSidecarRegistry(registryPath, existing.instanceId);
      continue;
    }
    // Recycled-PID fix: if the registry's startup window (plus joiner grace) has
    // expired but health is still not ready, the owning process either crashed
    // without cleanup or the OS recycled its PID to an unrelated process. The
    // JOINER_GRACE_MS cushion lets the claimant win its own timeout cleanup before
    // a joiner evicts the registry. Clear the stale entry so a new spawn can proceed.
    if (now() - Date.parse(existing.startedAt) > START_TIMEOUT_MS + JOINER_GRACE_MS) {
      releaseSidecarRegistry(registryPath, existing.instanceId);
      continue;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const registry = readRegistry(registryPath);
  throw new Error(
    `Sprite sidecar did not become ready within 60 seconds.${registry ? ` See ${registry.logPath}` : ''}`,
  );
}

export async function stopSidecarService(
  repoRootInput: string,
  deps: Pick<
    SidecarServiceManagerDeps,
    'registryRoot' | 'probeHealth' | 'sleep' | 'isProcessAlive'
  > = {},
): Promise<boolean> {
  const repoRoot = canonicalRepoRoot(repoRootInput);
  const registryPath = registryPathFor(repoRoot, deps.registryRoot ?? defaultRegistryRoot());
  const registry = readRegistry(registryPath);
  if (!registry) return false;
  const baseUrl = `http://127.0.0.1:${registry.port}`;
  const probeHealth = deps.probeHealth ?? defaultProbeHealth;
  const requested = await requestManagedShutdown(baseUrl, registry, probeHealth);
  if (!requested) return false;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await probeHealth(baseUrl))) {
      // Health null proves Fastify stopped, but the detached process may still be
      // draining in-flight work. Only release the registry once the PID has also
      // exited so a concurrent ensure cannot spawn a duplicate worker/ingester.
      if (registry.pid === null || !isProcessAlive(registry.pid)) {
        releaseSidecarRegistry(registryPath, registry.instanceId);
        return true;
      }
    }
    await sleep(100);
  }
  return false;
}

export function releaseSidecarRegistry(filePath: string, instanceId: string): void {
  // Atomic rename prevents a successor that re-claimed the path after our token
  // check from having its registry removed by our subsequent rmSync. Once we've
  // renamed the file we own the moved copy exclusively; any new owner writes a
  // fresh file at the original path and is unaffected.
  const recoveryPath = `${filePath}.releasing.${process.pid}.${randomUUID()}`;
  try {
    renameSync(filePath, recoveryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return; // Already released by a concurrent caller.
    throw error;
  }
  const moved = readRegistry(recoveryPath);
  if (moved?.instanceId === instanceId) {
    // Our registry — delete the moved copy to complete the release.
    rmSync(recoveryPath, { force: true });
  } else {
    // We grabbed someone else's registry. Restore it so the current owner
    // can still be discovered. If another process created a new registry at
    // the original path in the brief window, prefer their version.
    try {
      renameSync(recoveryPath, filePath);
    } catch {
      // Restoring failed (e.g. a new file was created at filePath); clean up
      // the orphan copy to avoid stale junk files.
      rmSync(recoveryPath, { force: true });
    }
  }
}

export function sidecarRegistryExists(
  repoRootInput: string,
  registryRoot = defaultRegistryRoot(),
): boolean {
  return existsSync(registryPathFor(canonicalRepoRoot(repoRootInput), registryRoot));
}
