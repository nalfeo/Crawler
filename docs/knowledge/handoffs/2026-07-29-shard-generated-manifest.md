# Handoff — Shard the generated manifest + derive the catalog

**Date:** 2026-07-29 · **Persona:** Producer · **Apples:** 4🍎 est → 5🍎 actual
**Branch:** `nalfeo-verbose-dollop` · **Slug:** `shard-generated-manifest`

## Systems touched

sprites, generated-assets, build-pipeline, ci

## What & why

Every art check-in appended to **two committed mega-files** —
`public/assets/generated/manifest.json` (463 entries / 21k lines, the true
source of truth) and `src/shared/data/sprite-catalog.json` (367 rows, 334 of
them derived `generated:` duplicates). Any two parallel art PRs therefore
conflicted **by construction** (measured: 4 simultaneously-conflicting sprite
PRs #2057/#1975/#2112/#2124). This is Fix 2 of a two-part effort; it supersedes
the sibling tactical Fix 1 (`sprites-derive-generated-catalog`).

## The fix

1. **Source of truth is now per-asset shards:**
   `public/assets/generated/entries/<manifestKey>.json`, one self-contained
   entry per file (verified: no cross-entry state). Two check-ins touching
   different assets never touch the same file.
2. **Overrides live on the entry:** optional `catalog?: { description?, tags? }`
   and explicit `placeholder?: true` added to the manifest-entry schema
   (`src/shared/generated-assets.ts` already `.passthrough()`). The 7
   hand-authored descriptions + 7 real tag overrides were migrated into their
   own shards — the manifest entry is now the single per-asset authority.
3. **Aggregate `manifest.json` is a build artifact, not committed:**
   `git rm --cached` + gitignored. A **Vite plugin** composes shards → serves
   `/assets/generated/manifest.json` in dev/preview (middleware) and emits it
   into `dist/` at build (`writeBundle`). `scripts/sprites/build-manifest.ts`
   (`npm run sprites:build-manifest`) writes it for non-Vite Node consumers.
   The browser still does **one** fetch (`preload.ts:51`, unchanged).
4. **Catalog stops committing `generated:` rows:** stripped 334 rows → 33
   committed rows remain (sheet + hand-authored). Generated rows are composed at
   read-time from the manifest via the shared portable composer
   `src/shared/generated-catalog.ts`. The lab's ad-hoc merge
   (`sprite-catalog-lab/index.ts`) now calls the composer (dedup + placeholder
   filtering built in) — no second merge path.
5. **CI invariants:** `npm run sprites:check-manifest`
   (`scripts/sprites/check-manifest.ts`) — 6 deterministic checks incl. a
   **resurrection guard** (the aggregate must NOT be git-tracked). Wired into
   `ci.yml`, gated on `!DOCS_ONLY`.

## Derivation rules (all verified against real data)

- `id`/`spriteId`/`label` derive from the **manifest map key**, never
  `spriteName` (an older writer wrote a brief-wide spriteName that collided
  variants).
- Tags: `type ? [type,'generated','pipeline-approved'] :
['generated','pipeline-approved']` — semantic type **first, not sorted**.
  `entry.catalog.tags` overrides when present.
- Description: `entry.catalog.description` else
  `Generated sprite from brief: <briefId>.`
- **Placeholder predicate is authoritative** (`isPlaceholderManifestEntry`):
  keys on explicit `placeholder` metadata, falling back to asset-path
  `-placeholder.png` — this catches the 2 hidden ones (`crescent-glaive`,
  `meteor-hammer`) that `spriteName`-based detection missed.

## Success gate — MET

**An `approve` → `checkin` end-to-end run produces a branch whose git diff is
exactly the one new PNG + its own `entries/<key>.json` shard (+ tracking
issue). No shared file is touched.** Verified via the approve→checkin
assertion; `sprites:check-manifest` composes 463 shards → 339 derived rows, 33
committed rows, aggregate not tracked.

## Observe-before-done (real artifacts, not a lab)

- `npm run verify:fast` → green (typecheck + lint + changed unit tests +
  size/weight coverage).
- `sprites:check-manifest` → 463 shards / 339 derived / 33 committed, all 6
  invariants pass incl. resurrection guard.
- Targeted suites green: `approve.test.ts` (34), `reconcile-queue.test.ts`
  (52), `generated-shards.test.ts` (17), `generated-catalog.test.ts` (17).
- The **Vite plugin** is the real runtime path — the browser fetches the
  composed aggregate at `preload.ts:51` (`DEFAULT_MANIFEST_URL`), unchanged, so
  the game still loads generated sprites in dev/preview/build.

## ⚠️ Sequencing / merge risk (READ BEFORE MERGE)

`git rm --cached manifest.json` is a one-time delete of the committed
aggregate. **Open art PRs that still modify it will conflict or silently
resurrect it on merge**, after which a stale committed aggregate would diverge
from the shards. Enumerated at handoff time:

- **#2083** — feat(sprites): add 67 approved assets (touches the aggregate)
- **#2089** — Add 60 approved generated assets (touches the aggregate)

Mitigation already in place: the **resurrection guard** in
`check-manifest.ts` fails the build (red check) if a committed `manifest.json`
reappears, so resurrection is loud, not silent. These PRs should be rebased
onto this change (or re-run their check-in) so they emit shards, not the
aggregate. #2276 (approve hard-block) touches `approve.ts` logic and should
rebase to pick up the shard-based `unapproveVariant`.

## Writer/reader surface migrated

`approve.ts` (`upsertCatalog`, `unapproveVariant`), `checkin.ts` /
`checkin-runtime.ts` / `queue-commit.ts` (`ASSET_SURFACE_PATHS`),
`asset-pr.ts`, `asset-request-publisher.ts`, `ci-harvest-approve.ts`,
`sidecar/server.ts`, `theme-equipment-runner.ts`, local writers
(`metadata-pipeline.ts`, `sort-assets.ts`, `sync-catalog.ts`,
`normalize-item-art-names.ts`, `reprocess-welcome-room-cli.ts`),
`reconcile-queue.ts` (shard-composed content hashes + `ART_SURFACE_ALLOWLIST`
write-vs-tolerate split), plus the `.mjs` editors
(`set-piece-editor`, `sprite-editor`, `workflow-model`) with inline shard
read/write (they cannot import the TS helper).

## Notable decisions

- **`unapproveVariant` unsafe-key handling:** `shardPathForKey` routes through
  `assertSafeManifestKey` (single trust boundary rejecting `..`/absolute/
  backslash keys). `unapproveVariant` catches that rejection and re-throws
  `UnapproveError('not-found')` **before any fs access**, so a traversal
  `variantId` never reads/unlinks outside `entries/`.
- **Schema `.strict()` rejected (empirical):** 5 shards
  (`equipment/weapon/{bone-saw,crescent-glaive,meteor-hammer,moon-scythe,tower-spear}`)
  carry a legit top-level `equipment` block the engine reads via
  `.passthrough()` — intentional forward-compat.
- **`asset-request-publisher.ts` hard-throw kept** (now "shard `<key>.json`
  missing") — intentional loud failure; complementary to `checkin-runtime.ts`'s
  skip.
- **`detect-art-only.sh` NOT edited** — bash `case` globs match `/`, so
  `public/assets/generated/*` covers `entries/**` for free; pinned by a test
  assertion instead.

## Review

4🍎 review harness complete — adversarial plan review (gpt-5.6-sol, 5
alternatives, convergent) + multi-model code review (claude-sonnet-4.6 /
gpt-5.3-codex / gemini-3.1-pro-preview, adjudicated by claude-opus-4.8, 2
rounds → clean). Ledger:
`docs/knowledge/review-ledgers/2026-07-29-shard-generated-manifest.review-ledger.json`
(validated, exit 0).
