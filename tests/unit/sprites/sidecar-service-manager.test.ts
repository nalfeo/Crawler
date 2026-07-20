import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureSidecarService,
  stopSidecarService,
  sidecarRegistryExists,
  registryPathFor,
  rotateLogIfNeeded,
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
    const spawnService = vi.fn((_root, registry) => {
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
          pid: 4321,
          startedAt: registry.startedAt,
        },
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
    // Fake clock: first 5 calls are under deadline; thereafter past it.
    const nowFn = vi.fn(() => (callCount++ < 5 ? baseTime : baseTime + 70_000));

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

  it('clears startup claim when shutdown request does not stop the service in time', async () => {
    const repoRoot = makeRoot('crawler-sidecar-timeout-auth-');
    const registryRoot = makeRoot('crawler-sidecar-timeout-auth-registry-');
    const terminateFn = vi.fn();
    let nowTick = 0;
    const baseTime = 1_000_000;
    const nowFn = vi.fn(() => (nowTick++ < 3 ? baseTime : baseTime + 70_000));
    const spawnedPid = 54321;
    let claimedInstanceId = '';
    let probePhase: 'before-spawn' | 'after-spawn' = 'before-spawn';
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        ensureSidecarService(repoRoot, {
          registryRoot,
          bootstrap: vi.fn(),
          now: nowFn,
          probeHealth: async () =>
            probePhase === 'before-spawn'
              ? null
              : {
                  service: {
                    managed: true,
                    instanceId: claimedInstanceId,
                    pid: spawnedPid,
                    startedAt: new Date().toISOString(),
                  },
                },
          spawnService: vi.fn((_root, registry) => {
            claimedInstanceId = registry.instanceId;
            probePhase = 'after-spawn';
            return { pid: spawnedPid };
          }),
          isProcessAlive: () => true,
          terminateProcess: terminateFn,
          sleep: async () => Promise.resolve(),
        }),
      ).rejects.toThrow(/did not become ready/);
      expect(sidecarRegistryExists(repoRoot, registryRoot)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
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
          worker: { running: false },
          issueIngester: { running: false },
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

  it('does not treat a competing ready instance as successful startup for this claim', async () => {
    const repoRoot = makeRoot('crawler-sidecar-race-');
    const registryRoot = makeRoot('crawler-sidecar-race-registry-');
    let nowTick = 0;
    const baseTime = 1_000_000;
    const nowFn = vi.fn(() => (nowTick++ < 3 ? baseTime : baseTime + 70_000));
    let probePhase: 'before-spawn' | 'after-spawn' = 'before-spawn';
    await expect(
      ensureSidecarService(repoRoot, {
        registryRoot,
        bootstrap: vi.fn(),
        now: nowFn,
        probeHealth: async () =>
          probePhase === 'before-spawn'
            ? null
            : {
                status: 'ok',
                repoRoot,
                version: SPRITE_SIDECAR_SERVICE_VERSION,
                queueBackend: 'azure-queue',
                worker: { running: true },
                issueIngester: { running: true },
                service: {
                  managed: true,
                  instanceId: 'different-instance',
                  pid: 90001,
                  startedAt: new Date().toISOString(),
                },
              },
        spawnService: vi.fn(() => {
          probePhase = 'after-spawn';
          return { pid: 77777 };
        }),
        isProcessAlive: () => true,
        terminateProcess: vi.fn(),
        sleep: async () => Promise.resolve(),
      }),
    ).rejects.toThrow(/did not become ready/);
    expect(sidecarRegistryExists(repoRoot, registryRoot)).toBe(false);
  });

  it('does not spawn when bootstrap exceeds startup deadline', async () => {
    const repoRoot = makeRoot('crawler-sidecar-bootstrap-time-');
    const registryRoot = makeRoot('crawler-sidecar-bootstrap-time-registry-');
    const spawnFn = vi.fn(() => ({ pid: 10101 }));
    let currentTime = 1_000_000;
    await expect(
      ensureSidecarService(repoRoot, {
        registryRoot,
        now: () => currentTime,
        probeHealth: async () => null,
        bootstrap: () => {
          currentTime += 70_000;
        },
        spawnService: spawnFn,
        isProcessAlive: () => true,
        sleep: async () => Promise.resolve(),
      }),
    ).rejects.toThrow(/did not become ready/);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(sidecarRegistryExists(repoRoot, registryRoot)).toBe(false);
  });

  it('does not spawn after bootstrap if registry ownership is replaced', async () => {
    const repoRoot = makeRoot('crawler-sidecar-bootstrap-owner-');
    const registryRoot = makeRoot('crawler-sidecar-bootstrap-owner-registry-');
    const spawnFn = vi.fn(() => ({ pid: 20202 }));
    const regPath = registryPathFor(repoRoot, registryRoot);
    let replacementWritten = false;
    await expect(
      ensureSidecarService(repoRoot, {
        registryRoot,
        probeHealth: async () => null,
        bootstrap: () => {
          writeFileSync(
            regPath,
            JSON.stringify({
              schema: 1,
              repoRoot,
              port: 34567,
              version: SPRITE_SIDECAR_SERVICE_VERSION,
              instanceId: 'replacement-owner',
              shutdownToken: 'replacement-token',
              startedAt: new Date().toISOString(),
              logPath: path.join(registryRoot, 'replacement.log'),
              pid: 45678,
            }),
          );
          replacementWritten = true;
        },
        spawnService: spawnFn,
        isProcessAlive: () => true,
        sleep: async () => Promise.resolve(),
      }),
    ).rejects.toThrow(/ownership was replaced/);
    expect(replacementWritten).toBe(true);
    expect(spawnFn).not.toHaveBeenCalled();
    const finalRegistry = JSON.parse(readFileSync(regPath, 'utf8'));
    expect(finalRegistry.instanceId).toBe('replacement-owner');
  });

  it('loads .env.local before freezing the launch port', async () => {
    const repoRoot = makeRoot('crawler-sidecar-env-port-');
    const registryRoot = makeRoot('crawler-sidecar-env-port-registry-');
    writeFileSync(path.join(repoRoot, '.env.local'), 'SPRITES_SIDECAR_PORT=4999\n', 'utf8');
    const originalPort = process.env.SPRITES_SIDECAR_PORT;
    delete process.env.SPRITES_SIDECAR_PORT;
    let health: Record<string, unknown> | null = null;
    const probeCalls: string[] = [];
    try {
      const result = await ensureSidecarService(repoRoot, {
        registryRoot,
        bootstrap: vi.fn(),
        probeHealth: async (baseUrl) => {
          probeCalls.push(baseUrl);
          return health;
        },
        spawnService: vi.fn((_root, registry) => {
          expect(registry.port).toBe(4999);
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
              pid: 43210,
              startedAt: registry.startedAt,
            },
          };
          return { pid: 43210 };
        }),
        isProcessAlive: () => true,
        sleep: async () => Promise.resolve(),
      });
      expect(result.state).toBe('started');
      expect(probeCalls[0]).toBe('http://127.0.0.1:4999');
    } finally {
      if (originalPort === undefined) delete process.env.SPRITES_SIDECAR_PORT;
      else process.env.SPRITES_SIDECAR_PORT = originalPort;
    }
  });

  it('treats the registry port as authoritative for an existing claim', async () => {
    const repoRoot = makeRoot('crawler-sidecar-registry-port-');
    const registryRoot = makeRoot('crawler-sidecar-registry-port-registry-');
    const regPath = registryPathFor(repoRoot, registryRoot);
    mkdirSync(registryRoot, { recursive: true });
    writeFileSync(
      regPath,
      JSON.stringify({
        schema: 1,
        repoRoot,
        port: 4999,
        version: SPRITE_SIDECAR_SERVICE_VERSION,
        instanceId: 'existing-instance',
        shutdownToken: 'existing-token',
        startedAt: new Date().toISOString(),
        logPath: path.join(registryRoot, 'existing.log'),
        pid: 12345,
      }),
    );
    const originalPort = process.env.SPRITES_SIDECAR_PORT;
    process.env.SPRITES_SIDECAR_PORT = '3010';
    const probeCalls: string[] = [];
    try {
      const result = await ensureSidecarService(repoRoot, {
        registryRoot,
        bootstrap: vi.fn(),
        probeHealth: async (baseUrl) => {
          probeCalls.push(baseUrl);
          if (baseUrl !== 'http://127.0.0.1:4999') return null;
          return {
            status: 'ok',
            repoRoot,
            version: SPRITE_SIDECAR_SERVICE_VERSION,
            queueBackend: 'azure-queue',
            worker: { running: true },
            issueIngester: { running: true },
            service: {
              managed: true,
              instanceId: 'existing-instance',
              pid: 12345,
              startedAt: new Date().toISOString(),
            },
          };
        },
        spawnService: vi.fn(() => ({ pid: 99999 })),
        isProcessAlive: () => true,
        sleep: async () => Promise.resolve(),
      });
      expect(result.state).toBe('reused');
      expect(probeCalls[0]).toBe('http://127.0.0.1:4999');
    } finally {
      if (originalPort === undefined) delete process.env.SPRITES_SIDECAR_PORT;
      else process.env.SPRITES_SIDECAR_PORT = originalPort;
    }
  });

  it('releases registry when process has already exited and uses registry port even when environment port differs', async () => {
    const repoRoot = makeRoot('crawler-sidecar-stop-port-');
    const registryRoot = makeRoot('crawler-sidecar-stop-port-registry-');
    const regPath = registryPathFor(repoRoot, registryRoot);
    mkdirSync(registryRoot, { recursive: true });
    writeFileSync(
      regPath,
      JSON.stringify({
        schema: 1,
        repoRoot,
        port: 4999,
        version: SPRITE_SIDECAR_SERVICE_VERSION,
        instanceId: 'stop-instance',
        shutdownToken: 'stop-token',
        startedAt: new Date().toISOString(),
        logPath: path.join(registryRoot, 'stop.log'),
        pid: 65432,
      }),
    );
    const originalPort = process.env.SPRITES_SIDECAR_PORT;
    process.env.SPRITES_SIDECAR_PORT = '3010';
    const probeCalls: string[] = [];
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    let callCount = 0;
    try {
      const stopped = await stopSidecarService(repoRoot, {
        registryRoot,
        probeHealth: async (baseUrl) => {
          probeCalls.push(baseUrl);
          callCount += 1;
          if (callCount === 1) {
            return {
              service: {
                managed: true,
                instanceId: 'stop-instance',
                pid: 65432,
                startedAt: new Date().toISOString(),
              },
            };
          }
          return null;
        },
        isProcessAlive: () => false, // process has exited
        sleep: async () => Promise.resolve(),
      });
      expect(stopped).toBe(true);
      expect(probeCalls[0]).toBe('http://127.0.0.1:4999');
      const firstFetchCall = fetchMock.mock.calls[0] as unknown[] | undefined;
      expect(firstFetchCall?.[0]).toBe('http://127.0.0.1:4999/api/service/shutdown');
      expect(sidecarRegistryExists(repoRoot, registryRoot)).toBe(false);
    } finally {
      if (originalPort === undefined) delete process.env.SPRITES_SIDECAR_PORT;
      else process.env.SPRITES_SIDECAR_PORT = originalPort;
      vi.unstubAllGlobals();
    }
  });

  it('waits for registry pid to exit before releasing registry after shutdown', async () => {
    const repoRoot = makeRoot('crawler-sidecar-pid-wait-');
    const registryRoot = makeRoot('crawler-sidecar-pid-wait-registry-');
    const regPath = registryPathFor(repoRoot, registryRoot);
    mkdirSync(registryRoot, { recursive: true });
    writeFileSync(
      regPath,
      JSON.stringify({
        schema: 1,
        repoRoot,
        port: 4999,
        version: SPRITE_SIDECAR_SERVICE_VERSION,
        instanceId: 'pid-wait-instance',
        shutdownToken: 'pid-wait-token',
        startedAt: new Date().toISOString(),
        logPath: path.join(registryRoot, 'pid-wait.log'),
        pid: 55555,
      }),
    );
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    let healthCallCount = 0;
    let processAliveCallCount = 0;
    try {
      const stopped = await stopSidecarService(repoRoot, {
        registryRoot,
        probeHealth: async () => {
          healthCallCount++;
          if (healthCallCount === 1) {
            // First call is for requestManagedShutdown authentication
            return {
              service: {
                managed: true,
                instanceId: 'pid-wait-instance',
                pid: 55555,
                startedAt: new Date().toISOString(),
              },
            };
          }
          return null; // Health gone after shutdown request
        },
        isProcessAlive: (pid) => {
          expect(pid).toBe(55555);
          processAliveCallCount++;
          // PID alive for first 2 checks (process draining), then exited
          return processAliveCallCount < 3;
        },
        sleep: async () => Promise.resolve(),
      });
      expect(stopped).toBe(true);
      // Must have polled pid at least until it exited (3+ checks)
      expect(processAliveCallCount).toBeGreaterThanOrEqual(3);
      expect(sidecarRegistryExists(repoRoot, registryRoot)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects SPRITES_SIDECAR_PORT=0 with an actionable error', async () => {
    const repoRoot = makeRoot('crawler-sidecar-port-zero-');
    const registryRoot = makeRoot('crawler-sidecar-port-zero-registry-');
    const originalPort = process.env.SPRITES_SIDECAR_PORT;
    process.env.SPRITES_SIDECAR_PORT = '0';
    try {
      await expect(
        ensureSidecarService(repoRoot, {
          registryRoot,
          bootstrap: vi.fn(),
          probeHealth: async () => null,
          spawnService: vi.fn(() => ({ pid: 1 })),
          isProcessAlive: () => false,
          sleep: async () => Promise.resolve(),
        }),
      ).rejects.toThrow(/SPRITES_SIDECAR_PORT=0/);
      // No registry should have been created
      expect(sidecarRegistryExists(repoRoot, registryRoot)).toBe(false);
    } finally {
      if (originalPort === undefined) delete process.env.SPRITES_SIDECAR_PORT;
      else process.env.SPRITES_SIDECAR_PORT = originalPort;
    }
  });
});

describe('rotateLogIfNeeded', () => {
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

  it('does not rotate a log file below the size cap', () => {
    const dir = makeRoot('crawler-rotate-small-');
    const logPath = path.join(dir, 'test.log');
    writeFileSync(logPath, 'small content', 'utf8');
    rotateLogIfNeeded(logPath);
    expect(statSync(logPath).size).toBeGreaterThan(0); // original still present
    expect(() => statSync(`${logPath}.old`)).toThrow(); // .old must not exist
  });

  it('rotates a log file that exceeds the size cap', () => {
    const dir = makeRoot('crawler-rotate-large-');
    const logPath = path.join(dir, 'test.log');
    // Write slightly over 10 MB
    const chunk = Buffer.alloc(1024 * 1024, 'x'); // 1 MB chunk
    for (let i = 0; i < 11; i++) {
      writeFileSync(logPath, chunk, { flag: 'a' });
    }
    expect(statSync(logPath).size).toBeGreaterThan(10 * 1024 * 1024);
    rotateLogIfNeeded(logPath);
    expect(() => statSync(logPath)).toThrow(); // original renamed away
    expect(statSync(`${logPath}.old`).size).toBeGreaterThan(10 * 1024 * 1024);
  });

  it('is a no-op when the log file does not exist', () => {
    const dir = makeRoot('crawler-rotate-missing-');
    const logPath = path.join(dir, 'nonexistent.log');
    // Should not throw
    expect(() => rotateLogIfNeeded(logPath)).not.toThrow();
  });
});
