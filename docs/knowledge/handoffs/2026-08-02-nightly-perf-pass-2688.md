# Handoff: nightly perf-optimizer pass (issue #2688) — no safe code change

**Date:** 2026-08-02  
**Issue:** `nalfeo/Crawler#2688`  
**Persona:** perf-optimizer  
**Apples:** 3🍎 estimated, 1🍎 actual (📈 Over)

## Systems touched

ai-behavior-tree, mapgen

## Summary

Ran the nightly gameplay-neutral perf loop for #2688 and measured current
hotspots before any code change. No candidate in this session had enough
signal-to-noise and safety evidence to justify landing a source optimization,
so this pass intentionally ships **no gameplay/runtime code change**.

## Measurement evidence

### Local profiling (`npm run perf:profile`)

Profile panel (seeds `1-3`, weapon `sword`) reported:

- `hasClearLineOfSight` — **5.80% self / 5.89% total**
- `computeFlowField` — **3.63% self / 4.18% total**
- `computeGridPath` — **3.25% self / 4.86% total**

The run also reported startup-overhead dilution at 6.1%, so any small
single-function movement in this band is expected to be noisy.

### Local narrowed neutrality baseline (`npm run perf:fingerprint`)

Captured a local narrowed sample for iteration only:

```bash
npm run perf:fingerprint -- --seeds 1-3 --weapons sword --write /tmp/perf-quick-baseline-2688.json
```

- sample hash: `c7c497b09ba4109865318be0281c94da91f00b99c94df0b8f750fa56d79826d3`
- sample size: 3 runs (`sword` x seeds `1-3`)

Per perf policy this narrowed sample is **not** a PR gate and broad (>10 run)
coverage stays on GitHub infrastructure.

## Why no code landed this pass

- The top remaining hotspots are all in the low-single-digit to ~6% range,
  where expected end-to-end gains for one micro-optimization are narrow and
  typically inside local noise without stronger, target-specific bench evidence.
- Existing recent perf passes already landed larger low-risk wins in adjacent
  paths (flow-field and barrier/LOS investigations), leaving no immediate
  high-confidence one-line win in this session.
- To preserve gameplay-neutral guarantees, this pass rejected speculative edits
  and ended as a measured **no-change** result, which is explicitly allowed by
  the issue contract.

## Notes / blockers

- Required pre-code issue plan comment could not be posted from this environment
  because GitHub auth is unavailable (`gh auth status` reports invalid
  `GITHUB_TOKEN`; API calls return 403). The plan was prepared but not publishable
  from this session.

## Next nightly target suggestion

Prioritize a dedicated, production-shaped bench around
`hasClearLineOfSight` call distribution (segment lengths + barrier-state mix),
then only land an optimization if it shows a stable worst-round win and passes
full-sample fingerprint checks on GitHub-backed execution.
