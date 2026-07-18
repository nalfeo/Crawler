# Handoff: Floor 2 Equipment Placeholder Manifest

## Date

2026-07-18

## Persona

Graphics Designer, coordinated as a speculative stacked cloud packet.

## Systems touched

sprite-pipeline, generated-assets, shared-art-contracts, tests

## Apples

3 apples estimated, 3 apples actual (exact). The packet added one bounded typed
art-manifest subsystem, deterministic generation, committed placeholders, focused
coverage, and the required two-round review loop.

## Stack

- Issue: #1291
- Session: `0c1c9241-157d-46df-ab41-8efbc7e66b20`
- Branch: `nalfeo-floor-2-equipment-placeholders`
- Base branch: `nalfeo-floor-2-equipment-contracts`
- Verified A1 base and latest resync head:
  `4c11335a281842f82d206a4c42b23a28e2f40e91`
- A1 PR: #1276
- Packet PR: pending publication
- Canonical lifecycle: still blocked; this is STACKED-WORK evidence only.

## Summary

- Added the exact canonical 70-ID Floor 2 equipment art manifest with stable
  `equipment/<prefix>/<slug>` runtime keys.
- Classified all 50 weapon bases into the ten A1-approved families with exactly
  five bases each and retained the exact 20 PLAN-approved non-weapon entries,
  slots, and categories.
- Added reusable deterministic 16x16 placeholder composition, reserving every
  canonical runtime key directly in the shipped generated-assets manifest.
- Added a fail-closed canonical promotion seam: production art replaces a
  placeholder at the same runtime key, while placeholder or later production
  writes cannot silently overwrite an existing production entry.
- Added 15 disjoint future production packets: ten weapon-family waves and five
  non-weapon UI-slot waves, each with typed brief inputs.
- Did not modify gameplay stats, equipment generation, inventory, rewards,
  merchants, AI, the canonical PLAN, or `epic-state.json`.
- Did not run provider generation, approval, asset-PR, check-in, or a sidecar.

The canonical 20 non-weapon IDs contain no off-hand stable ID. This packet did not
invent one or reclassify `weapon.spike-shield`; that ID remains in the PLAN's
weapon slot. Any future off-hand addition requires the Producer-owned contract
change protocol.

## Observation

At the verified A1 base, the shipped generated manifest contained zero
`equipment/*` runtime keys, so every planned Floor 2 art lookup was absent. After
this packet, the real generated-manifest loader resolves all 70 exact runtime
keys to committed placeholder textures, all 70 files exist, regeneration is
byte-idempotent, and every composed PNG has a unique SHA-256.

## Review

- Plan review, `gpt-5.4`: six concerns resolved with minor divergence. The final
  design added direct PLAN parsing, an explicit production-promotion seam, and
  output collision checks.
- Code review round 1, `claude-sonnet-4.6`: two valid concerns. Fixed unrelated
  production-entry field reordering and made production-to-production upserts
  fail closed.
- Code review round 2, `claude-sonnet-4.6`: clean.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-17-floor-2-equipment-placeholders.review-ledger.json`

## Validation

- Focused Floor 2 equipment sprite tests: 9 passed.
- Full sprite pipeline: 1,267 passed, 1 skipped.
- `npm run verify:fast`: passed.
- `npm run epic:status -- floor-2-equipment`: valid schema/DAG, no errors or
  warnings, expected blocked release lifecycle.
- Read-only GitHub reconcile: valid, no writes performed.
- Pre-existing generated-manifest entries changed: 0.
- Review ledger validation: passed.
- Guard telemetry capture: no session telemetry source file existed; command
  completed with one non-blocking finding and wrote nothing.

## Follow-up

- Production-art family/UI issues should consume
  `FLOOR2_EQUIPMENT_PRODUCTION_WAVES`, preserve each runtime key, and use the
  canonical promotion seam rather than adding consumer-visible variant keys.
- Producer retains sole ownership of PLAN/epic-state lifecycle reconciliation.
- Do not merge or arm auto-merge without explicit authorization.
