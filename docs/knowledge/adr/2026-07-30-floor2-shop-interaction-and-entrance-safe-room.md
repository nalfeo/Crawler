# ADR 2026-07-30: Floor 2 shop interaction and entrance safe-room semantics

## Status

Accepted

## Date

2026-07-30

## Estimated Complexity

🍎 x 2 — small runtime wiring change across engine interaction flow and core safe-space classification.

## Context

Issue #2371 reported two Floor 2 UX/world inconsistencies:

1. Shop access used a standalone "Shop/Buy" UI affordance instead of the floor's established NPC talk interaction grammar.
2. The Floor 2 spawn/entrance room did not count as safe, conflicting with arrival expectations and regroup behavior.

The change also needed to avoid decorative non-functional shop NPCs on Floor 2.

## Decision

- Route Floor 2 settlement shop opening through NPC interaction:
  - Detect settlement shop NPC entities (Quartermaster + non-Quartermaster shop NPCs) in `MainGameScene` interaction handling.
  - Open the Quartermaster purchase panel from `Talk` interaction with those NPCs.
  - Remove closed-state corner-button opening affordance; keep only an open-state dismiss affordance.
- Keep non-Quartermaster shops functional by binding them to the same purchase-panel opening flow.
- Extend safe-space classification so Floor 2 spawn-room tiles count as safe context in `isPointInSafeSpace`, while leaving settlement-anchor resolution tied to persisted settlement room id.

## Consequences

### Positive

- Shop interactions now match existing NPC conversation grammar.
- All spawned Floor 2 shop NPCs are functional interaction points.
- Floor 2 entrance now behaves as a safe regroup area without reworking settlement-anchor plumbing.

### Negative

- Floor 2 safe-space logic now contains a floor-specific branch in `safe-space.ts`.
- Quartermaster panel remains shared for all settlement shops (no per-shop inventory split in this slice).

### Risks

- Future Floor 2 spawn-room semantics could diverge from "always safe" and require revisiting the branch.
- Interaction proximity in crowded settlement rooms must continue choosing the intended nearby NPC.

## Alternatives Considered

1. Keep/retune the button-based shop opener and only add NPC interaction as a secondary path. Rejected because it preserves the UX inconsistency called out in the issue.
2. Remove non-Quartermaster shops entirely. Rejected in favor of preserving authored world population while making those NPCs functional.
3. Mark entrance safe by mutating map room roles during generation. Rejected as broader mapgen churn than needed for this fix.
