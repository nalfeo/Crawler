# Handoff: 2026-07-25 Nightly Balance Sweep #1998 — Terminal No-PR (Stale Baseline)

## Summary

Executed the nightly telemetry-driven balance improvement sweep per issue #1998. Reached the **stale-baseline hard gate** and stopped. No implementation PR was produced. Issue #1998 was closed.

## Systems touched

ai, balance

## What was done

1. Ran preflight.
2. Retrieved all `weapon-sweep.yml` runs on `main` branch from GitHub Actions.
3. Identified the most recent successful main-branch sweep: **Run ID 29507839303**, SHA `b61c1bc7feb494cc195efabeee894ff328d5b3bc`, completed 2026-07-16T14:47:06Z.
4. Verified all 6 FINAL aggregate artifacts were present in that run:
   - `weapon-sweep-sword` (ID 8379383717)
   - `weapon-sweep-bow` (ID 8379383505)
   - `weapon-sweep-baseball-bat` (ID 8379384395)
   - `weapon-sweep-pistol` (ID 8379385774)
   - `weapon-sweep-throwing-knife` (ID 8379382290)
   - `weapon-sweep-fireball` (ID 8379384485)
5. Checked current main HEAD: **d16944b2** (2026-07-25T09:18:42Z).
6. Found **283 commits** between baseline sweep SHA and current main HEAD.
7. Identified multiple gameplay-touching commits in that range (Floor 2 content, AI routing, reward UX, terrain, perf).
8. Per issue hard gate: "gameplay commits after [baseline sweep] require fresh canonical GitHub Actions sweep" → **STOP. Stale baseline.**
9. Created durable ledger at `docs/knowledge/metrics/2026-07-25-nightly-balance-sweep-1998.json`.
10. Closed issue #1998 via this PR.

## Why stopped

The stale-baseline hard gate was triggered. The most recent weapon-sweep.yml on `main` was run against SHA `b61c1bc7feb4` (2026-07-16), but current main HEAD is 9 days and 283 commits newer, with gameplay changes including:
- `feat: Floor 2 industrial-cave harvestables, ambient lighting, and props (#1911)`
- `feat(ai): deterministic settlement return routing (#1873)`
- `perf(core): reuse scratch buffers in applyEffectiveStats hot path (#1973)`
- `feat(engine): add particle effects to reward unlock sequence (#1910)`
- Several more terrain, audio, and AI commits

A fresh canonical `weapon-sweep.yml` dispatch against current main HEAD is required before any balance candidate analysis can be performed.

## Next steps for the nightly runner

The next nightly sweep issue (filed against a later SHA) will automatically check for a fresh baseline at that time. If a canonical sweep has been run against current main by then, it can proceed past the baseline gate and perform candidate analysis.

## Ledger

Durable ledger: `docs/knowledge/metrics/2026-07-25-nightly-balance-sweep-1998.json`

| Rank | Name | Verdict | Rationale |
|------|------|---------|-----------|
| 1 | BLOCKED: Stale baseline gate | BLOCKED | Baseline SHA b61c1bc7feb4 (2026-07-16) ≠ current main HEAD d16944b2 (2026-07-25); 283 commits including gameplay changes. Fresh canonical sweep required. |

## Apple estimate

🍎 (1 apple) — investigation only, no code changes, no review harness required.
