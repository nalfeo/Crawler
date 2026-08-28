import { describe, expect, it } from 'vitest';

import {
  aggregateCpuTimes,
  buildReport,
  cgroupPathsFromProc,
  collectHostInfo,
  collectSample,
  computeHeadroom,
  cpuUtilizationBetween,
  formatBytes,
  formatHeadline,
  formatMarkdownSummary,
  HOST_TELEMETRY_SCHEMA_VERSION,
  memoryFromOs,
  memoryFromProcMeminfo,
  parseCgroupCpuMax,
  parseCgroupCpuStat,
  parseCgroupMemoryMax,
  parseCgroupV1CpuQuota,
  parseCgroupV1MemoryLimit,
  parseCpusetList,
  parseProcMeminfo,
  parsePressure,
  readCgroupLimits,
  readCgroupMemoryCurrent,
  readCgroupV1CpuSnapshot,
  diskUsedPct,
  statsFor,
  summarizeSamples,
  type HostReaders,
  type HostSample,
} from '../../scripts/agent/perf/host-resources-lib.js';
import {
  parseArgs,
  readSamplesFromJsonl,
  rebuiltStartedAt,
} from '../../scripts/agent/perf/host-resources.js';

const GIB = 1024 * 1024 * 1024;

/** A fully-fake host, so every assertion is deterministic. */
function makeReaders(overrides: Partial<HostReaders> & { files?: Record<string, string> } = {}) {
  const files = overrides.files ?? {};
  let now = 1_000_000;
  const readers: HostReaders = {
    readText: (path) => files[path] ?? null,
    cpus: () => [
      { model: 'Fake CPU', times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
      { model: 'Fake CPU', times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
    ],
    totalmem: () => 8 * GIB,
    freemem: () => 4 * GIB,
    loadavg: () => [1, 1, 1],
    platform: () => 'linux',
    arch: () => 'x64',
    statfs: () => ({
      blockSizeBytes: 4096,
      totalBlocks: 1000,
      freeBlocks: 300,
      availableBlocks: 250,
    }),
    now: () => {
      now += 1000;
      return now;
    },
    env: () => undefined,
    ...overrides,
  };
  return readers;
}

describe('CPU accounting', () => {
  it('sums per-core counters into one host snapshot', () => {
    const snapshot = aggregateCpuTimes([
      { model: 'A', times: { user: 1, nice: 2, sys: 3, idle: 4, irq: 5 } },
      { model: 'A', times: { user: 10, nice: 20, sys: 30, idle: 40, irq: 50 } },
    ]);
    expect(snapshot.cores).toBe(2);
    expect(snapshot.model).toBe('A');
    expect(snapshot.times).toEqual({ user: 11, nice: 22, sys: 33, idle: 44, irq: 55 });
  });

  it('derives busy/idle percentages from two snapshots', () => {
    const previous = aggregateCpuTimes([
      { model: 'A', times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    ]);
    const next = aggregateCpuTimes([
      { model: 'A', times: { user: 60, nice: 0, sys: 15, idle: 25, irq: 0 } },
    ]);
    expect(cpuUtilizationBetween(previous, next)).toEqual({
      busyPct: 75,
      userPct: 60,
      sysPct: 15,
      idlePct: 25,
    });
  });

  it('returns null rather than a fabricated 0% when no time elapsed', () => {
    const snapshot = aggregateCpuTimes([
      { model: 'A', times: { user: 1, nice: 1, sys: 1, idle: 1, irq: 1 } },
    ]);
    expect(cpuUtilizationBetween(snapshot, snapshot)).toBeNull();
  });
});

describe('memory accounting', () => {
  const MEMINFO = [
    'MemTotal:       16384000 kB',
    'MemFree:          512000 kB',
    'MemAvailable:   12288000 kB',
    'Buffers:          100000 kB',
    'Cached:          8000000 kB',
    'SwapTotal:       4096000 kB',
    'SwapFree:        3096000 kB',
  ].join('\n');

  it('parses kB lines into bytes', () => {
    const parsed = parseProcMeminfo(MEMINFO);
    expect(parsed.MemTotal).toBe(16384000 * 1024);
    expect(parsed.SwapFree).toBe(3096000 * 1024);
  });

  it('prefers MemAvailable over MemFree for "available"', () => {
    const memory = memoryFromProcMeminfo(MEMINFO);
    expect(memory?.availableBytes).toBe(12288000 * 1024);
    expect(memory?.usedBytes).toBe((16384000 - 12288000) * 1024);
    expect(memory?.swapUsedBytes).toBe((4096000 - 3096000) * 1024);
    expect(memory?.source).toBe('proc');
  });

  it('falls back to free+buffers+cached when the kernel omits MemAvailable', () => {
    const memory = memoryFromProcMeminfo(
      ['MemTotal: 1000 kB', 'MemFree: 100 kB', 'Buffers: 50 kB', 'Cached: 200 kB'].join('\n'),
    );
    expect(memory?.availableBytes).toBe(350 * 1024);
  });

  it('returns null for a document without MemTotal', () => {
    expect(memoryFromProcMeminfo('garbage\nMemFree: 10 kB')).toBeNull();
  });

  it('falls back to the os numbers off Linux', () => {
    const memory = memoryFromOs(8 * GIB, 2 * GIB);
    expect(memory).toMatchObject({ usedBytes: 6 * GIB, availableBytes: 2 * GIB, source: 'os' });
  });
});

describe('cgroup discovery', () => {
  it('walks a nested cgroup v2 path from leaf to root', () => {
    const { version, memoryDirs } = cgroupPathsFromProc('0::/actions_job/abc123\n');
    expect(version).toBe('v2');
    expect(memoryDirs).toEqual([
      '/sys/fs/cgroup/actions_job/abc123',
      '/sys/fs/cgroup/actions_job',
      '/sys/fs/cgroup',
    ]);
  });

  it('resolves per-controller paths for cgroup v1', () => {
    const { version, memoryDirs, cpuDirs } = cgroupPathsFromProc(
      ['9:memory:/docker/deadbeef', '4:cpu,cpuacct:/docker/deadbeef'].join('\n'),
    );
    expect(version).toBe('v1');
    expect(memoryDirs[0]).toBe('/sys/fs/cgroup/memory/docker/deadbeef');
    expect(cpuDirs[0]).toBe('/sys/fs/cgroup/cpu/docker/deadbeef');
  });

  it('treats v2 "max" and junk as unlimited', () => {
    expect(parseCgroupMemoryMax('max\n')).toBeNull();
    expect(parseCgroupMemoryMax('')).toBeNull();
    expect(parseCgroupMemoryMax('not-a-number')).toBeNull();
    expect(parseCgroupMemoryMax('2147483648\n')).toBe(2147483648);
  });

  it('treats a v1 sentinel at or above host memory as unlimited', () => {
    expect(parseCgroupV1MemoryLimit('9223372036854771712\n', 8 * GIB)).toBeNull();
    expect(parseCgroupV1MemoryLimit(`${8 * GIB}`, 8 * GIB)).toBeNull();
    expect(parseCgroupV1MemoryLimit(`${2 * GIB}`, 8 * GIB)).toBe(2 * GIB);
  });

  it('converts cpu quotas into effective (possibly fractional) CPUs', () => {
    expect(parseCgroupCpuMax('max 100000')).toBeNull();
    expect(parseCgroupCpuMax('200000 100000')).toBe(2);
    expect(parseCgroupCpuMax('50000 100000')).toBe(0.5);
    expect(parseCgroupCpuMax('100000 0')).toBeNull();
    expect(parseCgroupV1CpuQuota('-1', '100000')).toBeNull();
    expect(parseCgroupV1CpuQuota('150000', '100000')).toBe(1.5);
  });

  it('counts cpuset lists including ranges', () => {
    expect(parseCpusetList('0-3,8,10-11')).toBe(7);
    expect(parseCpusetList('2')).toBe(1);
    expect(parseCpusetList('')).toBeNull();
    expect(parseCpusetList('junk')).toBeNull();
  });

  it('picks the tightest limit anywhere on the cgroup chain', () => {
    const readers = makeReaders({
      files: {
        '/proc/self/cgroup': '0::/actions_job/abc',
        // Leaf says unlimited; the parent is what actually caps this process.
        '/sys/fs/cgroup/actions_job/abc/memory.max': 'max',
        '/sys/fs/cgroup/actions_job/memory.max': `${2 * GIB}`,
        '/sys/fs/cgroup/memory.max': `${6 * GIB}`,
        '/sys/fs/cgroup/actions_job/abc/cpu.max': '400000 100000',
        '/sys/fs/cgroup/actions_job/cpu.max': '150000 100000',
      },
    });
    expect(readCgroupLimits(readers, 8 * GIB)).toEqual({
      version: 'v2',
      memoryLimitBytes: 2 * GIB,
      effectiveCpus: 1.5,
    });
  });

  it('reports no cgroup at all when /proc/self/cgroup is missing', () => {
    expect(readCgroupLimits(makeReaders(), 8 * GIB)).toBeNull();
  });

  it('parses cpu.stat counters and tolerates missing keys', () => {
    const stat = parseCgroupCpuStat(
      ['usage_usec 12345', 'user_usec 10000', 'nr_throttled 3', 'throttled_usec 900'].join('\n'),
    );
    expect(stat).toEqual({
      usageUsec: 12345,
      userUsec: 10000,
      systemUsec: null,
      nrThrottled: 3,
      throttledUsec: 900,
    });
  });
});

describe('cgroup usage counters', () => {
  it('normalizes cgroup v1 cpuacct counters into the v2 microsecond shape', () => {
    const snapshot = readCgroupV1CpuSnapshot(
      ['2500000000\n'],
      ['user 120\nsystem 30\n'],
      ['nr_throttled 7\nthrottled_time 4000000\n'],
    );
    expect(snapshot).toEqual({
      usageUsec: 2_500_000,
      userUsec: 1_200_000,
      systemUsec: 300_000,
      nrThrottled: 7,
      throttledUsec: 4000,
    });
  });

  it('reports no v1 cpu snapshot when the controller files are all absent', () => {
    expect(readCgroupV1CpuSnapshot([null], [null], [null])).toBeNull();
  });

  it('prefers the leaf memory charge and flags an ancestor reading', () => {
    const withLeaf = makeReaders({
      files: {
        '/proc/self/cgroup': '0::/actions_job/abc',
        '/sys/fs/cgroup/actions_job/abc/memory.current': `${GIB}`,
        '/sys/fs/cgroup/actions_job/memory.current': `${5 * GIB}`,
      },
    });
    expect(readCgroupMemoryCurrent(withLeaf)).toEqual({ bytes: GIB, fromAncestor: false });

    // Under a cgroup namespace the leaf path is invisible; the deepest visible
    // directory is used but flagged, because it also counts sibling workloads.
    const leafUnreadable = makeReaders({
      files: {
        '/proc/self/cgroup': '0::/actions_job/abc',
        '/sys/fs/cgroup/actions_job/memory.current': `${5 * GIB}`,
      },
    });
    expect(readCgroupMemoryCurrent(leafUnreadable)).toEqual({
      bytes: 5 * GIB,
      fromAncestor: true,
    });

    expect(readCgroupMemoryCurrent(makeReaders())).toBeNull();
  });
});

describe('disk accounting', () => {
  it('excludes the root-reserved pool from both used and available', () => {
    // 1000 total, 300 free, 250 available -> df reports 700/950 = 73.68%.
    expect(diskUsedPct(1000, 300, 250)).toBe(73.68);
    expect(diskUsedPct(0, 0, 0)).toBeNull();
  });
});

describe('pressure stall parsing', () => {
  it('reads the some/full avg10 values', () => {
    const parsed = parsePressure(
      ['some avg10=12.34 avg60=1.00 avg300=0.00 total=999', 'full avg10=5.00 total=10'].join('\n'),
    );
    expect(parsed).toEqual({ someAvg10: 12.34, fullAvg10: 5 });
  });

  it('returns null when PSI is unavailable or malformed', () => {
    expect(parsePressure('')).toBeNull();
    expect(parsePressure('some avg60=1.0')).toBeNull();
  });
});

describe('summaries and headroom', () => {
  it('ignores nulls and computes min/mean/p95/max', () => {
    expect(statsFor([10, null, 20, 30, 40])).toEqual({
      count: 4,
      min: 10,
      max: 40,
      mean: 25,
      p95: 40,
    });
    expect(statsFor([null, null])).toBeNull();
  });

  it('omits series that never produced a value', () => {
    const sample = baseSample({ cgroupCpuPct: null, cpuBusyPct: 50 });
    const summary = summarizeSamples([sample]);
    expect(summary.cpuBusyPct).toBeDefined();
    expect(summary.cgroupCpuPct).toBeUndefined();
  });

  it('flags unused headroom and throttling', () => {
    const samples = [
      baseSample({ cgroupCpuPct: 5, cgroupCpuThrottledPct: 0, memoryUsedBytes: GIB }),
      baseSample({ cgroupCpuPct: 9, cgroupCpuThrottledPct: 4, memoryUsedBytes: 2 * GIB }),
    ];
    const host = collectHostInfo(makeReaders(), '/');
    const headroom = computeHeadroom(summarizeSamples(samples), host);
    expect(headroom.cpuThrottled).toBe(true);
    expect(headroom.peakCpuPct).toBe(9);
    expect(headroom.notes.some((note) => note.includes('serialized work'))).toBe(true);
    expect(headroom.notes.some((note) => note.includes('throttling'))).toBe(true);
    expect(headroom.notes.some((note) => note.includes('headroom is unused'))).toBe(true);
  });

  it('warns when memory is close to the limit', () => {
    const host = collectHostInfo(makeReaders(), '/');
    const headroom = computeHeadroom(
      summarizeSamples([baseSample({ memoryUsedBytes: 7.9 * GIB, cpuBusyPct: 99 })]),
      host,
    );
    expect(headroom.notes.some((note) => note.includes('close to OOM'))).toBe(true);
    expect(headroom.notes.some((note) => note.includes('saturated'))).toBe(true);
  });
});

describe('report assembly and formatting', () => {
  const report = buildReport({
    startedAt: '2026-08-28T00:00:00.000Z',
    endedAt: '2026-08-28T00:01:00.000Z',
    intervalMs: 5000,
    context: {
      label: 'unit',
      githubRunId: '42',
      githubRunAttempt: '1',
      githubJob: 'test-unit',
      githubWorkflow: 'CI',
      runnerOs: 'Linux',
      runnerArch: 'X64',
      ci: true,
    },
    host: collectHostInfo(makeReaders(), '/'),
    samples: [baseSample({ cpuBusyPct: 20 }), baseSample({ cpuBusyPct: 80 })],
  });

  it('stamps the schema version and duration', () => {
    expect(report.schemaVersion).toBe(HOST_TELEMETRY_SCHEMA_VERSION);
    expect(report.durationSec).toBe(60);
    expect(report.sampleCount).toBe(2);
  });

  it('renders a markdown table with a headroom verdict', () => {
    const markdown = formatMarkdownSummary(report);
    expect(markdown).toContain('### Host resource profile — unit');
    expect(markdown).toContain('| cpuBusyPct |');
    expect(markdown).toContain('**Headroom**');
  });

  it('notes when no CPU rate could be observed', () => {
    const empty = buildReport({
      startedAt: '2026-08-28T00:00:00.000Z',
      endedAt: '2026-08-28T00:00:00.000Z',
      intervalMs: 5000,
      context: report.context,
      host: report.host,
      samples: [baseSample({ cpuBusyPct: null, cgroupCpuPct: null })],
    });
    expect(formatMarkdownSummary(empty)).toContain('No CPU rate observed');
  });

  it('renders a one-line headline', () => {
    expect(formatHeadline(report)).toContain('peak cpu 80%');
  });

  it('formats bytes at GiB/MiB scale', () => {
    expect(formatBytes(2 * GIB)).toBe('2 GiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MiB');
    expect(formatBytes(null)).toBe('n/a');
  });
});

describe('sampling', () => {
  it('produces no rate on the priming read and a rate on the next one', () => {
    const readers = makeReaders({
      files: { '/proc/pressure/cpu': 'some avg10=1.00 total=1' },
    });
    const host = collectHostInfo(readers, '/');
    const first = collectSample(readers, host, null, '/');
    expect(first.sample.cpuBusyPct).toBeNull();
    expect(first.sample.elapsedMs).toBe(0);

    const second = collectSample(readers, host, first.state, '/');
    expect(second.sample.elapsedMs).toBeGreaterThan(0);
    expect(second.sample.cpuPressureSomeAvg10).toBe(1);
    // The fake CPU counters never move, so the rate is legitimately null.
    expect(second.sample.cpuBusyPct).toBeNull();
    // df semantics: used=700 blocks, available=250 -> 700/950, NOT 750/1000.
    expect(second.sample.diskUsedPct).toBe(73.68);
  });

  it('caps effective CPUs at the host core count', () => {
    const host = collectHostInfo(makeReaders(), '/');
    expect(host.cpuCount).toBe(2);
    expect(host.effectiveCpus).toBe(2);
    expect(host.containerized).toBe(false);
    expect(host.diskTotalBytes).toBe(4096 * 1000);
  });
});

describe('CLI argument parsing', () => {
  it('defaults the JSONL sidecar next to the report', () => {
    const options = parseArgs(['--out', 'files/foo.json']);
    expect(options.jsonl).toBe('files/foo.samples.jsonl');
    expect(options.intervalMs).toBe(5000);
    expect(options.durationSec).toBeNull();
  });

  it('accepts the full flag surface', () => {
    const options = parseArgs([
      '--once',
      '--interval',
      '1000',
      '--duration',
      '30',
      '--label',
      'e2e',
      '--markdown',
      'files/out.md',
      '--step-summary',
      '--stop-file',
      'files/stop',
      '--headline',
      '--quiet',
      '--from-jsonl',
    ]);
    expect(options).toMatchObject({
      once: true,
      intervalMs: 1000,
      durationSec: 30,
      label: 'e2e',
      markdown: 'files/out.md',
      stepSummary: true,
      stopFile: 'files/stop',
      headline: true,
      quiet: true,
      fromJsonl: true,
    });
  });

  it('rejects invalid input instead of silently sampling wrong', () => {
    expect(() => parseArgs(['--interval'])).toThrow('--interval requires a value');
    expect(() => parseArgs(['--interval', '10'])).toThrow('--interval requires a number');
    expect(() => parseArgs(['--duration', 'soon'])).toThrow('--duration requires a number');
    expect(() => parseArgs(['--nope'])).toThrow('Unknown argument: --nope');
  });
});

describe('JSONL recovery', () => {
  it('keeps every complete sample and drops a truncated final line', () => {
    const sample = baseSample({ cpuBusyPct: 12 });
    const text = `${JSON.stringify(sample)}\n\n${JSON.stringify(sample).slice(0, 20)}`;
    const recovered = readSamplesFromJsonl(text);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.cpuBusyPct).toBe(12);
  });

  it('returns nothing for an empty sidecar', () => {
    expect(readSamplesFromJsonl('')).toEqual([]);
  });

  it('recovers the start time one interval before the first sample', () => {
    // Sample timestamps mark the end of their interval, so a rebuilt report
    // that started at the first sample would lose that interval entirely and
    // call a single-sample profile zero seconds long.
    const samples = [
      baseSample({ timestamp: '2026-08-28T00:00:05.000Z', elapsedMs: 5000 }),
      baseSample({ timestamp: '2026-08-28T00:00:10.000Z', elapsedMs: 5000 }),
    ];
    expect(rebuiltStartedAt(samples)).toBe('2026-08-28T00:00:00.000Z');
    expect(rebuiltStartedAt([])).toBeNull();
    expect(rebuiltStartedAt([baseSample({ timestamp: 'not-a-time' })])).toBeNull();
  });
});

/** A sample with every field defaulted, so tests only state what they mean. */
function baseSample(overrides: Partial<HostSample> = {}): HostSample {
  return {
    timestamp: '2026-08-28T00:00:00.000Z',
    elapsedMs: 5000,
    cpuBusyPct: 10,
    cpuUserPct: 5,
    cpuSysPct: 5,
    memoryUsedBytes: GIB,
    memoryAvailableBytes: 7 * GIB,
    memoryUsedPct: 12.5,
    swapUsedBytes: 0,
    cgroupCpuPct: null,
    cgroupCpuThrottledPct: null,
    cgroupMemoryCurrentBytes: null,
    cgroupMemoryFromAncestor: null,
    cgroupMemoryUsedPct: null,
    loadAvg1: 1,
    loadPerCore: 0.5,
    cpuPressureSomeAvg10: null,
    memoryPressureSomeAvg10: null,
    ioPressureSomeAvg10: null,
    diskFreeBytes: null,
    diskUsedPct: null,
    ...overrides,
  };
}
