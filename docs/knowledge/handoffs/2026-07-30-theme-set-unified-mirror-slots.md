# Themed sets default to unified mirror-pair items

**Date:** 2026-07-30
**Session slug:** theme-set-unified-mirror-slots
**Apples:** 3🍎 (tooling-only cap; art-authoring pipeline, zero gameplay impact)

## Systems touched

theme-equipment, sprites-pipeline

## Problem

Themed equipment sets were being authored with separate left/right split items —
a "Banded Vambrace (Left)" and a "Banded Vambrace (Right)", a "Signet Ring (Left)"
and a "Signet Ring (Right)". A real garment covers both sides of a mirror-symmetric
slot pair at once (a pair of bracers, arm wraps on both arms, a ring that fits
either hand), and the runtime equipment stack already supports multi-slot items.
The maintainer wants themed sets to **default to one unified item per mirror pair**.

## Measurable gate

No themed set may be authored — via LLM roster synth, human roster edit, or a
committed plan file — with one side of a mirror pair unless its partner slot is on
the **same item**. Enforced deterministically at the plan-parse boundary.

## Design

Mirror pairs (from `SLOT_REGISTRY`): `leftArm`/`rightArm`, `leftWrist`/`rightWrist`,
`ringLeft`/`ringRight`. `mainHand`/`offHand` is deliberately **not** a mirror pair
(functionally distinct hands). `gloves` is already a single both-hands slot.

1. **Canonical metadata** — `src/shared/equipment-slots.ts`: `MIRROR_SLOT_PAIRS`,
   `MIRROR_SLOT_IDS`, `getMirrorSlot()`, plus a module-load fail-fast loop that throws
   if a pair ever names a slot missing from the registry. Inert metadata; the runtime
   stack already handles multi-slot items.
2. **Single enforcement chokepoint** — `scripts/sprites/theme-equipment-set.ts`:
   exported pure `validateThemeSetPlanMirrorSlots(equipment)` returning
   `ThemeSetGateReason[]` (code `mirror-slot-unpaired`, path `['equipment', i, 'slots']`),
   wired via `.superRefine` on `themeEquipmentSetPlanSchema`. Because every plan-parse
   path (build, load, `validateRosterProposal` human-edit re-validation, `readAuthoredPlans`
   index) goes through that one schema, the rule is unbypassable and throws a ZodError the
   roster-synth repair loop already handles via `error.message`.
3. **Prompts** — `scripts/sprites/theme-roster-synth.ts`: both roster prompt builders
   state the unified-mirror rule with a pair list derived from `MIRROR_SLOT_PAIRS`.
4. **Data migration** — `data/theme-equipment-sets/classic-fantasy.json` and
   `edo-samurai.json`: 6 split items each → 3 unified items. `classic-fantasy-basic-leather.json`
   was already unified (reference, unchanged).
5. **Tests** — mirror metadata (`tests/unit/equipment-slots.test.ts`); validator
   singleton + two-item + unified cases, build-reject, legacy split-state load compat,
   and an `it.each` guard over every committed plan (`theme-equipment-set.test.ts`);
   human-edit rejection (`theme-roster-synth.test.ts`); item-count fixup
   (`theme-equipment-review-cli.test.ts`).

## Critical invariant (do not break)

The mirror rule is on the **plan** schema only, **never** the state schema.
`parseThemeEquipmentSetState` / `validateThemeEquipmentSetCoverage` must keep loading
existing stored states (including in-progress Azure-blob states) that contain legacy
split items. An explicit regression test exercises this.

Coverage math is unaffected: `validateThemeEquipmentSetCoverage` counts **distinct**
non-hand slots via a `Set`; merging two split items into one unified item covering the
same two slots leaves distinct-slot coverage identical (`coveredSlotCount` stays 16).

## assets/plans re-sync (required, done)

The `theme-equipment.yml` `init` job pulls the plan from a maintainer-supplied pinned
40-char `assets/plans` commit SHA, not from the default branch. The authoritative
`assets/plans` copies of `classic-fantasy.json` and `edo-samurai.json` still held split
items, so a fresh init would be rejected once this validation deploys (flagged blocking
by code review). **Resolved:** the migrated unified plans were published to
`origin/assets/plans` via the contents API. New branch head:
`dd7bdb87ec77f5176f2170626bc61bc7659cc24a`. Future inits of these two sets should pin to
`dd7bdb87e` or later. This is safe pre-merge because unified items are valid under both
the old and new schema, and the state-load path is unchanged.

## Review

- **Plan review** (gpt-5.6-sol): approve-with-changes, 8/8 concerns resolved,
  `plan_divergence: minor`.
- **Code review** (gpt-5.6-sol, separate model): round 1 one blocking finding
  (assets/plans still split) → resolved via the re-sync above; round 2 APPROVE, clean.
- Ledger: `docs/knowledge/review-ledgers/2026-07-30-theme-set-unified-mirror-slots.review-ledger.json` (valid 3-apple).

## Observe before done

This is an authoring-boundary validation change with zero runtime/visual surface — the
observable behavior is "the schema rejects a split plan and accepts a unified one," which
is exercised directly by the unit tests (`buildThemeEquipmentSetStateFromPlan` throws
`/mirror slot/` on a split plan, does not throw on the unified fixture, and the `it.each`
over all three committed plans passes). `npm run verify:fast` green (typecheck + lint +
unit + sprites).

## Follow-ups / notes

- If more mirror-symmetric slots are ever added to `SLOT_REGISTRY`, add them to
  `MIRROR_SLOT_PAIRS`; the fail-fast loop guarantees the table stays honest.
- `data/theme-equipment-sets/classic-fantasy-basic-leather.json` was authored unified
  from the start and needs no migration.
