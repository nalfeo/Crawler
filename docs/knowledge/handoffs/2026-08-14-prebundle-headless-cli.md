# Handoff — Pre-bundle the headless AI runner CLI

Date: 2026-08-14
Apples: 2🍎 (tooling-only, gameplay-neutral by construction)

## Systems touched

perf-tooling

## What changed

`npm run ai:headless` no longer starts through `tsx`. It now runs
`scripts/agent/perf/headless-bundle.mjs`, which bundles
`src/game/ai/headless-runner-cli.ts` with esbuild into `files/` (gitignored)
and then runs that bundle on node. `npm run ai:headless:tsx` keeps the old
loader as an escape hatch.

## Why

Profiling the headless runner (`npm run perf:profile`, seeds 1-3 × sword)
showed **no dominant simulation hotspot remains** — earlier perf passes already
killed FOV, `planObjectiveRoute`, `applyEffectiveStats`, and rot-js A\*. The top
self-time frame in the profile was `runCallSync` (esbuild) at 7.43%, and
node/tsx/esbuild startup accounted for ~14.5% of the profile.

Wall-clock decomposition confirmed a fixed ~4.0s intercept before frame one:

| run              | wall  |
| ---------------- | ----- |
| `--max-frames 1` | ~3.9s |
| 2000 frames      | ~5.2s |
| 6000 frames      | ~7.2s |
| full seed 1      | ~16s  |

Bundling collapses startup to ~1.3s. The bundle itself costs ~85ms to build,
so it is rebuilt unconditionally — a stale bundle would silently run old game
code, which is a much worse failure than 85ms.

## Observe before done

This is a launcher change, not a simulation change, so the evidence is
input/output equivalence of the **real headless pipeline artifact**, not a lab:

- Full stdout for seeds 1/2/3, tsx vs bundled, timing fields masked:
  **byte-identical** (VICTORY; 14780/14654/14854 frames; 801 gold on seed 1).
- Exit-code parity: `--help` → 0 both; non-victory → 1 both.
- Interleaved paired timings (6 rounds): 1.33x, 1.25x, 1.32x, 1.23x, 1.05x,
  1.14x — **every round favours the bundle**, median ~1.24x.

## Scope / non-goals

- Sweeps (`winrate-sweep`, `sweep-eval`, `sim-fingerprint`) use `runWorkerPool`
  worker threads that import `runHeadless` directly, so they never went through
  `ai:headless` and are **not** sped up by this.
- The released game is already bundled by `vite build` and never paid this cost.
- Reusing one process across many runs would save more, but was deliberately
  **not** attempted: it would require proving `runHeadless` has zero cross-run
  state leakage.

## Follow-ups

- `.github/skills/perf-optimizer/references/hunting-grounds.md` still lists a
  seeded profile table whose top entry (`compute`/FOV at 21.52%) no longer
  reflects reality now that FOV is cached.
- Real in-browser game load time is genuinely unmeasured; `perf:profile` is
  simulation-only. A Chrome DevTools trace would be needed.
