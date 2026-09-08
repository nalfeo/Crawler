# ADR: Floor 6 construction interaction + render parity

- Date: 2026-09-08
- Status: Accepted
- Related issue: #4452

## Context

Floor 6 tower construction was exposed through `ScenarioPresentationContract.construction`, but two gaps blocked a shippable player path:

1. Touch input conflicted with movement capture when construction was handled directly on touch `pointerdown`.
2. Built towers were authoritative in sim state but invisible in the real scene because the built entity had no `Sprite` component.

The recovery also needed real-scene regression coverage for site interaction and tower rendering, not just direct scenario callback tests.

## Decision

- Keep movement-touch isolation in `MainGameScene` by preserving touch filtering on `pointerdown`, and add a touch-specific construction tap flow confirmed on `pointerup` with bounded movement.
- Keep construction authority in the floor scenario transaction (`requestBuild`), but translate rejection reasons into player-facing guidance in the scene.
- Attach `Sprite` to built Floor 6 tower entities so the existing bridge query (`[Sprite, Position]`) renders them without a floor-specific render pass.
- Add real-scene e2e coverage through the probe lab that drives authored-site interaction and validates occupied/rendered tower outcomes.

## Consequences

### Positive

- Mobile movement and construction no longer compete for the same first-touch gesture.
- Successful builds are visible immediately in the shipped renderer.
- Players receive actionable rejection feedback instead of internal reason tokens.
- Regression coverage now includes the real interaction + rendering path.

### Negative / trade-offs

- Probe-lab API gained additional Floor 6 helpers for deterministic e2e setup and observation.
- Tower visuals currently use the bridge default render kind (procedural fallback) until dedicated art mapping is authored.

## Alternatives considered

1. **Handle touch construction on `pointerdown`** — rejected because it reintroduces movement-touch conflicts.
2. **Add a Floor6Tower-specific render pass** — rejected for now; adding `Sprite` keeps rendering on existing generic bridge plumbing with smaller change surface.
3. **Cover only unit-level callback wiring** — rejected because it misses the real scene pointer/modal/render path that regressed.
