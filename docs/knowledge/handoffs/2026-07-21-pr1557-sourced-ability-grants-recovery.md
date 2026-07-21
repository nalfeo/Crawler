# Session Handoff: PR #1557 Source-Owned Ability Grant Recovery

## Date

2026-07-21

## Persona

PR Shepherd with separate-model plan and code review.

## Systems touched

inventory, weapons, ci-policy

## Apples

3🍎 estimated, 3🍎 actual (exact). The recovery remained bounded to ownership,
identity validation, migration compatibility, review resolution, and merge gates.

## What Was Done

- Preserved source-owned active and passive grants across learned, skill,
  equipment, and legacy provenance while keeping active ownership separate from
  ten-slot loadout configuration.
- Unified generated-equipment instance parsing across shared, core, and legacy
  creator paths. Canonical IDs accept lowercase dot, underscore, and hyphen run
  keys and reject non-safe ordinals.
- Required canonical safe-integer representations for equipment effect ordinals
  and skill milestone source levels so persisted ownership remains exactly
  revokable.
- Canonicalized signed numeric run seeds to alphanumeric-prefixed run keys while
  preserving negative-seed identity.
- Made equipment revocation validate the complete instance ID before exact-prefix
  ownership scanning, including after registry teardown.
- Preserved retained ability-state object identity when an owned active is
  unequipped and re-equipped.
- Restored legacy `appliedPassiveAbilityIds` so old snapshots that persisted
  passive modifiers do not apply them twice.
- Restored learned provenance for direct passive grants while retaining
  `legacy:passive:*` ownership only for ambiguous migrated snapshots.
- Normalized retired configured actives before enforcing the slot cap.
- Aligned skill milestone and generated-equipment grants with deterministic typed
  source IDs.
- Added migration, identity, malformed-ID, dotted-key, retired-slot, safe-ordinal,
  and grant/revoke regressions.
- Completed the 3🍎 review harness plus different-model GitHub thread
  validation. Follow-up related-instance passes found and closed canonical
  numeric-source gaps, retired carryover modifiers, signed-seed handling, and
  learned-passive provenance; the final separate-model review was clean.
- Maintained the hard no-asset boundary: no sprite generation, judging, approval,
  check-in, asset labels, queues, workflows, Azure operations, or asset PR mutation.

Runtime observation: the shipped simulation integration for learned ability
activation remains the real artifact; the focused
`fireball-pulse-shield-integration` run passed after the recovery patch.

Verification:

- Focused latest-repair suite: 177 tests passed.
- `npm run verify:fast`: 176 files and 2101 tests passed.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-21-pr1557-sourced-ability-grants-recovery.review-ledger.json`
  validates as a complete 3🍎 ledger.

## Key Decisions Made

- Ownership maps are authoritative; runtime ID lists are derived/configuration
  surfaces.
- Generated instance identity has one shared parser and safe-integer ordinal
  contract.
- Grant/revoke batches fail closed and install atomically.
- Carryover persists ownership, reconstructs modern passive effects, and honors
  old applied-passive tracking when legacy modifiers were persisted.
- Retired IDs may round-trip only as inert ownership.
- ADR:
  `docs/knowledge/adr/2026-07-21-source-owned-ability-grant-authority.md`.

## What's Next / Blockers

The code and local gates are complete. Push the final review repair under the
active emergency shepherd lease, validate and resolve every review thread,
release that same lease, arm squash auto-merge, and verify a non-null merge
commit.

## Retrospective

### Lessons Learned

Generated-instance validation must be shared by both grant and revoke paths; a
format accepted only by the registry can create ownership that later becomes
irrevocable. Legacy migration tests must remove modern schema fields rather than
merely naming a fixture "legacy."

### Mistakes Made

The first retired-slot regression used guessed ability IDs that normalization
correctly filtered, and an initial lease heartbeat used the wrong archived script
path and environment variable names. Focused failures exposed both before push;
using catalog-backed IDs and the reconciler's declared environment names corrected
them.

### Opportunities for Future Improvement

Export a catalog-backed test helper for filling active slots so cap tests do not
duplicate ability IDs. Add a deterministic contract test that every generated
instance creator round-trips through the shared parser.
