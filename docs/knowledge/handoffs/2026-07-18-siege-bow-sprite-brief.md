# Handoff: siege-bow weapon sprite brief (2026-07-18)

## Status

**Brief authored and pipeline-ready. Generation blocked: Azure credentials unavailable in this runner.**

## What was done

- ✅ Authored `briefs/weapons/siege-bow.yaml` for the `siege-bow` Floor 2 weapon
- ✅ Brief validated against the Zod schema via `loadBrief()` (merges `data/sprite-types/weapon.json` defaults)
- ✅ `judge.enabled: true` added — the VLM judge will filter variants below score 3/5 on all four axes (design_language, reference_style_match, brief_match, readability)
- ✅ Committed to branch `copilot/create-siege-bow-icon-again`

## Brief specification

| Field                  | Value                                                                   |
| ---------------------- | ----------------------------------------------------------------------- |
| Runtime key            | `equipment/weapon/siege-bow`                                            |
| Type                   | `weapon`                                                                |
| Size                   | 64×64                                                                   |
| Palette                | `kenney-roguelike`                                                      |
| Sheet layout           | 4×4 grid, 16 variants, min 8 passing                                    |
| Orientation            | `vertical` (grip at bottom, limb tips at top)                           |
| `diagonalToleranceDeg` | 5° (tighter than default; vertical must read clearly)                   |
| `centerToleranceX`     | 5px (slightly relaxed vs default; oversized limbs are inherently wider) |
| `judge.enabled`        | `true`                                                                  |
| Anchor                 | Derived from grip band (bandRows: 4)                                    |

### Brief subject

> A massive, heavy-duty siege bow held vertically, limb tips at the top, grip straight down. Oversized recurved limbs — much thicker and wider than a standard bow — reinforced with iron bands or straps. A thick bowstring under tension. Worn dark wood with iron/steel reinforcement bands; steel-grey metal fittings. No arrows, no glow, no enchantment. Silhouette must read as an imposing, siege-scale bow — not a sword or crossbow.

### Variations

1. Extra-wide recurved limbs with visible wood lamination
2. Iron-reinforced limbs with bolted metal plates along the length

## Blocker: Azure credentials unavailable

`sprites:run` requires `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` to call the image generation API. In this runner environment (`GITHUB_ACTIONS=true`), the `setup-azure-env.ps1` script correctly skips local `.env.local` bootstrap:

```
Cloud/CI environment detected - skipping local .env.local setup.
```

This follows **AGENTS.md §175–183** ("report the blocker and stop instead of silently falling back").

The `checkin.ts` module also refuses when `CI=true` (unless `SPRITES_ALLOW_CI_PIPELINE=true`), so the downstream approve → checkin → asset-PR steps also cannot run from this session.

## How to complete the pipeline

### Option A — Trigger via the `asset-request.yml` workflow (recommended)

The `asset-request.yml` workflow runs `sprites:ingest-once` + `sprites:worker` with full Azure secrets injected. It has `SPRITES_ALLOW_CI_PIPELINE=true` so the VLM judge fires correctly.

1. Ensure issue #1447 has the `asset-request` label (the workflow triggers on `labeled` events)
2. OR manually dispatch: `gh workflow run asset-request.yml`
3. After the workflow completes, it will post a comment on issue #1447 with a link to the run artifacts
4. Download the run from Azure Blob Storage and run `npm run sprites:approve -- <runDir> --variant <N>` on the winner
5. Run `npm run sprites:checkin` then `npm run sprites:asset-pr` to batch into the art PR

### Option B — Run locally with Azure credentials

```bash
# Bootstrap credentials
pwsh scripts/setup-azure-env.ps1 -IncludeStorage

# Warmup call (avoids cold-start "fetch failed" flake)
npm run sprites:run -- --brief briefs/weapons/some-small-brief.yaml

# Generate siege-bow
npm run sprites:run -- --brief briefs/weapons/siege-bow.yaml

# Approve, check-in, and batch PR
npm run sprites:approve -- generated/runs/siege-bow/<run-id> --variant <N>
npm run sprites:checkin
npm run sprites:asset-pr
gh pr merge --auto --squash
```

## Apple estimate

**1🍎 — art-only, no code changes.**  
Brief authoring + generate + approve + checkin + art PR. No wiring PR needed for this step; the item icon auto-resolves via `briefId === itemId` convention.

## Systems touched

| System                                | Change                                     |
| ------------------------------------- | ------------------------------------------ |
| `briefs/weapons/siege-bow.yaml`       | New brief authored                         |
| `public/assets/generated/`            | Will contain approved PNG after generation |
| `src/shared/data/sprite-catalog.json` | Will be updated by `sprites:approve`       |

## Wiring note

After the art PR merges, the siege-bow icon auto-resolves if the item's `itemId` matches the brief name (`siege-bow`). Verify with `npm run sprites:placeholder-audit` — if siege-bow appears in the wiring gap, a short wiring PR will be needed to add the manifest reference.

Co-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>
