# 2026-07-23 — Address Top 5 Merge Conflict Hot Spots

**Session slug**: `address-merge-conflict-areas`  
**Branch**: `copilot/address-merge-conflict-areas-again`  
**PR**: closes #1802  
**Apple estimate**: 3🍎 (tooling-only cap)

## Summary

Investigated git history since 2026-06-01 to identify the five most-conflicted
files, then implemented structural mitigations for each.

## Systems touched

ci-policy

## Root causes found

| Area | Frequency | Root cause |
|---|---|---|
| `docs/knowledge/handoffs/INDEX.md` | 37 changes, multiple "resolve conflict" commits | Concurrent agent sessions both running `npm run docs:index` after writing their handoff file. Every session regenerated the full INDEX from scratch, producing identical but divergent rewrites. |
| `public/assets/generated/manifest.json` | 31 changes | Out-of-order entries meant concurrent sprite PRs adding adjacent sprites would overlap lines. `approve.ts` already sorts on write, but the file had ~314 legacy unsorted entries. |
| `src/shared/data/sprite-catalog.json` | 17 changes | Same pattern as manifest.json. |
| `.github/scripts/ci-recovery/reconcile.mjs` + `reconcile.test.mjs` | 27+32 changes | High churn from active CI development. Already handled by `ci-conflict-coordinator` workflow (`CI_PATH_PREFIXES` covers `.github/scripts/`). No new mitigation needed. |
| `plans/item-icons/weapons.art.yaml` | 11 changes | Was high-traffic during Floor 2 weapon brief additions; B3 equipment refactor (afdbf2f) already cleaned it up. 23 Floor 1 entries remain — no longer a conflict hot spot. |

## Changes made

### 1. Agent guidance (AGENTS.md + .github/copilot-instructions.md)

Rule 5 in AGENTS.md now explicitly states: **Do NOT run `npm run docs:index`** to
rebuild `INDEX.md`. CI handles it automatically after each handoff merge. The
same note was added to `.github/copilot-instructions.md` Critical Rules.

Rationale: two concurrent sessions could each rebuild INDEX.md from the same
set of handoff files yet produce divergent diffs (ordering, whitespace, or
content differences from any handoff written between the two read passes).

### 2. docs-update.yml push trigger

Added `push: branches: [main]; paths: docs/knowledge/handoffs/2*.md` trigger.
INDEX.md is now rebuilt within ~1 minute of any handoff merge, rather than
waiting until Monday 09:00 UTC. The `paths` filter targets only date-stamped
handoff files (`2*.md`), not INDEX.md itself, preventing an infinite loop.

### 3. One-time sort of manifest.json + sprite-catalog.json

- `public/assets/generated/manifest.json`: ~314 legacy out-of-order entries
  sorted alphabetically by key. Matches the sort applied by `upsertManifest`
  in `approve.ts` on every write.
- `src/shared/data/sprite-catalog.json`: entries sorted: sheets first
  (`kind === 'sheet'`), then by `id` lexicographically. Matches `upsertCatalog`.

With both files fully sorted, concurrent PRs that each add entries at different
alphabetical positions produce non-overlapping line changes → git 3-way merge
succeeds without conflicts.

### 4. check:sort-assets CI guard

New blocking step `Asset sort check` in the `check-lightweight` CI job runs
`npm run check:sort-assets` (`scripts/sprites/check-sort-assets.ts`). Fails with
an actionable error if either file falls out of canonical sort order (e.g. from
a manual edit or a non-`approve.ts` write path).

Companion script `npm run sprites:sort-assets` (`scripts/sprites/sort-assets.ts
--apply`) normalizes both files in place.

### 5. Conflict-marker CI guard

New blocking step `Conflict-marker guard` in `check-lightweight` (runs before
all other checks) uses `git grep` to scan tracked text files for unresolved
`<<<<<<< / ======= / >>>>>>>` markers. Catches accidentally merged conflict
markers before they ship. Excludes binary and generated asset types
(`.png`, `.jpg`, `.ico`, audio, `.bin`, `.zip`).

## Verification

- `npm run check:sort-assets` → ✅ passes with freshly sorted files
- `scripts/sprites/check-sort-assets.ts` reviewed for correctness against
  `approve.ts` sort logic
- CI changes reviewed for idempotency (push trigger uses `paths` filter to
  prevent infinite re-trigger loop)
- No gameplay or runtime code changed — all changes are tooling/CI/docs

## Files changed

| File | Change |
|---|---|
| `AGENTS.md` | Rule 5: "Do NOT rebuild INDEX.md"; new command table rows |
| `.github/copilot-instructions.md` | Critical Rules: same INDEX.md guidance |
| `.github/workflows/docs-update.yml` | Push trigger for `docs/knowledge/handoffs/2*.md` |
| `.github/workflows/ci.yml` | `Conflict-marker guard` + `Asset sort check` steps |
| `package.json` | `check:sort-assets`, `sprites:sort-assets` scripts |
| `scripts/sprites/check-sort-assets.ts` | New CI validation script (Prettier-formatted) |
| `scripts/sprites/sort-assets.ts` | New fix-in-place script |
| `tests/unit/sprites/check-sort-assets.test.ts` | 17 regression tests for validators (Prettier-formatted) |
| `public/assets/generated/manifest.json` | One-time sort of all entry keys |
| `src/shared/data/sprite-catalog.json` | One-time sort of all entries |
