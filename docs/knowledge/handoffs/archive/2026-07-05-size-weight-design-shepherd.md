# Handoff: shepherd size+weight design PR to merge (#760) + R2 follow-up (#769)

**Date:** 2026-07-05  
**Persona:** Producer  
**Apples:** estimated 🍎 / actual 🍎

## Systems touched

enemies, weapons, ai-combat-balance

## Summary

Shepherded PR #760 ("docs(physics): propose true size + weight system — ADR
0044 + spec + data table") to a clean squash-merge into `main`. The only
blocker was `required_conversation_resolution` (5 unresolved
`copilot-pull-request-reviewer` threads, all doc-accuracy). Corrected each
finding truthfully against the real source, resolved all threads, and merged.
A post-push re-review surfaced a 6th (non-gating, arrived after merge) doc
contradiction, which was fixed in follow-up PR #769.

## What changed (thread corrections on #760)

Verified every claim against source before editing:

1. **"Weight is a dead component" (ADR + spec).** False — `dropSystem.ts:217`
   reads `weight.value` to derive a split slime's child weight, and
   `initializeEnemyAppearance` (`combatants.ts:36`) rescales it by
   `sizeScale`. Reworded the ADR + spec gap analysis to name the real
   readers; kept the accurate "no collision/knockback consumer uses it" claim.
2. **Knockback formula (ADR).** `kbImpulse / targetWeightLb` was not
   equivalent to the canonical `writerImpulse * (120 / max(1, targetWeight))`
   in `entity-sizing.md`. Rewrote the ADR block to the canonical form and
   dropped the misleading "reinterpret as impulse" + "pick constants" framing
   so there is one definition and no implied recalibration.
3. **"200 lb wall" misattribution (ADR).** The 200 lb default belongs to
   `spawnSpawner` structures (`combatants.ts:186`), not walls; wall/door
   terrain is not a `Weight`-bearing entity. Fixed the attribution.
4. **NPC row file ref (data table).** `spawnNpc` lives in
   `src/core/spawners/world-objects.ts:61`, not `combatants.ts`. Fixed.
5. **Granite density (data table).** ~600 → ~168 lb/ft³.

Merged as squash commit **b7c92936f847e11cddee53ca023d3b62b097c5a7**.

## Follow-up (#769)

Post-push copilot re-review flagged a real contradiction (arrived after
#760 merged, so non-gating): `check:weight-coverage` in `entity-sizing.md`
has **no `Immovable` exemption**, but spec **R2** exempted `Immovable`
entities. The data table assigns weights to every `Immovable` prop (a
10 000 lb wall's weight is exactly what trips `IMMOVABLE_THRESHOLD`), so the
"no exemption" reading is correct. Aligned R2 to the data table + coverage
rule in PR #769 (`fix/weight-coverage-immovable-doc`).

## Files touched

- `docs/knowledge/adr/0044-explicit-size-weight-components.md`
- `.specify/specs/entity-physics.md`
- `docs/knowledge/game-design/entity-sizing.md`
- `docs/knowledge/handoffs/2026-07-05-size-weight-design-shepherd.md`
- `docs/knowledge/metrics/apples/2026-07-05-size-weight-design-shepherd.json`

## Review harness

Docs/design-only diffs — exempt from the `pr-review-ledger` guard. No ledger
required for the thread corrections or the R2 reconciliation.

## Verification

- `npm run verify:fast` ✅ (both #760 corrections and #769; docs-only, no
  changed TS/unit files; Prettier format check clean on push).
- #760 required checks (`ci` + `commit-lint`) ✅ on the corrected commit.

## Merge state (bounded final verification)

- **#760:** `state=MERGED`, `mergeCommit=b7c92936f847e11cddee53ca023d3b62b097c5a7`,
  `mergedAt=2026-07-05T04:56:23Z`, 0 unresolved threads, `main` HEAD is the
  squash commit. Remote branch auto-deleted.
- **#769:** `state=MERGED`, `mergeCommit=599123a185e6087a3af937990dc4337b95aa50bc`
  (squash). Aligned spec R2 to the data table + coverage rule (required =
  `ci` + `commit-lint` only; `enforce_admins:false`). Remote branch
  auto-deleted.

## Observe before done

Design/docs-only change — no runtime/visual behavior altered. "Observe"
here = each corrected claim was verified against the actual source file
(`dropSystem.ts:217`, `combatants.ts:36` / `:186`, `world-objects.ts:61`)
before editing, not just against the diff.

## Unresolved issues

- None. All 6 review threads across #760 addressed (5 fixed + resolved on
  #760; the 6th fixed via #769).

## Recommended next steps

1. Let #769 self-land via armed auto-merge.
2. When Slice 1 implementation begins, `src/core/physics-defs.ts` +
   `check:size-coverage` / `check:weight-coverage` gates are the first
   deliverables per the spec.
