/**
 * Pure helpers for host resource profiling (CPU / memory / pressure / disk).
 *
 * WHY THIS EXISTS
 * ---------------
 * Cloud agent sessions and GitHub-hosted Actions runners are completely blind
 * to how much of the machine they are actually using: is a 4-vCPU runner
 * pegged, or idling at 12% while a job waits on one serialized step? Is a
 * containerized session about to be OOM-killed, or sitting on 6 GB of unused
 * headroom? Nothing in the repo answered that, so every "should we parallelize
 * this harder?" decision was a guess (issue #3800).
 *
 * HOST vs CGROUP — WHY BOTH ARE REPORTED
 * --------------------------------------
 * Inside a container, `os.cpus()` and `os.totalmem()` describe the *physical
 * host*, not the slice this process may use. Reporting only those numbers is
 * worse than reporting nothing: a container capped at 2 CPUs on a 32-core host
 * looks 94% idle while it is in fact throttled solid. So the sampler reports
 * two independent views and never conflates them:
 *
 *   - **host**: `/proc/meminfo` + `os.cpus()` deltas — what the box is doing.
 *   - **cgroup**: `cpu.stat` / `memory.current` deltas against the *effective*
 *     limit (tightest quota found walking from the leaf cgroup to the root) —
 *     what this process is allowed to do, plus CPU throttling counters, which
 *     are the only direct evidence of "we want more CPU than we may have".
 *
 * All parsing is text-in / value-out so every layout (cgroup v2, cgroup v1,
 * nested paths, "max" sentinels, malformed files) is unit-testable without a
 * real host.
 *
 * UNITS
 * -----
 * Bytes for memory/disk, percent (0-100) for utilization, microseconds for the
 * raw cgroup CPU counters. Every emitted field name carries its unit suffix.
 */

/** Bumped when the emitted report shape changes incompatibly. */
export const HOST_TELEMETRY_SCHEMA_VERSION = 1;

/** Aggregate CPU time counters, in milliseconds, summed over all cores. */
export interface CpuTimes {
  readonly user: number;
  readonly nice: number;
  readonly sys: number;
  readonly idle: number;
  readonly irq: number;
}

/** A point-in-time reading of the host's cumulative CPU counters. */
export interface CpuSnapshot {
  readonly cores: number;
  readonly model: string;
  readonly times: CpuTimes;
}

/** Utilization derived from two {@link CpuSnapshot}s. */
export interface CpuUtilization {
  readonly busyPct: number;
  readonly userPct: number;
  readonly sysPct: number;
  readonly idlePct: number;
}

/** Host memory accounting. `available` is MemAvailable when the kernel offers it. */
export interface MemoryInfo {
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly usedBytes: number;
  readonly freeBytes: number;
  readonly swapTotalBytes: number | null;
  readonly swapUsedBytes: number | null;
  /** `proc` = /proc/meminfo (accurate); `os` = os.totalmem/freemem fallback. */
  readonly source: 'proc' | 'os';
}

/** The cgroup limits this process actually runs under. */
export interface CgroupLimits {
  readonly version: 'v1' | 'v2';
  /** null = unlimited (v2 `max`, or a v1 sentinel at/above host memory). */
  readonly memoryLimitBytes: number | null;
  /** null = unlimited/unknown. Fractional when the quota is not a whole CPU. */
  readonly effectiveCpus: number | null;
}

/** Cumulative cgroup CPU counters, microseconds, from `cpu.stat`. */
export interface CgroupCpuSnapshot {
  readonly usageUsec: number | null;
  readonly userUsec: number | null;
  readonly systemUsec: number | null;
  readonly nrThrottled: number | null;
  readonly throttledUsec: number | null;
}

/** One `/proc/pressure/*` line pair (PSI). Values are percentages. */
export interface PressureStall {
  readonly someAvg10: number;
  readonly fullAvg10: number | null;
}

/** A single sampling tick. */
export interface HostSample {
  readonly timestamp: string;
  readonly elapsedMs: number;
  readonly cpuBusyPct: number | null;
  readonly cpuUserPct: number | null;
  readonly cpuSysPct: number | null;
  readonly memoryUsedBytes: number;
  readonly memoryAvailableBytes: number;
  readonly memoryUsedPct: number;
  readonly swapUsedBytes: number | null;
  readonly cgroupCpuPct: number | null;
  readonly cgroupCpuThrottledPct: number | null;
  readonly cgroupMemoryCurrentBytes: number | null;
  /** True when the charge above came from an ancestor cgroup (see reader doc). */
  readonly cgroupMemoryFromAncestor: boolean | null;
  readonly cgroupMemoryUsedPct: number | null;
  readonly loadAvg1: number;
  readonly loadPerCore: number;
  readonly cpuPressureSomeAvg10: number | null;
  readonly memoryPressureSomeAvg10: number | null;
  readonly ioPressureSomeAvg10: number | null;
  readonly diskFreeBytes: number | null;
  readonly diskUsedPct: number | null;
}

/** Static description of the machine (or container slice) being profiled. */
export interface HostInfo {
  readonly platform: string;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly effectiveCpus: number;
  readonly memoryTotalBytes: number;
  readonly memoryLimitBytes: number | null;
  readonly memorySource: 'proc' | 'os';
  readonly containerized: boolean;
  readonly cgroup: CgroupLimits | null;
  readonly diskTotalBytes: number | null;
}

/** Environment context so a report can be traced back to a run/session. */
export interface RunContext {
  readonly label: string;
  readonly githubRunId: string | null;
  readonly githubRunAttempt: string | null;
  readonly githubJob: string | null;
  readonly githubWorkflow: string | null;
  readonly runnerOs: string | null;
  readonly runnerArch: string | null;
  readonly ci: boolean;
}

/** min/max/mean/p95 over a gauge series. */
export interface SeriesStats {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p95: number;
}

/** The document written by the CLI. */
export interface HostReport {
  readonly schemaVersion: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationSec: number;
  readonly sampleCount: number;
  readonly intervalMs: number;
  readonly context: RunContext;
  readonly host: HostInfo;
  readonly summary: Record<string, SeriesStats>;
  readonly headroom: Headroom;
  readonly samples: readonly HostSample[];
}

/** The "am I using what I was given?" verdict, derived from the summary. */
export interface Headroom {
  readonly peakCpuPct: number | null;
  readonly meanCpuPct: number | null;
  readonly peakMemoryUsedBytes: number | null;
  readonly memoryLimitBytes: number | null;
  readonly peakMemoryUsedPct: number | null;
  readonly cpuThrottled: boolean;
  readonly notes: readonly string[];
}

/** Filesystem/OS reads the collector needs, injectable so tests stay hermetic. */
export interface HostReaders {
  /** Returns file contents, or null when missing/unreadable. */
  readText(path: string): string | null;
  cpus(): ReadonlyArray<{ model: string; times: CpuTimes }>;
  totalmem(): number;
  freemem(): number;
  loadavg(): readonly number[];
  platform(): string;
  arch(): string;
  statfs(path: string): {
    blockSizeBytes: number;
    totalBlocks: number;
    /** Blocks free including the root-reserved pool (`bfree`). */
    freeBlocks: number;
    /** Blocks an unprivileged writer may actually use (`bavail`). */
    availableBlocks: number;
  } | null;
  now(): number;
  env(name: string): string | undefined;
}

const KIB = 1024;

/** Sum every core's cumulative time counters into one host-wide snapshot. */
export function aggregateCpuTimes(
  cpus: ReadonlyArray<{ model: string; times: CpuTimes }>,
): CpuSnapshot {
  const times = cpus.reduce<CpuTimes>(
    (acc, cpu) => ({
      user: acc.user + cpu.times.user,
      nice: acc.nice + cpu.times.nice,
      sys: acc.sys + cpu.times.sys,
      idle: acc.idle + cpu.times.idle,
      irq: acc.irq + cpu.times.irq,
    }),
    { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  );
  return { cores: cpus.length, model: cpus[0]?.model ?? 'unknown', times };
}

/**
 * Utilization between two cumulative snapshots.
 *
 * Returns null when no time elapsed between them (the first sample, or a
 * counter that did not move) — a fabricated 0% there would poison the mean.
 */
export function cpuUtilizationBetween(
  previous: CpuSnapshot,
  next: CpuSnapshot,
): CpuUtilization | null {
  const deltaOf = (key: keyof CpuTimes): number =>
    Math.max(0, next.times[key] - previous.times[key]);
  const user = deltaOf('user') + deltaOf('nice');
  const sys = deltaOf('sys') + deltaOf('irq');
  const idle = deltaOf('idle');
  const total = user + sys + idle;
  if (total <= 0) return null;
  const busy = user + sys;
  return {
    busyPct: toPct(busy / total),
    userPct: toPct(user / total),
    sysPct: toPct(sys / total),
    idlePct: toPct(idle / total),
  };
}

/** Parse `/proc/meminfo` into a byte-valued map (kB lines are converted). */
export function parseProcMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s+(\d+)(?:\s+(\w+))?/.exec(line.trim());
    const key = match?.[1];
    if (!match || key === undefined) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    out[key] = match[3]?.toLowerCase() === 'kb' ? value * KIB : value;
  }
  return out;
}

/**
 * Host memory from `/proc/meminfo`.
 *
 * Uses `MemAvailable` when the kernel exports it: `MemFree` alone understates
 * availability badly on a build runner, where most of RAM is reclaimable page
 * cache from checkout + npm ci.
 */
export function memoryFromProcMeminfo(text: string): MemoryInfo | null {
  const info = parseProcMeminfo(text);
  const total = info.MemTotal;
  if (!total) return null;
  const free = info.MemFree ?? 0;
  const available =
    info.MemAvailable ?? Math.min(total, free + (info.Buffers ?? 0) + (info.Cached ?? 0));
  const swapTotal = info.SwapTotal ?? null;
  const swapFree = info.SwapFree ?? null;
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: Math.max(0, total - available),
    freeBytes: free,
    swapTotalBytes: swapTotal,
    swapUsedBytes:
      swapTotal === null || swapFree === null ? null : Math.max(0, swapTotal - swapFree),
    source: 'proc',
  };
}

/** Portable fallback when `/proc/meminfo` is absent (macOS/Windows). */
export function memoryFromOs(totalBytes: number, freeBytes: number): MemoryInfo {
  return {
    totalBytes,
    availableBytes: freeBytes,
    usedBytes: Math.max(0, totalBytes - freeBytes),
    freeBytes,
    swapTotalBytes: null,
    swapUsedBytes: null,
    source: 'os',
  };
}

/**
 * Cgroup directories this process belongs to, leaf first, then each ancestor.
 *
 * Limits are inherited, so the *effective* limit is the tightest one anywhere
 * on that chain — reading only `/sys/fs/cgroup/memory.max` (the root) reports
 * "unlimited" for every nested container, which is exactly the environment we
 * care about.
 */
export function cgroupPathsFromProc(
  procSelfCgroup: string,
  mountRoot = '/sys/fs/cgroup',
): { version: 'v1' | 'v2'; memoryDirs: string[]; cpuDirs: string[]; cpuacctDirs: string[] } {
  const lines = procSelfCgroup
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const v2Line = lines.find((line) => line.startsWith('0::'));
  if (v2Line) {
    const dirs = ancestorDirs(mountRoot, v2Line.slice('0::'.length));
    return { version: 'v2', memoryDirs: dirs, cpuDirs: dirs, cpuacctDirs: dirs };
  }
  const controllerDirs = (controller: string): string[] => {
    const line = lines.find((entry) => entry.split(':')[1]?.split(',').includes(controller));
    const relative = line ? (line.split(':')[2] ?? '/') : '/';
    return ancestorDirs(`${mountRoot}/${controller}`, relative);
  };
  return {
    version: 'v1',
    memoryDirs: controllerDirs('memory'),
    cpuDirs: controllerDirs('cpu'),
    cpuacctDirs: controllerDirs('cpuacct'),
  };
}

function ancestorDirs(root: string, relative: string): string[] {
  const segments = relative.split('/').filter(Boolean);
  const dirs: string[] = [];
  for (let i = segments.length; i >= 0; i -= 1) {
    dirs.push([root, ...segments.slice(0, i)].join('/'));
  }
  return dirs;
}

/** Parse cgroup v2 `memory.max`. `max` (unlimited) and junk both yield null. */
export function parseCgroupMemoryMax(text: string): number | null {
  const raw = text.trim();
  if (raw === '' || raw === 'max') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Parse cgroup v1 `memory.limit_in_bytes`.
 *
 * v1 has no `max` keyword: unlimited is a page-aligned near-2^63 sentinel, and
 * some kernels report values merely larger than RAM. Anything at or above host
 * memory is therefore treated as "no limit" rather than a real ceiling.
 */
export function parseCgroupV1MemoryLimit(text: string, hostTotalBytes: number): number | null {
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  if (hostTotalBytes > 0 && value >= hostTotalBytes) return null;
  return value;
}

/** Parse cgroup v2 `cpu.max` (`"<quota|max> <period>"`) into effective CPUs. */
export function parseCgroupCpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (!quota || quota === 'max') return null;
  const quotaUsec = Number(quota);
  const periodUsec = Number(period ?? '100000');
  if (!Number.isFinite(quotaUsec) || !Number.isFinite(periodUsec) || periodUsec <= 0) return null;
  return quotaUsec > 0 ? quotaUsec / periodUsec : null;
}

/** Parse cgroup v1 `cpu.cfs_quota_us` + `cpu.cfs_period_us` into effective CPUs. */
export function parseCgroupV1CpuQuota(quotaText: string, periodText: string): number | null {
  const quota = Number(quotaText.trim());
  const period = Number(periodText.trim());
  if (!Number.isFinite(quota) || quota <= 0) return null;
  if (!Number.isFinite(period) || period <= 0) return null;
  return quota / period;
}

/** Count CPUs in a cpuset list such as `0-3,8,10-11`. */
export function parseCpusetList(text: string): number | null {
  const raw = text.trim();
  if (!raw) return null;
  let count = 0;
  for (const part of raw.split(',')) {
    const [start, end] = part.split('-').map((value) => Number(value));
    if (start === undefined || !Number.isFinite(start)) return null;
    count += end === undefined || !Number.isFinite(end) ? 1 : Math.max(0, end - start + 1);
  }
  return count > 0 ? count : null;
}

/** Parse a flat `key value` cgroup stat file (`cpu.stat`, `memory.stat`). */
export function parseCgroupKeyedStat(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    if (!key || value === undefined) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) out[key] = parsed;
  }
  return out;
}

/** Read the cumulative CPU counters out of a `cpu.stat` document. */
export function parseCgroupCpuStat(text: string): CgroupCpuSnapshot {
  const stat = parseCgroupKeyedStat(text);
  const pick = (key: string): number | null => stat[key] ?? null;
  return {
    usageUsec: pick('usage_usec'),
    userUsec: pick('user_usec'),
    systemUsec: pick('system_usec'),
    nrThrottled: pick('nr_throttled'),
    throttledUsec: pick('throttled_usec'),
  };
}

/** Parse a `/proc/pressure/<resource>` (PSI) document. */
export function parsePressure(text: string): PressureStall | null {
  const readAvg10 = (prefix: string): number | null => {
    const line = text.split('\n').find((entry) => entry.trim().startsWith(prefix));
    if (!line) return null;
    const match = /avg10=([\d.]+)/.exec(line);
    return match ? Number(match[1]) : null;
  };
  const some = readAvg10('some');
  if (some === null || !Number.isFinite(some)) return null;
  const full = readAvg10('full');
  return { someAvg10: some, fullAvg10: full !== null && Number.isFinite(full) ? full : null };
}

/** Resolve the tightest memory + CPU limits on this process's cgroup chain. */
export function readCgroupLimits(
  readers: HostReaders,
  hostTotalBytes: number,
): CgroupLimits | null {
  const procSelf = readers.readText('/proc/self/cgroup');
  if (procSelf === null) return null;
  const { version, memoryDirs, cpuDirs } = cgroupPathsFromProc(procSelf);

  let memoryLimitBytes: number | null = null;
  for (const dir of memoryDirs) {
    const raw =
      version === 'v2'
        ? readers.readText(`${dir}/memory.max`)
        : readers.readText(`${dir}/memory.limit_in_bytes`);
    if (raw === null) continue;
    const limit =
      version === 'v2' ? parseCgroupMemoryMax(raw) : parseCgroupV1MemoryLimit(raw, hostTotalBytes);
    if (limit !== null) memoryLimitBytes = tighter(memoryLimitBytes, limit);
  }

  let effectiveCpus: number | null = null;
  for (const dir of cpuDirs) {
    if (version === 'v2') {
      const raw = readers.readText(`${dir}/cpu.max`);
      if (raw !== null) effectiveCpus = tighter(effectiveCpus, parseCgroupCpuMax(raw));
      const cpuset = readers.readText(`${dir}/cpuset.cpus.effective`);
      if (cpuset !== null) effectiveCpus = tighter(effectiveCpus, parseCpusetList(cpuset));
    } else {
      const quota = readers.readText(`${dir}/cpu.cfs_quota_us`);
      const period = readers.readText(`${dir}/cpu.cfs_period_us`);
      if (quota !== null && period !== null) {
        effectiveCpus = tighter(effectiveCpus, parseCgroupV1CpuQuota(quota, period));
      }
    }
  }

  if (memoryLimitBytes === null && effectiveCpus === null) {
    return { version, memoryLimitBytes: null, effectiveCpus: null };
  }
  return { version, memoryLimitBytes, effectiveCpus };
}

function tighter(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;
  return current === null ? candidate : Math.min(current, candidate);
}

/**
 * Cumulative cgroup CPU counters for the leaf cgroup, normalized to the v2
 * shape (microseconds) so v1 and v2 hosts produce the same series.
 *
 * v1 keeps the same numbers in `cpuacct.usage` (nanoseconds) and reports
 * throttling in `cpu.stat` as `throttled_time` (also nanoseconds).
 */
export function readCgroupCpuSnapshot(readers: HostReaders): CgroupCpuSnapshot | null {
  const procSelf = readers.readText('/proc/self/cgroup');
  if (procSelf === null) return null;
  const { version, cpuDirs, cpuacctDirs } = cgroupPathsFromProc(procSelf);
  if (version === 'v2') {
    for (const dir of cpuDirs) {
      const raw = readers.readText(`${dir}/cpu.stat`);
      if (raw !== null) return parseCgroupCpuStat(raw);
    }
    return null;
  }
  return readCgroupV1CpuSnapshot(
    cpuacctDirs.map((dir) => readers.readText(`${dir}/cpuacct.usage`)),
    cpuacctDirs.map((dir) => readers.readText(`${dir}/cpuacct.stat`)),
    cpuDirs.map((dir) => readers.readText(`${dir}/cpu.stat`)),
  );
}

/** Build a v2-shaped snapshot from cgroup v1 `cpuacct.*` + `cpu.stat` contents. */
export function readCgroupV1CpuSnapshot(
  usageTexts: ReadonlyArray<string | null>,
  cpuacctStatTexts: ReadonlyArray<string | null>,
  cpuStatTexts: ReadonlyArray<string | null>,
): CgroupCpuSnapshot | null {
  const usageNs = firstNumber(usageTexts);
  const cpuacctStat = firstParsed(cpuacctStatTexts, parseCgroupKeyedStat);
  const cpuStat = firstParsed(cpuStatTexts, parseCgroupKeyedStat);
  if (usageNs === null && cpuacctStat === null && cpuStat === null) return null;
  // cpuacct.stat is in USER_HZ (100 Hz on every Linux target) = 10_000 usec.
  const fromUserHz = (value: number | undefined): number | null =>
    value === undefined ? null : value * 10_000;
  return {
    usageUsec: usageNs === null ? null : Math.round(usageNs / 1000),
    userUsec: fromUserHz(cpuacctStat?.user),
    systemUsec: fromUserHz(cpuacctStat?.system),
    nrThrottled: cpuStat?.nr_throttled ?? null,
    throttledUsec:
      cpuStat?.throttled_time === undefined ? null : Math.round(cpuStat.throttled_time / 1000),
  };
}

function firstNumber(texts: ReadonlyArray<string | null>): number | null {
  for (const text of texts) {
    if (text === null) continue;
    const value = Number(text.trim());
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function firstParsed<T>(texts: ReadonlyArray<string | null>, parse: (text: string) => T): T | null {
  for (const text of texts) {
    if (text !== null) return parse(text);
  }
  return null;
}

/**
 * Current cgroup memory charge (includes reclaimable page cache), read from the
 * deepest cgroup directory that is actually visible.
 *
 * Usage is hierarchical, so an ancestor's `memory.current` also counts sibling
 * workloads and can overstate ours. Reading only the leaf is not an option
 * either: under a cgroup namespace (the common containerized case, including
 * cloud agent sessions) the path in /proc/self/cgroup does not exist inside the
 * mounted view at all, so a leaf-only read reports nothing. The compromise is
 * to take the deepest visible directory and say so — `fromAncestor` marks a
 * reading that may include siblings, and the report surfaces that caveat rather
 * than presenting it as ours.
 */
export function readCgroupMemoryCurrent(
  readers: HostReaders,
): { bytes: number; fromAncestor: boolean } | null {
  const procSelf = readers.readText('/proc/self/cgroup');
  if (procSelf === null) return null;
  const { version, memoryDirs } = cgroupPathsFromProc(procSelf);
  for (const [index, dir] of memoryDirs.entries()) {
    const raw =
      version === 'v2'
        ? readers.readText(`${dir}/memory.current`)
        : readers.readText(`${dir}/memory.usage_in_bytes`);
    if (raw === null) continue;
    const value = Number(raw.trim());
    if (Number.isFinite(value) && value >= 0) return { bytes: value, fromAncestor: index > 0 };
  }
  return null;
}

/** Read host memory, preferring `/proc/meminfo` over the coarse `os` numbers. */
export function readMemory(readers: HostReaders): MemoryInfo {
  const procMeminfo = readers.readText('/proc/meminfo');
  const parsed = procMeminfo === null ? null : memoryFromProcMeminfo(procMeminfo);
  return parsed ?? memoryFromOs(readers.totalmem(), readers.freemem());
}

/** Static machine description, resolved once per run. */
export function collectHostInfo(readers: HostReaders, diskPath: string): HostInfo {
  const cpuSnapshot = aggregateCpuTimes(readers.cpus());
  const memory = readMemory(readers);
  const cgroup = readCgroupLimits(readers, memory.totalBytes);
  const statfs = readers.statfs(diskPath);
  const effectiveCpus = cgroup?.effectiveCpus ?? cpuSnapshot.cores;
  return {
    platform: readers.platform(),
    arch: readers.arch(),
    cpuModel: cpuSnapshot.model,
    cpuCount: cpuSnapshot.cores,
    effectiveCpus: Math.min(effectiveCpus, cpuSnapshot.cores || effectiveCpus),
    memoryTotalBytes: memory.totalBytes,
    memoryLimitBytes: cgroup?.memoryLimitBytes ?? null,
    memorySource: memory.source,
    containerized:
      (cgroup?.memoryLimitBytes ?? null) !== null || (cgroup?.effectiveCpus ?? null) !== null,
    cgroup,
    diskTotalBytes: statfs ? statfs.blockSizeBytes * statfs.totalBlocks : null,
  };
}

/** Cumulative counters carried between ticks so deltas can be computed. */
export interface SamplerState {
  readonly cpu: CpuSnapshot;
  readonly cgroupCpu: CgroupCpuSnapshot | null;
  readonly atMs: number;
}

/** Read the current counters without deriving any rate. */
export function readSamplerState(readers: HostReaders): SamplerState {
  return {
    cpu: aggregateCpuTimes(readers.cpus()),
    cgroupCpu: readCgroupCpuSnapshot(readers),
    atMs: readers.now(),
  };
}

/**
 * Take one sample.
 *
 * `previous` is null for the very first tick, which is why every rate field is
 * nullable: rates need two observations and inventing a value for the first
 * one would skew the summary.
 */
export function collectSample(
  readers: HostReaders,
  host: HostInfo,
  previous: SamplerState | null,
  diskPath: string,
): { sample: HostSample; state: SamplerState } {
  const state = readSamplerState(readers);
  const elapsedMs = previous ? Math.max(0, state.atMs - previous.atMs) : 0;
  const cpu = previous ? cpuUtilizationBetween(previous.cpu, state.cpu) : null;

  const memory = readMemory(readers);
  const cgroupMemoryCurrent = readCgroupMemoryCurrent(readers);
  const cgroupLimit = host.memoryLimitBytes;

  const cgroupCpuPct = computeCgroupCpuPct(previous, state, elapsedMs, host.effectiveCpus);
  const throttledPct = computeThrottledPct(previous, state, elapsedMs);

  const loadAvg1 = readers.loadavg()[0] ?? 0;
  const statfs = readers.statfs(diskPath);
  const diskFreeBytes = statfs ? statfs.blockSizeBytes * statfs.availableBlocks : null;

  return {
    state,
    sample: {
      timestamp: new Date(state.atMs).toISOString(),
      elapsedMs,
      cpuBusyPct: cpu ? cpu.busyPct : null,
      cpuUserPct: cpu ? cpu.userPct : null,
      cpuSysPct: cpu ? cpu.sysPct : null,
      memoryUsedBytes: memory.usedBytes,
      memoryAvailableBytes: memory.availableBytes,
      memoryUsedPct: memory.totalBytes > 0 ? toPct(memory.usedBytes / memory.totalBytes) : 0,
      swapUsedBytes: memory.swapUsedBytes,
      cgroupCpuPct,
      cgroupCpuThrottledPct: throttledPct,
      cgroupMemoryCurrentBytes: cgroupMemoryCurrent?.bytes ?? null,
      cgroupMemoryFromAncestor: cgroupMemoryCurrent?.fromAncestor ?? null,
      cgroupMemoryUsedPct:
        cgroupMemoryCurrent !== null && cgroupLimit !== null && cgroupLimit > 0
          ? toPct(cgroupMemoryCurrent.bytes / cgroupLimit)
          : null,
      loadAvg1,
      loadPerCore: host.effectiveCpus > 0 ? round(loadAvg1 / host.effectiveCpus, 3) : loadAvg1,
      cpuPressureSomeAvg10: readPressure(readers, 'cpu'),
      memoryPressureSomeAvg10: readPressure(readers, 'memory'),
      ioPressureSomeAvg10: readPressure(readers, 'io'),
      diskFreeBytes,
      // `df` semantics: the root-reserved pool (blocks - bfree - bavail) is
      // neither used nor available, so counting it as used would report ~95%
      // on an ext4 volume that df calls 90%.
      diskUsedPct: statfs
        ? diskUsedPct(statfs.totalBlocks, statfs.freeBlocks, statfs.availableBlocks)
        : null,
    },
  };
}

/** Used percent the way `df` reports it: used / (used + available). */
export function diskUsedPct(
  totalBlocks: number,
  freeBlocks: number,
  availableBlocks: number,
): number | null {
  const used = totalBlocks - freeBlocks;
  const denominator = used + availableBlocks;
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return toPct(used / denominator);
}

function readPressure(readers: HostReaders, resource: string): number | null {
  const raw = readers.readText(`/proc/pressure/${resource}`);
  if (raw === null) return null;
  return parsePressure(raw)?.someAvg10 ?? null;
}

function computeCgroupCpuPct(
  previous: SamplerState | null,
  state: SamplerState,
  elapsedMs: number,
  effectiveCpus: number,
): number | null {
  const before = previous?.cgroupCpu?.usageUsec;
  const after = state.cgroupCpu?.usageUsec;
  if (before === undefined || before === null || after === undefined || after === null) return null;
  if (elapsedMs <= 0 || effectiveCpus <= 0) return null;
  const usedUsec = Math.max(0, after - before);
  const capacityUsec = elapsedMs * 1000 * effectiveCpus;
  return capacityUsec > 0 ? toPct(usedUsec / capacityUsec) : null;
}

function computeThrottledPct(
  previous: SamplerState | null,
  state: SamplerState,
  elapsedMs: number,
): number | null {
  const before = previous?.cgroupCpu?.throttledUsec;
  const after = state.cgroupCpu?.throttledUsec;
  if (before === undefined || before === null || after === undefined || after === null) return null;
  if (elapsedMs <= 0) return null;
  return toPct(Math.max(0, after - before) / (elapsedMs * 1000));
}

/** min/max/mean/p95 for one gauge series, ignoring nulls. Null when empty. */
export function statsFor(values: ReadonlyArray<number | null>): SeriesStats | null {
  const present = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (present.length === 0) return null;
  const sorted = [...present].sort((a, b) => a - b);
  const sum = present.reduce((acc, value) => acc + value, 0);
  const index = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return {
    count: present.length,
    min: round(sorted[0] ?? 0, 2),
    max: round(sorted[sorted.length - 1] ?? 0, 2),
    mean: round(sum / present.length, 2),
    p95: round(sorted[Math.max(0, index)] ?? 0, 2),
  };
}

/** The gauge series summarized in a report, in display order. */
const SUMMARY_SERIES = [
  ['cpuBusyPct', (sample: HostSample) => sample.cpuBusyPct],
  ['cpuUserPct', (sample: HostSample) => sample.cpuUserPct],
  ['cpuSysPct', (sample: HostSample) => sample.cpuSysPct],
  ['memoryUsedPct', (sample: HostSample) => sample.memoryUsedPct],
  ['memoryUsedBytes', (sample: HostSample) => sample.memoryUsedBytes],
  ['memoryAvailableBytes', (sample: HostSample) => sample.memoryAvailableBytes],
  ['swapUsedBytes', (sample: HostSample) => sample.swapUsedBytes],
  ['cgroupCpuPct', (sample: HostSample) => sample.cgroupCpuPct],
  ['cgroupCpuThrottledPct', (sample: HostSample) => sample.cgroupCpuThrottledPct],
  ['cgroupMemoryUsedPct', (sample: HostSample) => sample.cgroupMemoryUsedPct],
  ['cgroupMemoryCurrentBytes', (sample: HostSample) => sample.cgroupMemoryCurrentBytes],
  ['loadPerCore', (sample: HostSample) => sample.loadPerCore],
  ['cpuPressureSomeAvg10', (sample: HostSample) => sample.cpuPressureSomeAvg10],
  ['memoryPressureSomeAvg10', (sample: HostSample) => sample.memoryPressureSomeAvg10],
  ['ioPressureSomeAvg10', (sample: HostSample) => sample.ioPressureSomeAvg10],
  ['diskUsedPct', (sample: HostSample) => sample.diskUsedPct],
] as const;

/** Summarize every gauge series present in the samples. */
export function summarizeSamples(samples: readonly HostSample[]): Record<string, SeriesStats> {
  const summary: Record<string, SeriesStats> = {};
  for (const [name, pick] of SUMMARY_SERIES) {
    const stats = statsFor(samples.map(pick));
    if (stats) summary[name] = stats;
  }
  return summary;
}

/**
 * Turn the summary into the headline verdict: did the job use what it was
 * given, and did anything cap it?
 */
export function computeHeadroom(summary: Record<string, SeriesStats>, host: HostInfo): Headroom {
  const cpuSeries = summary.cgroupCpuPct ?? summary.cpuBusyPct ?? null;
  const memoryLimitBytes = host.memoryLimitBytes ?? host.memoryTotalBytes;
  const memoryPeakBytes =
    summary.cgroupMemoryCurrentBytes?.max ?? summary.memoryUsedBytes?.max ?? null;
  const throttled = (summary.cgroupCpuThrottledPct?.max ?? 0) > 0;
  const notes: string[] = [];
  if (cpuSeries && cpuSeries.mean < 40) {
    notes.push(
      `Mean CPU ${cpuSeries.mean}% of ${host.effectiveCpus} effective core(s) — likely serialized work, not CPU-bound.`,
    );
  }
  if (cpuSeries && cpuSeries.max >= 95) {
    notes.push('CPU saturated at peak — more cores would likely help.');
  }
  if (throttled) notes.push('cgroup CPU throttling observed — the quota is the ceiling.');
  if (memoryPeakBytes !== null && memoryLimitBytes > 0) {
    const pct = toPct(memoryPeakBytes / memoryLimitBytes);
    if (pct >= 90) notes.push(`Peak memory ${pct}% of the limit — close to OOM.`);
    else if (pct < 40)
      notes.push(`Peak memory only ${pct}% of the limit — memory headroom is unused.`);
  }
  if ((summary.memoryPressureSomeAvg10?.max ?? 0) > 10) {
    notes.push('Memory pressure stalls observed (PSI) — the box is reclaiming under load.');
  }
  return {
    peakCpuPct: cpuSeries?.max ?? null,
    meanCpuPct: cpuSeries?.mean ?? null,
    peakMemoryUsedBytes: memoryPeakBytes,
    memoryLimitBytes: memoryLimitBytes > 0 ? memoryLimitBytes : null,
    peakMemoryUsedPct:
      memoryPeakBytes !== null && memoryLimitBytes > 0
        ? toPct(memoryPeakBytes / memoryLimitBytes)
        : null,
    cpuThrottled: throttled,
    notes,
  };
}

/** Build the final report document from collected samples. */
export function buildReport(input: {
  startedAt: string;
  endedAt: string;
  intervalMs: number;
  context: RunContext;
  host: HostInfo;
  samples: readonly HostSample[];
}): HostReport {
  const summary = summarizeSamples(input.samples);
  const durationMs = Date.parse(input.endedAt) - Date.parse(input.startedAt);
  return {
    schemaVersion: HOST_TELEMETRY_SCHEMA_VERSION,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationSec: Number.isFinite(durationMs) ? round(Math.max(0, durationMs) / 1000, 1) : 0,
    sampleCount: input.samples.length,
    intervalMs: input.intervalMs,
    context: input.context,
    host: input.host,
    summary,
    headroom: computeHeadroom(summary, input.host),
    samples: input.samples,
  };
}

/** Read the run/session context out of the environment. */
export function readRunContext(readers: HostReaders, label: string): RunContext {
  const value = (name: string): string | null => readers.env(name) ?? null;
  return {
    label,
    githubRunId: value('GITHUB_RUN_ID'),
    githubRunAttempt: value('GITHUB_RUN_ATTEMPT'),
    githubJob: value('GITHUB_JOB'),
    githubWorkflow: value('GITHUB_WORKFLOW'),
    runnerOs: value('RUNNER_OS'),
    runnerArch: value('RUNNER_ARCH'),
    ci: value('CI') === 'true',
  };
}

/** Human-readable byte size (GiB/MiB), for summaries. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return 'n/a';
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) return `${round(gib, 2)} GiB`;
  return `${round(bytes / (1024 * 1024), 1)} MiB`;
}

/** One-line console headline: what the box is, and how hard it is working. */
export function formatHeadline(report: HostReport): string {
  const { host, headroom } = report;
  const cores =
    host.effectiveCpus === host.cpuCount
      ? `${host.cpuCount} cpu`
      : `${host.effectiveCpus}/${host.cpuCount} cpu`;
  const memory = `${formatBytes(headroom.peakMemoryUsedBytes)}/${formatBytes(
    headroom.memoryLimitBytes,
  )} mem used`;
  return (
    `host: ${cores} · ${memory} · peak cpu ${fmtPct(headroom.peakCpuPct)}` +
    ` · mean cpu ${fmtPct(headroom.meanCpuPct)}` +
    (headroom.cpuThrottled ? ' · CPU THROTTLED' : '') +
    (host.containerized ? ' · containerized' : '')
  );
}

/** GitHub step-summary / PR-friendly markdown for a report. */
export function formatMarkdownSummary(report: HostReport): string {
  const { host, headroom, summary, context } = report;
  const lines: string[] = [];
  lines.push(`### Host resource profile — ${context.label}`);
  lines.push('');
  lines.push(
    `\`${host.platform}/${host.arch}\` · ${host.cpuCount} core(s)` +
      (host.effectiveCpus !== host.cpuCount ? ` (${host.effectiveCpus} effective)` : '') +
      ` · ${formatBytes(host.memoryLimitBytes ?? host.memoryTotalBytes)} memory` +
      (host.containerized ? ' · containerized' : '') +
      ` · ${report.sampleCount} sample(s) over ${report.durationSec}s`,
  );
  lines.push('');
  lines.push('| Metric | Min | Mean | p95 | Max |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const [name, stats] of Object.entries(summary)) {
    if (name.endsWith('Bytes')) {
      lines.push(
        `| ${name} | ${formatBytes(stats.min)} | ${formatBytes(stats.mean)} | ${formatBytes(stats.p95)} | ${formatBytes(stats.max)} |`,
      );
    } else {
      lines.push(`| ${name} | ${stats.min} | ${stats.mean} | ${stats.p95} | ${stats.max} |`);
    }
  }
  lines.push('');
  lines.push(
    `**Headroom** — peak CPU ${fmtPct(headroom.peakCpuPct)}, mean CPU ${fmtPct(headroom.meanCpuPct)}, ` +
      `peak memory ${formatBytes(headroom.peakMemoryUsedBytes)} of ${formatBytes(headroom.memoryLimitBytes)} ` +
      `(${fmtPct(headroom.peakMemoryUsedPct)})${headroom.cpuThrottled ? ', CPU throttled' : ''}.`,
  );
  for (const note of headroom.notes) lines.push(`- ${note}`);
  if (report.samples.some((sample) => sample.cgroupMemoryFromAncestor === true)) {
    lines.push(
      '- cgroup memory was read from an ancestor cgroup (namespaced view): it may include sibling workloads.',
    );
  }
  if (!summary.cpuBusyPct && !summary.cgroupCpuPct) {
    lines.push('- No CPU rate observed: a rate needs two counter reads over a non-zero interval.');
  }
  return `${lines.join('\n')}\n`;
}

function fmtPct(value: number | null): string {
  return value === null ? 'n/a' : `${value}%`;
}

function toPct(ratio: number): number {
  return round(Math.max(0, ratio) * 100, 2);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
