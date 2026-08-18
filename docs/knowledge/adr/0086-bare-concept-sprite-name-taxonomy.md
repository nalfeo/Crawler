# ADR: Generated sprite names are bare concept ids everywhere (`-var-N` variants only)

## Status

Accepted

## Date

2026-08-04

## Supersedes

[ADR 0051 — Item sprites resolve by item id](2026-07-08-item-sprite-name-normalization.md),
whose bare-id rule was scoped to **item** art only. That scope is now repo-wide.

## Estimated Complexity

🍎 x 5 — a full re-taxonomy of all 381 generated brief ids across every asset class
(enemies, tiles, doors, props, NPCs, abilities, items, harvestables), a lineage-merging
disk migration of the sharded manifest + PNGs, an approve-time recurrence fix, a
deterministic CI guard, and a 62-file repo-wide reference repoint.

## Context

`briefId` is the **variant grouping key** at runtime.
`loadGeneratedManifest` (`src/shared/generated-assets.ts`) buckets every manifest entry
by `briefId`, and `pickGeneratedVariant` draws a variant from **exactly one** bucket.

So a concept whose approved art is split across two names — `rat-v1-var-3` and
`rat-var-9` — does not have "one concept with two naming styles". It has **two disjoint
variant pools**, and whichever pool the consumer's key does not name is art that can
never render. This was not cosmetic: **24 concepts were fragmented**, including `rat`
and `slime`.

The `-vN` suffix is a **generation-lineage tag** — an artifact of how the art was
produced (re-brief, re-run, style revision). It is meaningless to a consumer, which only
ever asks "give me a `rat`". ADR 0051 already established this for items and migrated the
item class. But it deliberately left every other class versioned, and it explicitly
carved out harvestable world-nodes as a _pinned versioned key_ contract. That split rule
is exactly what let the fragmentation keep recurring in the classes ADR 0051 did not
cover.

`type` cannot drive the taxonomy: 227 of 635 entries carry no `type` at all, and ADR 0051
already documented that `type` disagrees with reality (`classified-dossier`'s real art is
`character`, its placeholder is `item`). The taxonomy is therefore driven **purely by
name**.

## Decision

**1. One naming rule for every asset class.** A generated brief id is a **bare concept
id**. Variants are expressed only as `-var-N`. Generation lineage (`-vN`) is never part
of a brief id. This retires ADR 0051's item-only carve-out _and_ its versioned-harvestable
exception — harvestables are now bare like everything else.

**2. Lineages merge; every approved variant is kept.** When `rat-v1` and `rat` both hold
approved art, they become one `rat` pool containing all of it. Nothing approved is
discarded. Where variant indices collide, they are renumbered deterministically by
**oldest `approvedAt` first**, so the migration is reproducible and reviewable.

**3. A design name that merely looks like a lineage tag is renamed, not special-cased.**
`angry-roomba-v2` is a distinct enemy ("Roomba mark 2"), not a second lineage of
`angry-roomba`. It is renamed to `angry-roomba-mk2`. This keeps the guard **absolute**:
no allowlist, no judgment call, no "except this one" that the next agent has to learn.

**4. The rule is enforced deterministically, not by convention.**
`npm run check:sprite-name-taxonomy` (wired into `verify`) fails on any lineage-tagged
brief id. `scripts/sprites/approve.ts` bare-keys at approval time so the pipeline cannot
re-introduce the problem.

## Consequences

**Good.**

- 24 fragmented concepts collapse to 0. Previously unreachable approved art now renders.
- One rule replaces a per-class rulebook. `bareConcept()` in
  `scripts/sprites/sprite-name-taxonomy.ts` is the single source of truth, shared by the
  migration, the guard, and `approve.ts` — they cannot disagree.
- `itemArtIdentitySet` / `canonicalItemBriefId` and
  `scripts/sprites/normalize-item-art-names.ts` are deleted. An item-specific identity set
  has nothing left to decide once every class is bare.

**Costs, accepted.**

- **8 variant indices were renumbered**, so a few concepts will draw different art for a
  given seed than they did before. This is the direct, intended consequence of decision 2
  (keep everything, renumber collisions) — the alternative was discarding approved art.
- Historical records (`docs/knowledge/handoffs/`, prior ADRs, review ledgers,
  `agent-memory.jsonl`) still contain the old versioned names. They are **deliberately not
  rewritten**: they describe what was true at the time, and rewriting them would falsify
  the project's own history.

**The migration hazard worth remembering.** Merging lineages creates rename _chains and
cycles_ (`rat-v1-var-9` → `rat-var-9`, while `rat-var-9` itself must become `rat-var-0`).
A naive sequential rename clobbers a destination that is still occupied by an entry that
has not moved yet — this silently **destroyed approved art** on the first apply. The fix
is a **two-phase staged rename** through `__migrating__/` temp keys, making the operation
order-independent. This is covered by a fail-to-pass regression test in
`tests/unit/sprites/normalize-sprite-names.test.ts`.

## Verification

- 353 renames, 24 concepts merged, 8 renumbered, 0 conflicts.
- **0 fragmented concepts remain** (was 24) — the primary success gate.
- **0 approved variants lost** — 517 real-art `contentHash` values before == after.
- `--check` exits 0 on the migrated tree (idempotent).
- `check-manifest` invariants hold: 635 shards, 518 derived generated rows.
