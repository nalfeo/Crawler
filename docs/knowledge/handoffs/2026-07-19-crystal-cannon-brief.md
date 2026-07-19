# Handoff: crystal-cannon weapon brief (Floor 2 firearm wave)

## Date

2026-07-19

## Persona

Graphics Designer

## Session slug

crystal-cannon-brief

## Systems touched

sprite-workflow

## Apples

Estimated 1🍎, actual 1🍎 (pure art brief — review-ledger exempt, art-only fast lane).

## Closes

#1334

## What changed

- Added `briefs/weapons/crystal-cannon.yaml` — the sprite generation brief for the Floor 2 crystal-cannon equipment icon.

### Brief design decisions

| Decision        | Choice                        | Reason                                                                                                                             |
| --------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Orientation     | Vertical (default)            | Barrel-up, grip-at-bottom is the standard firearm weapon stance matching all other Floor 2 firearms                                |
| Anchor          | Default `(32, 56)`            | Grip base near frame bottom, matching `weapon.json` type defaults                                                                  |
| Floor           | 2                             | Equipment icon is a Floor 2 item                                                                                                   |
| Visual theme    | Crystal/arcane energy cannon  | Distinguishes crystal-cannon from industrial firearms (cog-pistol, rivet-gun) in the same wave via a faceted crystal power chamber |
| Variation seeds | 3 authored + minVariations: 8 | Spiral barrel / twin crystal shards / blunderbuss flare cover visually distinct shape variants; 8 total ensures pipeline diversity |
| Judge           | Enabled (inherited)           | VLM judge from `data/sprite-types/weapon.json` defaults rejects variants scoring < 3/5                                             |

### Key visual spec

Wide hexagonal dark-metal barrel + large geometric crystal chamber (deep blue/violet, iron claw housing) + dark leather grip with brass bands. No active glow/beam — weapon at rest. Silhouette reads as a heavy cannon, not a wand or staff.

## Pre-code plan

Per @nalfeo's request, plan posted here (GitHub CLI not available in CI environment, same constraint as musketeer-rifle handoff):

**Approach:** Add `briefs/weapons/crystal-cannon.yaml` — the sprite generation brief for the Floor 2 crystal-cannon equipment icon (`equipment/weapon/crystal-cannon`). Pure art-brief file; no gameplay/runtime code changes. Brief seeds the Azure OpenAI sprite pipeline.

**System:** `sprite-workflow` (brief authoring only). **Apple estimate:** 1🍎.

**Checklist:**

- [x] Create `briefs/weapons/crystal-cannon.yaml` with visual spec, 3 variation seeds, `minVariations: 8`
- [x] Validate schema: `npm run sprites:run -- --brief briefs/weapons/crystal-cannon.yaml` loads cleanly (no schema errors)
- [x] Run `npm run verify:fast` — all tests pass
- [x] Write session handoff
- [x] Open PR closing issue #1334
- [ ] Generation (requires local Azure credentials): `npm run sprites:run -- --brief briefs/weapons/crystal-cannon.yaml`
- [ ] Approval + check-in: `sprites:approve` → `sprites:checkin` → `asset-checkin` issue
- [ ] Batch PR: `asset-pr` skill

## Infrastructure constraints

- **GitHub CLI (`gh`) not available** in CI environment for write operations (same as musketeer-rifle and other brief sessions). Plan is documented here and in the PR description per AGENTS.md policy ("Plans stay in session chat").
- **Azure OpenAI credentials not available** in CI environment. Generation must be run locally via `npm run sprites:run -- --brief briefs/weapons/crystal-cannon.yaml` with `.env.local` Azure credentials, or via the sidecar gallery.

## Pipeline next steps

> **Note:** `asset-request.yml` is issue-driven — it calls `synthesizeBrief` from
> the issue body payload. To run this pre-authored brief, use
> `npm run sprites:run -- --brief briefs/weapons/crystal-cannon.yaml` locally
> (requires `.env.local` Azure credentials) or via the sidecar gallery.

1. **Generation**: `npm run sprites:run -- --brief briefs/weapons/crystal-cannon.yaml` with Azure credentials in `.env.local`
2. **Approval**: `npm run sprites:approve -- <runDir> --variant <N>` on the winning variant
3. **Check-in**: `npm run sprites:checkin` → `asset-checkin` issue (art branch, no PR)
4. **Batch PR**: `asset-pr` skill consolidates into one art-only PR

## Observe before done

- Before: No brief existed for crystal-cannon; no sprite brief file for this Floor 2 firearm weapon icon.
- After: Brief committed to `briefs/weapons/crystal-cannon.yaml`. `npm run sprites:run -- --brief briefs/weapons/crystal-cannon.yaml` loads the brief cleanly with no schema errors (only expected Azure credential failure). `verify:fast` passes 1295/1295 tests.

## Verification run

- `npm run sprites:run -- --brief briefs/weapons/crystal-cannon.yaml` — schema valid, no schema errors ✅
- `npm run verify:fast` — 1295 tests, 89 test files, all pass ✅
