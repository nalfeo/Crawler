# ADR 0065: Floor 4 Green Room public purchase replay

## Status

Accepted

## Date

2026-09-27

## Estimated Complexity

Medium

## Context

Floor 4 already had seeded Green Room stock, an authoritative transaction, and a shared shop panel, but ordinary completion replays always skipped the sponsor decision. Static equipment bought from that panel could also be absent from the integrated equipment bag because its metadata existed only in `equipmentDefs`.

## Decision

Use one live-build comparison for both the Green Room panel and deterministic replay selection. The comparison includes the currently active production weapon, including direct-start weapons without an inventory wrapper. The replay uses the existing public purchase and safe-context equip operations. Inventory metadata treats static equipment definitions as equippable bag entries even when they are not generic catalog items.

The visual AI runner may opt in to show the ordinary sponsor panel so its public canvas controls can be replayed; this does not alter the Floor 4 scenario configuration or production hardware-input behavior.

## Consequences

Positive: player recommendations and replay selection agree on actual loadout state; a paid sponsor item has a visible path to equip; ordinary MainGameScene evidence covers purchase, equip, and Act 2 transition.

Negative: the visual replay exposes additional read-only UI telemetry and requires a short human-control takeover while using canvas controls.

Risk: score policy still determines what counts as an upgrade, so weapon-score tuning can change the selected deterministic offer. Regression tests assert the live production stat delta and observable combat difference.

## Alternatives considered

- Keep the automatic Green Room exit and assert only transaction APIs: rejected because it misses the player-visible purchase/equip path.
- Add a Floor-4-specific test grant or forced equip: rejected because it would not prove ordinary loadout parity.
- Duplicate the comparison in the panel and replay driver: rejected because recommendations could drift.
