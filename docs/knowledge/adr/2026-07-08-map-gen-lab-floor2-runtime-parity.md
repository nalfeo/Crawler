# ADR: Map-gen lab and Floor 2 runtime parity for cave generation overlays

## Status

Accepted

## Date

2026-07-08

## Estimated Complexity

🍎 x 3 — touches core map generation, floor scenario runtime state, and lab overlay UI/test wiring.

## Context

The map generation lab and cave-system-specific lab behavior had diverged from real
runtime behavior on Floor 2. This caused repeated false signals in the lab:

- floor-attached defaults and constraints were not consistently applied from real floor config,
- spawn-zone visualization and spawn-table output could disagree with runtime quadrant assignment,
- settlement and den geometry overlays did not always reflect the carved map boundaries,
- hover/legend output could miss overlapping semantic regions.

The user requirement was to keep one unified map-gen lab, reuse existing runtime
systems, stay deterministic, and avoid introducing parallel duplicate logic paths.

## Decision

1. Keep a single map-gen lab surface and source Floor 2 spawn/territory preview data
   from runtime scenario state (`floor2Scenario`/extended state), not ad-hoc local
   heuristics.
2. Make floor-attached constraints authoritative for biome+size defaults when enabled;
   allow manual override only when constraints are disabled.
3. Model overlays and spawn-table rows through deterministic helper modules
   (`hover-utils`, `spawn-table-model`) so overlap tooltips, spawn zones, and
   legend/panel output share one normalized data path.
4. Harden cave-system carving invariants in core generation:
   settlement rooms stay enclosed by walls (except intended doors),
   inter-room settlement hallways are explicit walled corridors,
   boss den perimeter/door behavior remains deterministic and reachable.
5. Keep non-gating headless Floor 2 smoke coverage (ENGAGE/EXPLORE + quest activity)
   but do not assert victory until Floor 2 is fully completable by design.

## Consequences

### Positive

- Lab previews now match real Floor 2 spawn and territory semantics more closely.
- Overlay, tooltip, and spawn-table behavior is easier to reason about and test.
- Settlement/den structure rendering is consistent with carved geometry and room graph.
- Deterministic unit/integration coverage is stronger around map-gen and runtime parity.

### Negative

- Additional helper modules and tests increase map-gen lab surface area.
- Floor 2 headless smoke coverage remains progress-oriented rather than completion-gated.

### Risks

- Future runtime state schema changes could desync lab preview data if adapters are not
  updated together.
- Any later generator-ordering changes (carve/cull/connect) can regress room/overlay
  parity unless invariants are preserved in tests.

## Alternatives Considered

- **Keep separate cave and map-gen labs.** Rejected: duplicates controls/logic and
  drifts from runtime behavior.
- **Use lab-only spawn heuristics for Floor 2 zones.** Rejected: repeated mismatch with
  runtime assignments and spawn behavior.
- **Retain Floor 2 headless victory gate now.** Rejected: Floor 2 is not yet fully
  completable by design, so this would create false failures.
