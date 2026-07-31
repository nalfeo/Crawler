# ADR 2026-07-25: Runtime-committed lane geometry authority for Tongue Repossession

## Status

Accepted

## Date

2026-07-25

## Estimated Complexity

🍎 x 4 — touches core runtime geometry contracts plus AI and renderer consumers.

## Context

Big Mama Bufo's TONGUE REPOSSESSION requires a narrow locked lane telegraph where hit detection, AI danger reasoning, and VFX all agree on the exact committed geometry and cadence. The existing mob-ability runtime only exposed circle/spawn-circle geometry. Implementing lane logic separately in each subsystem would risk divergence between what players see and what resolves.

## Decision

Extend the typed mob-ability runtime geometry union with a first-class `lane` geometry committed at telegraph start. Keep one authoritative committed lane in core runtime state and consume that same artifact in:

- core resolve handler (hit/miss + pull destination),
- AI dodge reasoning,
- Phaser VFX telegraph and resolution burst rendering.

Implement Tongue Repossession as a typed adapter that reads and validates catalog-authored values (`width`, `max-range`, `pull-end-distance`, `damage-profile`) without introducing generic runtime interpretation paths.

## Consequences

### Positive

- Deterministic shared geometry keeps telegraph, danger, and resolution behavior aligned.
- Ability implementation stays within existing typed runtime architecture (no boss switch in enemy AI).
- Lane support is reusable for future typed boss abilities.

### Negative

- Runtime and renderer interfaces widened to include lane-specific data.
- Additional cross-system tests are required to prevent regressions.

### Risks

- Future lane abilities could bypass color/theming expectations if VFX call paths drift.
- Pull placement safety depends on footprint passability checks and fallback behavior.

## Alternatives Considered

1. Ability-local lane state without runtime geometry extension — rejected because it duplicates geometry authority and increases mismatch risk across AI/VFX/resolve.
2. Spawned tongue actor with collision-driven resolve — rejected for this scope because it introduces extra lifecycle/state complexity beyond the typed ability runtime contract needed by this issue.
