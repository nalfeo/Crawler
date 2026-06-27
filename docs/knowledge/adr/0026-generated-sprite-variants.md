# ADR 0026: Multi-variant generated sprites — identity, selection, approval, and check-in

## Status

Accepted

## Date

2026-06-26

## Estimated Complexity

🍎 × 5 (Massive) — touches the shared registry, runtime selection, the approval
pipeline + DevTools UI, a new check-in mechanism, a CI lane, and a new skill.

## Context

The sprite-generation pipeline lets an operator approve generated art into the
game. Two bugs surfaced together:

1. **Approved art didn't render reliably.** Every approved variant of a brief was
   written to the manifest with `spriteName = briefId`. The generated-asset
   registry keyed its lookup map by `briefId` (last-wins) and the Phaser
   preloader de-duped by texture key (first-wins), so multiple variants of one
   brief collapsed onto a single texture key and collided. The user's approved
   `skull-mace` variant therefore failed to render.
2. **The UI let you "approve the same thing twice."** Because identity collapsed
   to `briefId`, approving a second variant produced a duplicate-looking catalog
   entry instead of a distinct variant, and re-approving the exact same variant
   was silently allowed.

The user expanded the scope to a full multi-variant model: support multiple art
variants per item; confirm before approving a _new_ variant; block re-approving
the _exact same_ variant; pick a variant at runtime with `SeededRandom`; give the
e2e/approval process a way to **check in** approved art; and optimize CI so only
essential checks run when a change is art-only. The check-in must push a branch
**without** opening a PR and file a tracking issue, with a separate skill that
consolidates open asset issues into one game PR.

## Decision

### Texture identity = manifest entry key

The registry (`src/shared/generated-assets.ts`) now derives `textureKey` from the
manifest **map key** (unique by construction, e.g. `bent-pipe-v1-var-1`) rather
than `spriteName`. This self-heals all existing data — including the user's local
`skull-mace` — with zero migration. `approve.ts` additionally writes
`spriteName = variantId` and catalog `spriteId/label = variantId` going forward so
new data is internally consistent.

### Registry groups variants by brief

The registry groups entries by `briefId`: `entries()` flattens all variants (so
the preloader queues every one), `variants(briefId)` returns a brief's variants
sorted deterministically (by `variantIndex` then `textureKey`), and
`lookup(briefId)` keeps back-compat by returning the first variant.

### Seeded runtime selection

`pickGeneratedVariant(registry, briefId, seed)` selects one variant via
`new SeededRandom(seed).pick(variants)` — never `Math.random`. `GameWorld` gained
a `readonly seed` (`options.seed ?? 42`). `InventoryUI` seeds selection with
`hashStringToSeed(itemId) ^ world.seed`, so the choice is stable per (item, run),
varies across runs, and never touches gameplay RNG (`world.rng`).

### Approval policy

`approveVariant` blocks re-approving an exact-duplicate variant key with
`ApproveError('already-approved')`; the sidecar maps it to HTTP 409. The DevTools
UI blocks exact duplicates locally and `confirm()`s before approving an
additional variant of a brief that already has approved art.

### Check-in: branch + issue, no PR

`scripts/sprites/checkin.ts` publishes locally-approved art as a dedicated
`assets/<slug>` branch (the art-surface delta off `main`, cut in a throwaway
`git worktree` so the session branch is untouched) and files an `asset-checkin`
tracking issue — **no PR**. The issue body embeds a machine-readable
`asset-checkin:v1` JSON payload. A pure `planAssetCheckin()` builds the plan; an
injected-IO `runAssetCheckin()` performs the git/gh side effects (unit-tested with
a fake exec). It is exposed three ways: `npm run sprites:checkin`, the sidecar
`POST /api/checkin`, and (transitively) the gallery/e2e flow. Like approve, it
**refuses under CI** (Constitutional §3).

### Consolidation skill

`.github/skills/asset-pr/` (+ `npm run sprites:asset-pr`) lists every open
`asset-checkin` issue and folds their branches into one `assets/batch-<stamp>`
branch: PNGs are copied binary-safely via `git checkout <ref> -- <path>`, and the
two shared JSON files (`manifest.json`, `sprite-catalog.json`) are unioned with
the pure `mergeManifests` (by entry key) / `mergeCatalogs` (by `id`) helpers,
avoiding the guaranteed N-way merge conflict on those files. One PR is opened that
`Closes #<n>` each source issue.

### Art-only CI lane

A `changes` job runs `scripts/agent/ci/detect-art-only.sh`. When every changed
file is under `public/assets/generated/**` or `src/shared/data/sprite-catalog.json`,
the heavy gates (integration, headless, e2e, build) are skipped via
`if: needs.changes.outputs.art_only != 'true'`, and the merge-gate treats those
skipped jobs as PASS (its `check()` already supports an `allow_skipped` argument).
typecheck/lint/format/unit always run. The detector fails safe to "not art-only"
on any ambiguity.

## Consequences

### Positive

- Approved variants render correctly; existing data self-heals with no migration.
- Multiple variants per item are first-class, with deterministic, replay-safe
  runtime selection.
- Exact-duplicate approvals are impossible; new-variant approvals are explicit.
- Art ships through a lightweight branch+issue flow that batches into one PR,
  keeping the PR queue uncluttered.
- Art-only changes get a fast CI lane, saving minutes per asset change.

### Negative

- More moving parts in the sprite pipeline (check-in + consolidation + CI lane).
- The check-in/consolidation executors do real git/gh work that can only be
  fully exercised on a dev box; unit tests cover the pure logic + command
  sequencing with fakes, not a live push.

### Risks

- A pruned `assets/<slug>` branch breaks consolidation for that issue (handled in
  the skill's §Recovery: close the stale issue or re-check-in).
- The art-only detector is a heuristic; force-pushes or odd history fall back to
  the full suite (safe, just slower). Mitigated by `fetch-depth: 0` + a two-dot
  diff fallback.

## Alternatives Considered

- **Migrate all `spriteName` values instead of deriving `textureKey` from the map
  key.** Rejected: deriving from the key self-heals existing + local data with
  zero migration; the data rewrite was kept only as cosmetic alignment.
- **Open a PR per check-in.** Rejected: approving art is high-frequency and
  low-risk; per-approval PRs would flood the queue. Branch+issue then one
  consolidated PR is far lighter.
- **`git merge` the check-in branches during consolidation.** Rejected: every
  branch edits the same two JSON files off `main`, so a merge conflicts every
  time. A deterministic key/id union is reproducible and conflict-free.
- **Path filters (`on.push.paths`) for the CI optimization.** Rejected: path
  filters can't express "skip these jobs but still satisfy the required
  merge-gate". A `changes` job feeding `if:` guards keeps the required aggregate
  green while skipping heavy work.
