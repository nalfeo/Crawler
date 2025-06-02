# Handoff: Spike Shield weapon sprite (Floor 2 trap wave)

**Date:** 2026-07-18  
**Session slug:** spike-shield-asset-forge  
**Related:** #1347  
**Apples:** 1🍎 (art-only) — review-ledger-exempt  
**Branch:** `copilot/add-spike-shield-icon`

## Systems touched

- `briefs/weapons/` — new brief authored
- `public/assets/generated/` — pending (needs art generation)
- `src/shared/data/sprite-catalog.json` — pending (updated by checkin)
- Equipment wiring — pending (auto-resolves via briefId=`spike-shield`)

## What was done

Authored the `briefs/weapons/spike-shield.yaml` for the Floor 2 trap-wave
weapon. The brief is Zod-valid, inherits all defaults from
`data/sprite-types/weapon.json` (64×64, kenney-roguelike palette, vertical
orientation, VLM judge enabled), and is minimal/focused per style guide.

### Brief design decisions

| Decision      | Choice                                               | Rationale                                                             |
| ------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| Orientation   | vertical (default)                                   | Shield face up, grip at bottom — standard weapon stance               |
| Subject shape | Round or kite shield with 5–7 protruding iron spikes | "Silhouette must read as shield at a glance" — not mace, not sunburst |
| Palette       | kenney-roguelike (inherited)                         | Consistent with Floor 2 weapon family                                 |
| Judge         | enabled (inherited)                                  | Quality gate via VLM                                                  |
| Anchor        | (32, 56) — bottom-center grip (inherited)            | Engine attaches effects at grip                                       |

### Blocker: Azure credentials not available in coding agent environment

The coding agent environment (`CI=true`) does not have `AZURE_OPENAI_ENDPOINT`
or `AZURE_OPENAI_API_KEY`. Per AGENTS.md "Azure-required sidecar policy", the
agent cannot silently fall back — generation is blocked.

**Issue #1347 is also missing the `asset-request` label.** The label is
required for the `asset-request.yml` workflow to pick up the issue. All other
Floor 2 equipment weapon issues (void-rapier #1361, venom-dirk #1326,
iron-cleaver #1315, dueling-saber #1311) have the label and were successfully
generated on 2026-07-18 at ~03:40 UTC.

## What remains (for next session or maintainer)

### Step 1 — trigger art generation (maintainer action)

Add the `asset-request` label to issue #1347. This triggers the
`asset-request.yml` GitHub workflow, which will:

1. Ingest the issue into the Azure queue
2. Synthesize a brief (uses `briefs/weapons/spike-shield.yaml` or generates one from the issue body)
3. Generate the sprite sheet (Azure OpenAI)
4. Post-process, judge, and approve the best variant
5. Store the run in Azure Blob and post a "✅ pipeline complete" comment on #1347

OR run: `gh workflow run asset-request.yml` (sweep runs pick up all labeled issues)

### Step 2 — approve and check in (agent or maintainer with gallery sidecar)

After the workflow completes:

1. Open gallery sidecar: `npm run sprites:gallery`
2. Find the `spike-shield-v1` run
3. Review the 16 variants using the sprite-judge skill (eyeball + sensor scores + VLM)
4. Approve the winner: `npm run sprites:approve -- <runDir> --variant N`
5. Check in: `npm run sprites:checkin`

### Step 3 — batch PR (asset-pr skill)

```bash
npm run sprites:asset-pr
```

This consolidates all open `asset-checkin` issues (including spike-shield) into
ONE art-only PR. The PR closes issue #1347 and targets the base branch
(`nalfeo-floor-2-equipment-placeholders` or `main`).

### Step 4 — wire (code PR, separate)

After art merges, run:

```bash
npm run sprites:generate-wiring -- --since main
```

Wire the sprite into the equipment system:

- Runtime key: `equipment/weapon/spike-shield`
- The briefId `spike-shield` should auto-resolve via the manifest/catalog key

Wiring is a full-gate code PR: `npm run verify:fast`, apple-scaled review, ledger.

### Step 5 — observe

Confirm `equipment/weapon/spike-shield` renders at game scale in `npm run dev`
or the equipment lab. State before/after observation in the wiring PR.

## Files in this handoff branch

| File                                             | Status                    |
| ------------------------------------------------ | ------------------------- |
| `briefs/weapons/spike-shield.yaml`               | ✅ authored and committed |
| `public/assets/generated/spike-shield-var-N.png` | ⏳ pending generation     |
| `src/shared/data/sprite-catalog.json`            | ⏳ pending checkin        |
| `public/assets/generated/manifest.json`          | ⏳ pending checkin        |

## Notes on the brief

The brief intentionally matches the issue brief verbatim:

> "Spike Shield Floor 2 equipment icon for stable runtime key
> `equipment/weapon/spike-shield`. Create one centered, silhouette-readable
> trap weapon on a transparent background; preserve the runtime key exactly."

Added explicit spike-count (5–7), silhouette constraints ("not a mace, not a
sunburst"), and material specification (aged dark iron, rust-orange,
dark-steel-grey) to give the model clear constraints without over-specifying.
The grip anchor constraint is called out explicitly ("grip/handle must be
opaque at the bottom-center for the anchor pixel") to prevent anchor failures.
