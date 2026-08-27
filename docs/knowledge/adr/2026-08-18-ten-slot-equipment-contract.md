# ADR: Ten-slot equipment contract

- Status: Accepted
- Date: 2026-08-18

## Context

The equipment paper doll had bilateral limb, wrist, face, back, and belt slots
that increased UI density without creating distinct player decisions. The
equipment UX and authored content now need one stable contract.

## Decision

The active equipment slots are exactly `head`, `neck`, `mainHand`, `chest`,
`offHand`, `gloves`, `legs`, `ring1`, `feet`, and `ring2`. Main hand and off
hand remain separate because they have different gameplay roles. Ring slots
remain separate but are intentionally unlabeled by side.

Retired slots are removed from active item definitions and theme plans rather
than remapped into unrelated categories. Future categories, such as capes, may
be appended through a separate design decision.

## Consequences

The runtime, carryover validation, reward data, sprite authoring, and equipment
UI must all validate against the same ten-slot registry. Empty-slot glyphs and
slot filters use the canonical IDs, and the two ring slots are treated as
independent interchangeable positions.
