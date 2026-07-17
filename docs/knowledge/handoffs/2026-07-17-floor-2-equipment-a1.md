# Session Handoff: Floor 2 Equipment A1 — Implementation Contract Lock

## Date

2026-07-17

## Persona

Producer / Systems Engineer

## Systems touched

<!-- Docs/tooling-only session with no runtime impact -->

## Apples

2🍎 exact (documentation-only, no code changes)

## What Was Done

Locked the implementation contracts for the Floor 2 equipment epic (slice A1).
No runtime code changes — all deliverables are specification and documentation artifacts.

**Artifacts produced:**

1. **`.specify/memory/constitution.md`** — Added Principle 9 (Rapid Five-Level Build Growth)
   establishing the 1.7×–2.3× median aggregate realized-DPS gate as a governing constitutional
   constraint.

2. **`.specify/specs/equipment-system.md`** — Appended the "Floor 2 Generated Equipment Contract"
   section covering: instance identity model, resolution order, rarity budgets (Common 1.00×,
   Uncommon 1.05×, Rare 1.10×), enhancement bounds (+0..+5), ability/passive source ownership,
   achievement reward atomicity, shop/economy contracts, AI scoring rules, 7 feature flags, and
   migration semantics.

3. **`.specify/specs/weapon-system.md`** — Appended the "Floor 2 Frozen Weapon Snapshot Contract"
   section with the `ActiveWeaponSnapshotV1` interface, snapshot dispatch rules, and immutability
   invariants.

4. **`docs/knowledge/adr/0065-versioned-frozen-floor2-equipment-instances.md`** — New ADR
   documenting the cross-system decision to use one versioned generated-equipment registry with
   10 numbered decisions (DEC-001 through DEC-010), authority table, consequences, and 5 rejected
   alternatives.

5. **`docs/knowledge/adr/README.md`** — Added 0061–0065 to the ADR index (0061–0064 files already
   existed but were missing from the README table).

**Lifecycle note:** A1 remains canonically `blocked` in the epic lifecycle because slice A0 (PR #1265)
has not yet validated. This work is speculative stacked progress per the durable stacked-work protocol
and does not advance A1's canonical lifecycle or make downstream nodes ready.

## Key Decisions Made

- **No code changes** — A1 is specification-only. Contracts are locked via docs, not via
  TypeScript type guards. Type guards and runtime validation land in B-tier implementation slices.
- **Append-only spec additions** — existing spec content is not modified; new contract sections
  are appended at the bottom of each spec file to prevent merge conflicts with in-flight changes.
- **Constitution as the DPS growth authority** — Principle 9 is the root authority so all future
  agents (not just equipment-domain agents) are bound by the 1.7×–2.3× gate when they add
  progression content.
- **ADR 0065 authority table** — explicitly maps each contract surface to its normative document
  so there is no ambiguity about which file wins in case of conflict.
- **7 feature flags, dependency closure, preserve-on-disable** — these three constraints together
  prevent partial Floor 1 exposure and data-loss scenarios during rollout.

## What's Next / Blockers

**Blocker:** A0 (PR #1265) must merge and validate before A1 can advance to `in_progress` or
`pr_open` in the canonical epic lifecycle.

**After A0 merges:**

1. Producer updates epic-state.json to add the A1 slice entry and set status to `ready`.
2. Rebase this branch onto the updated main, retarget PR to main, rerun `verify:fast`.
3. Producer records A1 commit evidence and marks `validated`.

**Ready downstream work (B-tier) — computed-ready after A0 + A1 validate:**

- B1: DPS ratio measurement tooling (`scripts/agent/floor2-dps-ratio.ts`)
- B2: Tier 1 equipment catalog (`src/shared/equipmentDefs.floor2.ts`)
- B3: Tier 2 equipment catalog

## Retrospective

### Lessons Learned

- The A1 slice was not present in the original A0 epic-state.json — it was a post-A0 control
  plane addition. Future epics should explicitly define all control-lane slices in A0 to avoid
  ambiguity about where each slice's artifacts live.
- Multiple Copilot sessions simultaneously worked on A1 (PRs #1276, #1278, #1280, #1283).
  The durable stacked-work protocol recorded in PR #1280 correctly identifies this collision
  but doesn't resolve it — the Producer should arbitrate which branch becomes canonical after
  A0 merges.

### Mistakes Made

- None in this session; this was a clean documentation-only slice.

### Opportunities for Future Improvement

- The ADR README table has duplicate-number entries (two 0054s, two 0055s, two 0062s). A CI
  check that lints ADR number uniqueness would catch these early.
- The durable stacked-work protocol needs clearer guidance on how multiple agents claiming the
  same slice is resolved — currently it's left to the Producer to arbitrate manually.
