import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureSidecarService,
  sidecarRegistryExists,
  registryPathFor,
  type SidecarServiceManagerDeps,
} from '../../../scripts/sprites/sidecar/service-manager.js';
import { SPRITE_SIDECAR_SERVICE_VERSION } from '../../../scripts/sprites/sidecar/service-contract.js';

describe('sprite sidecar service manager', () => {
  const roots: string[] = [];

  function makeRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('converges concurrent callers on one spawned service', async () => {
    const repoRoot = makeRoot('crawler-sidecar-repo-');
    const registryRoot = makeRoot('crawler-sidecar-registry-');
    let health: Record<string, unknown> | null = null;
    const spawnService = vi.fn(() => {
      health = {
        status: 'ok',
        repoRoot,
        version: SPRITE_SIDECAR_SERVICE_VERSION,
        queueBackend: 'azure-queue',
        worker: { running: true },
        issueIngester: { running: true },
      };
      return { pid: 4321 };
    });
    const deps: SidecarServiceManagerDeps = {
      registryRoot,
      bootstrap: vi.fn(),
      probeHealth: async () => health,
      spawnService,
      isProcessAlive: () => true,
      sleep: async () => Promise.resolve(),
    };

    const [first, second] = await Promise.all([
      ensureSidecarService(repoRoot, deps),
      ensureSidecarService(repoRoot, deps),
    ]);

    expect(spawnService).toHaveBeenCalledTimes(1);
    expect(new Set([first.state, second.state])).toEqual(new Set(['started', 'reused']));
    expect(first.pid).toBe(4321);
    expect(second.pid).toBe(4321);
  });

  it('waits for existing service to be ready rather than spawning a duplicate when health present but controllers not ready', async () => {
    const repoRoot = makeRoot('crawler-sidecar-ready-');
    const registryRoot = makeRoot('crawler-sidecar-ready-registry-');
    let controllersRunning = false;
    let sleepCount = 0;
    const spawnService = vi.fn(() => ({ pid: 99 }));

    const result = await ensureSidecarService(repoRoot, {
      registryRoot,
      bootstrap: vi.fn(),
      probeHealth: async () => ({
        status: 'ok',
        repoRoot,
        version: SPRITE_SIDECAR_SERVICE_VERSION,
        queueBackend: 'azure-queue',
        worker: { running: controllersRunning },
        issueIngester: { running: controllersRunning },
      }),
      spawnService,
      isProcessAlive: () => true,
      sleep: async () => {
        sleepCount++;
        if (sleepCount >= 2) controllersRunning = true;
      },
    });

    // No spawn: the existing service (same repo/version) must be awaited, not duplicated.
    expect(spawnService).not.toHaveBeenCalled();
    expect(result.state).toBe('reused');
  });

  it('refuses a healthy service owned by another checkout', async () => {
    const repoRoot = makeRoot('crawler-sidecar-wrong-repo-');
    await expect(
      ensureSidecarService(repoRoot, {
        registryRoot: makeRoot('crawler-sidecar-wrong-registry-'),
        bootstrap: vi.fn(),
        probeHealth: async () => ({
          status: 'ok',
          repoRoot: `${repoRoot}-other`,
          version: SPRITE_SIDECAR_SERVICE_VERSION,
        }),
      }),
    ).rejects.toThrow(/belongs to another checkout/);
  });

  it('removes its registry when the child exits during startup', async () => {
    const repoRoot = makeRoot('crawler-sidecar-dead-child-');
    const registryRoot = makeRoot('crawler-sidecar-dead-registry-');
    await expect(
      ensureSidecarService(repoRoot, {
        registryRoot,
        bootstrap: vi.fn(),
        probeHealth: async () => null,
        spawnService: () => ({ pid: 123 }),
        isProcessAlive: () => false,
      }),
    ).rejects.toThrow(/exited during startup/);
    expect(sidecarRegistryExists(repoRoot, registryRoot)).toBe(false);
  });

  it('records the service pid and custom registry path after a launcher handoff', async () => {
    const repoRoot = makeRoot('crawler-sidecar-handoff-');
    const registryRoot = makeRoot('crawler-sidecar-handoff-registry-');
    let health: Record<string, unknown> | null = null;
    let childRegistryPath: string | undefined;

    const result = await ensureSidecarService(repoRoot, {
      registryRoot,
      bootstrap: vi.fn(),
      probeHealth: async () => health,
      spawnService: (_root, registry, _env, registryPath) => {
        childRegistryPath = registryPath;
        health = {
          status: 'ok',
          repoRoot,
          version: SPRITE_SIDECAR_SERVICE_VERSION,
          queueBackend: 'azure-queue',
          worker: { running: true },
          issueIngester: { running: true },
          service: {
            managed: true,
            instanceId: registry.instanceId,
            pid: 9876,
            startedAt: registry.startedAt,
          },
        };
        return { pid: 4321 };
      },
      isProcessAlive: () => true,
      sleep: async () => Promise.resolve(),
    });

    expect(result.pid).toBe(9876);
    expect(path.dirname(childRegistryPath ?? '')).toBe(registryRoot);
  });

  it('skips bootstrap when reusing a healthy service', async () => {
    const repoRoot = makeRoot('crawler-sidecar-reuse-');
    const registryRoot = makeRoot('crawler-sidecar-reuse-registry-');
    const bootstrapFn = vi.fn();
    const result = await ensureSidecarService(repoRoot, {
      registryRoot,
      bootstrap: bootstrapFn,
      probeHealth: async () => ({
        status: 'ok',
        repoRoot,
        version: SPRITE_SIDECAR_SERVICE_VERSION,
        queueBackend: 'azure-queue',
        worker: { running: true },
        issueIngester: { running: true },
      }),
      spawnService: vi.fn(() => ({ pid: 999 })),
      isProcessAlive: () => true,
      sleep: async () => Promise.resolve(),
    });
    expect(result.state).toBe('reused');
    expect(bootstrapFn).not.toHaveBeenCalled();
  });

  it('skips bootstrap even when bootstrap would throw, if reusing a healthy service', async () => {
    const repoRoot = makeRoot('crawler-sidecar-reuse-throw-');
    const registryRoot = makeRoot('crawler-sidecar-reuse-throw-registry-');
    const result = await ensureSidecarService(repoRoot, {
      registryRoot,
      bootstrap: () => {
        throw new Error('Azure bootstrap failure');
      },
      probeHealth: async () => ({
        status: 'ok',
        repoRoot,
        version: SPRITE_SIDECAR_SERVICE_VERSION,
        queueBackend: 'azure-queue',
        worker: { running: true },
        issueIngester: { running: true },
      }),
      spawnService: vi.fn(() => ({ pid: 999 })),
      isProcessAlive: () => true,
      sleep: async () => Promise.resolve(),
    });
    expect(result.state).toBe('reused');
  });

  it('releases claimed registry when bootstrap throws', async () => {
    const repoRoot = makeRoot('crawler-sidecar-bootstrap-throw-spawn-');
    const registryRoot = makeRoot('crawler-sidecar-bootstrap-throw-spawn-registry-');
    // health=null so the manager proceeds to claim then bootstrap
    await expect(
      ensureSidecarService(repoRoot, {
        registryRoot,
        probeHealth: async () => null,
        bootstrap: () => {
          throw new Error('Azure bootstrap failure');
        },
        spawnService: vi.fn(() => ({ pid: 42 })),
        isProcessAlive: () => true,
        sleep: async () => Promise.resolve(),
      }),
    ).rejects.toThrow('Azure bootstrap failure');
    expect(sidecarRegistryExists(repoRoot, registryRoot)).toBe(false);
  });

  it('terminates spawned child and clears registry on startup timeout', async () => {
    const repoRoot = makeRoot('crawler-sidecar-timeout-');
    const registryRoot = makeRoot('crawler-sidecar-timeout-registry-');
    const terminateFn = vi.fn();
    let callCount = 0;
    const baseTime = 1_000_000;
    // Fake clock: first 3 calls are under deadline; thereafter past it.
    const nowFn = vi.fn(() => (callCount++ < 3 ? baseTime : baseTime + 70_000));

    await expect(
      ensureSidecarService(repoRoot, {
        registryRoot,
        bootstrap: vi.fn(),
        now: nowFn,
        probeHealth: async () => null,
        spawnService: vi.fn(() => ({ pid: 55555 })),
        isProcessAlive: () => true,
        terminateProcess: terminateFn,
        sleep: async () => Promise.resolve(),
      }),
    ).rejects.toThrow(/did not become ready/);

    expect(terminateFn).toHaveBeenCalledWith(55555);
    expect(sidecarRegistryExists(repoRoot, registryRoot)).toBe(false);
  });

  it('clears stale joiner registry when startup window has expired regardless of PID liveness', async () => {
    const repoRoot = makeRoot('crawler-sidecar-stale-joiner-');
    const registryRoot = makeRoot('crawler-sidecar-stale-joiner-registry-');
    let health: Record<string, unknown> | null = null;

    // Deterministic clock: baseTime is the current "now" for the entire test.
    // The stale registry entry is set to start just past START_TIMEOUT_MS + JOINER_GRACE_MS
    // (60_000 + 5_000 + 1 = 65_001 ms ago) so the joiner-grace threshold is exceeded.
    const baseTime = 1_000_000;
    const staleAge = 60_000 + 5_000 + 1; // just over reclaim threshold (START_TIMEOUT_MS + JOINER_GRACE_MS)

    // Pre-write a stale registry entry whose startedAt is past the reclaim threshold
    // and whose PID is "alive" (recycled by a different process the OS has since reused).
    const regPath = registryPathFor(repoRoot, registryRoot);
    mkdirSync(registryRoot, { recursive: true });
    writeFileSync(
      regPath,
      JSON.stringify({
        schema: 1,
        repoRoot,
        port: 12345,
        version: SPRITE_SIDECAR_SERVICE_VERSION,
        instanceId: 'stale-id',
        shutdownToken: 'stale-token',
        startedAt: new Date(baseTime - staleAge).toISOString(),
        logPath: path.join(registryRoot, 'stale.log'),
        pid: 77777,
      }),
    );

    let spawnCallCount = 0;
    const spawnFn: SidecarServiceManagerDeps['spawnService'] = (_root, registry) => {
      spawnCallCount++;
      health = {
        status: 'ok',
        repoRoot,
        version: SPRITE_SIDECAR_SERVICE_VERSION,
        queueBackend: 'azure-queue',
        worker: { running: true },
        issueIngester: { running: true },
        service: {
          managed: true,
          instanceId: registry.instanceId,
          pid: 88888,
          startedAt: registry.startedAt,
        },
      };
      return { pid: 88888 };
    };

    const result = await ensureSidecarService(repoRoot, {
      registryRoot,
      bootstrap: vi.fn(),
      now: () => baseTime,
      probeHealth: async () => health,
      spawnService: spawnFn,
      // PID is "alive" — simulates recycled PID in another process
      isProcessAlive: () => true,
      sleep: async () => Promise.resolve(),
    });

    expect(spawnCallCount).toBe(1);
    expect(result.state).toBe('started');
  });

  it('throws when provenance mismatches and managed shutdown cannot be authenticated', async () => {
    const repoRoot = makeRoot('crawler-sidecar-prov-');
    const registryRoot = makeRoot('crawler-sidecar-prov-registry-');
    await expect(
      ensureSidecarService(repoRoot, {
        registryRoot,
        bootstrap: vi.fn(),
        computeProvenance: () => 'new-commit-hash',
        probeHealth: async () => ({
          status: 'ok',
          repoRoot,
          version: SPRITE_SIDECAR_SERVICE_VERSION,
          queueBackend: 'azure-queue',
          worker: { running: true },
          issueIngester: { running: true },
          service: {
            managed: true,
            instanceId: 'some-id',
            pid: 12345,
            startedAt: new Date().toISOString(),
            codeProvenance: 'old-commit-hash',
          },
        }),
        spawnService: vi.fn(() => ({ pid: 999 })),
        isProcessAlive: () => true,
        sleep: async () => Promise.resolve(),
      }),
    ).rejects.toThrow(/different code revision/);
  });
});
