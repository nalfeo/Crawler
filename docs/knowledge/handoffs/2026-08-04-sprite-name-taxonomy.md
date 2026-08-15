# Sprite name taxonomy: bare concept ids repo-wide

**Date:** 2026-08-04
**Apples:** 🍎 x 5 (estimated 5, actual 5)

## Systems touched

sprite-pipeline, generated-assets, engine-rendering, items

## What and why

`briefId` is the **variant grouping key** at runtime: `loadGeneratedManifest`
buckets manifest entries by `briefId` and `pickGeneratedVariant` draws from
exactly one bucket. A concept split across `rat` and `rat-v1` therefore did not
have "two naming styles" — it had **two disjoint variant pools**, and the pool
the consumer did not name was approved art that could never render.

**24 concepts were fragmented this way**, including `rat` and `slime`.

ADR 0051 had already fixed this for the _item_ class only, and explicitly carved
out harvestable world-nodes as pinned-versioned. That per-class split rule is
exactly what let the problem keep recurring everywhere ADR 0051 did not cover.

This session re-taxonomized **all 381 brief ids across every asset class** onto
one rule: **bare concept id, `-var-N` variants only**. See
[ADR 0086](../adr/0086-bare-concept-sprite-name-taxonomy.md).

## Observe before done (rule #9)

Observed in the **real game** (`npm run dev`, not a lab):

- Booted to Floor 1 gameplay and screenshotted the running artifact — player
  (`rhea-vale`), welcome sign, stone-floor tiles and a slime all render; **0
  console/page errors**.
- Probed the shipped manifest as the runtime loads it: **635 entries, 363
  concepts, 0 lineage-tagged brief ids**. `rat` is now one pool of 3 variants and
  `slime` one pool of 4 (previously split across two buckets each).

Before: 24 fragmented concepts. After: **0**.

## Verification

| Gate                                         | Result                                               |
| -------------------------------------------- | ---------------------------------------------------- |
| Fragmented concepts                          | 24 → **0** (primary success gate)                    |
| Approved variants lost                       | **0** (517 real-art contentHashes before==after)     |
| Migration                                    | 353 renames, 24 merged, 8 renumbered, 0 conflicts    |
| `check:sprite-name-taxonomy`                 | exits 0, idempotent                                  |
| `check-manifest`                             | 635 shards, 518 derived rows — invariants hold       |
| `tsc --noEmit`                               | clean                                                |
| eslint / prettier                            | clean                                                |
| unit project                                 | 7328 passed (6 pre-existing env failures, see below) |
| sprites project                              | 2275 passed                                          |
| integration project                          | 230 passed                                           |
| e2e (harvestable, equipment art, scene boot) | 6 passed                                             |

**Pre-existing failures, NOT caused by this change** (verified identical on a
clean `git stash` of HEAD): `post-checkout-hook`, `inventorybag-lane-access-rule`,
`velocity/conflict-scan`, `baseline-regression-check`,
`extensions/asset-search-index-builder`. All are the known Windows/WSL-bash
interop quirk documented in AGENTS.md.

## Gotchas for the next agent

**The rename-chain data-loss bug — the single most important thing here.**
Merging lineages creates rename _chains and cycles_: `rat-v1-var-9` → `rat-var-9`
while `rat-var-9` itself must become `rat-var-0`. A naive sequential rename
clobbers a destination still occupied by an entry that has not moved yet. This
**silently destroyed approved art** on the first apply (surfaced only as a
confusing Prettier "no files matching" error). Fixed with a **two-phase staged
rename** through `__migrating__/` temp keys, making the operation order-independent.
Covered by a verified fail-to-pass regression test in
`tests/unit/sprites/normalize-sprite-names.test.ts`.

**Rolling back an asset migration needs `git reset --hard` + `git clean -fd`.**
A plain `git checkout -- public/assets/generated` leaves you with 990 shards: it
restores the deleted originals but keeps the renamed copies.

**`bareConcept` ordering is load-bearing.** `DESIGN_NAME_REMAP` must be consulted
_before_ lineage stripping. Stripping first turns a bare `angry-roomba-v2` into
`angry-roomba`, silently merging the mark-2 enemy into the base enemy. A unit
test pins this.

**Only ONE lineage tag is stripped.** `iron-ore-v1-v2` → `iron-ore-v1`, which
surfaces as a conflict rather than a wrong guess.

**Historical records were deliberately NOT rewritten.** The codemod
(`scripts/sprites/repoint-sprite-name-refs.ts`) excludes `docs/**` — handoffs,
ADRs, review ledgers and `agent-memory.jsonl` still contain the old versioned
names, because they describe what was true at the time.

**Watch the codemod on test fixtures.** It over-reached into
`tests/unit/item-sprites.test.ts`, which _deliberately_ constructs versioned
entries to exercise the resolver's version-tiebreak ordering. That defensive
resolver path still exists and its fixtures were restored by hand.

**8 variant indices were renumbered**, so a few concepts draw different art for a
given seed than before. That is the accepted, intended consequence of the chosen
merge strategy (keep every approved variant, renumber collisions oldest-first);
the alternative was discarding approved art.

## Deleted

- `scripts/sprites/normalize-item-art-names.ts` + its test — superseded.
- `itemArtIdentitySet` / `canonicalItemBriefId` from `src/shared/item-sprites.ts`
  — an item-specific identity set has nothing left to decide once every class is
  bare.

## Follow-ups

- The 8 renumbered concepts have not been individually eyeballed for art quality;
  they render, but a Graphics-Designer pass could confirm the chosen `var-0` is
  the best representative for each.
- `iron-vein` / `copper-seam` / `gem-cluster` are wired to bare keys but still
  have **no approved art** (they were dangling `-v1` keys before this change
  too). They fall back to the procedural circle until art lands.
