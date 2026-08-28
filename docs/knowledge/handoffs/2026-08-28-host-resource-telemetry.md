# Handoff: Host resource profiling telemetry

## Date

2026-08-28

## Persona

DevOps Engineer

## Systems touched

ci-policy, docs-tooling

## Apples

3🍎 estimated / 3🍎 actual — exact. Tooling-only cap: one sampling library, a
CLI, a composite action, three CI wiring sites, and the review harness.

## Outcome

Closes #3800. Cloud sessions and GitHub-hosted runners can now report what they
are actually doing with the machine they were given, instead of being blind.

- `npm run host:profile` samples CPU (busy/user/sys), memory (used/available via
  MemAvailable, swap), load per core, PSI pressure, and disk usage, then prints a
  min/mean/max table plus a headroom verdict.
- The **host view and the cgroup view are reported separately**. Inside a
  container `os.cpus()` / `os.totalmem()` describe the physical host, so a
  quota-capped job looks idle while it is being throttled. cgroup CPU% is derived
  from `cpu.stat` usage deltas normalized by effective CPUs, with throttling
  counters alongside, and cgroup v1 counters are normalized into the same shape.
- `.github/actions/host-profile` brackets `test-unit`, `test-headless`, and
  `test-e2e-game`; the report step appends the summary to the job summary and
  uploads the raw JSON. Telemetry never fails a job — every failure path degrades
  to a warning.
- `scripts/agent/preflight.sh` phase 7 writes a one-shot session-start snapshot
  to the gitignored `files/` directory.

## Design decisions worth keeping

- **Rates need two observations.** The first read only primes cumulative
  counters, so it is never emitted; `--once` takes two reads 300ms apart.
- **Stop is a file, not a signal.** Signals do not reach a `tsx` process through
  the npm wrapper (verified empirically), so CI touches `files/host-profile.stop`,
  which the sampler polls every 500ms independently of the sampling interval — a
  job shorter than one interval still records a sample.
- **JSONL first, report second.** Every sample is appended to a sidecar as it is
  taken, and `--from-jsonl` rebuilds the report from it. A job killed by timeout
  or cancellation still yields a partial profile.
- **cgroup limits take the tightest value up the chain; usage prefers the leaf.**
  A leaf-only usage read is not viable: under a cgroup namespace the path in
  /proc/self/cgroup does not exist inside the mounted view, so telemetry would
  vanish exactly where it matters. The deepest visible directory is used and
  flagged with `cgroupMemoryFromAncestor`, and the report states the caveat.
- **Disk uses `df` semantics** (`used / (used + available)`), so ext4's 5%
  root-reserved pool does not inflate used%.
- **Privacy:** no hostname, no runner name, no process command lines — only
  hardware shape, limits, utilization, and GitHub run/job identifiers.

## Known scope limits

- The sampler runs through `tsx`, so `start` must come after `npm ci`; the
  dependency-install phase is outside the profiled window.
- `--interval` shorter than 200ms is coerced by the minimum-interval guard,
  because a sub-interval CPU delta is noise.

## Review harness

Ledger: `docs/knowledge/review-ledgers/2026-08-28-host-resource-telemetry.review-ledger.json`

- Plan review (`gpt-5.6-sol`): 10 concerns, all resolved; `plan_divergence: minor`.
- Code review (`claude-opus-4.6`): round 1 found three real accounting defects
  (disk used% double-counting reserved blocks, cgroup v1 CPU silently dropped,
  ancestor cgroup memory read silently); round 2 clean.
- Independent grade (`gpt-5.5`): the first grade surfaced two further real bugs
  (rebuilt reports lost the first interval; the report step ignored a custom
  interval) and the regrade surfaced the stop-latency gap above. All fixed.

## Next

Once a few CI runs have published summaries, read the headroom lines across
`test-unit` / `test-headless` / `test-e2e-game` to decide whether to raise
parallelism or move to a larger runner. That decision needs data this PR only
just started collecting — do not pre-tune on the session-start snapshot alone.
