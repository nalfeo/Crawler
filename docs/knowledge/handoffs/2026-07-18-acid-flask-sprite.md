# Handoff: acid-flask weapon sprite — Floor 2 equipment wave

**Date:** 2026-07-18  
**Session slug:** acid-flask-sprite  
**Closes:** nalfeo/Crawler#1345  
**Aggregate:** nalfeo/Crawler#1303 (G2-B: Floor 2 equipment sprite waves)  
**Apples:** 1🍎 estimated → 1🍎 actual  
**Branch:** `copilot/add-acid-flask-icon`  
**Wave:** `floor2-equipment-weapon-thrown`

## Systems touched

sprites (brief only — no wiring, no registry, no engine changes)

## What was done in this session

### 1. Brief authored — `briefs/weapons/acid-flask.yaml`

Authored a detailed weapon brief covering:

- **Shape:** squat round-shouldered or teardrop flask held vertically (weapon-default orientation)
- **Liquid:** vivid acid-green (#7fff00 range) or yellow-green, two-thirds fill with visible liquid level line
- **Glass:** pale amber or pale-green tint, thin dark outline, one glass-sheen highlight on the left edge
- **Stopper:** dark cork, wax blob, or metal crimp cap
- **Silhouette cue:** "small corked bottle/flask" at a glance — not a potion, not a barrel, not a grenade
- **No glow, no cracks, no enchantment** (un-thrown weapon)
- Three seed variations + `minVariations: 8`
- Inherits weapon-type defaults (vertical orientation, 64×64, 4×4 sheet, anchor at grip base)

### 2. GitHub Actions workflow — generation in progress

Issue #1345 (`asset-request: acid-flask`) was already labeled `asset-request` (by repo owner nalfeo) before this session.  
This triggered `asset-request.yml` run #483 / job `88028389035` which is **draining the sprite queue** (including acid-flask) via the Azure worker.

**Pipeline flow for the CI run:**

1. Ingest step (completed ~01:53 UTC): scanned open `asset-request` issues, enqueued acid-flask
2. Drain worker (in_progress since ~01:53 UTC): generates sprites via Azure OpenAI, stores in Azure Blob storage
3. On completion: posts a success comment on issue #1345 with `brief: acid-flask` and `runId: <uuid>`
4. Does NOT check-in or create a PR (both are hard-blocked in CI per Constitutional §3)

### 3. Blockers encountered

| Blocker                         | Root cause                                                                      | Cannot workaround                                                         |
| ------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `sprites:run` fails locally     | `AZURE_OPENAI_ENDPOINT` not set — setup script skips when `CI=true` is detected | By design: Azure-required sidecar policy, CI env has no local Azure creds |
| `sprites:checkin` hard-blocked  | `CI=true` → Constitutional §3 guard                                             | By design: local-only mutation rule                                       |
| `sprites:asset-pr` hard-blocked | `CI=true` → Constitutional §3 guard                                             | By design: local-only mutation rule                                       |

## Recovery: what the local operator must do

After GitHub Actions run #483 posts a success comment on issue #1345 (look for `brief: acid-flask`, `runId: <uuid>` in the comments):

```bash
# 1. Ensure Azure credentials are loaded
pwsh scripts/setup-azure-env.ps1 -IncludeStorage

# 2. Start the gallery sidecar (loads .env.local, opens at http://localhost:23370)
npm run sprites:gallery

# 3. In the gallery: navigate to the acid-flask run, review the 4×4 sheet,
#    apply the sprite-judge eyeball checklist, pick the best variant.
#    OR: approve from CLI using the runId from the issue comment:
npm run sprites:approve -- generated/runs/acid-flask/<runId> --variant <N>

# 4. Check in the approved art (creates asset-checkin branch + issue)
npm run sprites:checkin

# 5. Batch into an art-only PR (folds all open asset-checkin issues into one PR)
npm run sprites:asset-pr

# 6. Arm auto-merge (art-only diff, review-ledger-exempt)
gh pr merge --auto --squash <pr-number>
```

### If the CI run timed out (25-minute job limit)

The workflow may have processed a partial queue. If issue #1345 does NOT get a success comment:

- Re-trigger: `gh workflow run asset-request.yml` (or re-label the issue to fire a new run)
- The queue is deduped — re-queuing acid-flask is safe; the state file tracks whether it was already processed

### Wiring status

**No wiring code PR is needed at this time.** Item icon auto-resolution rules apply:

```
itemId === briefId === 'acid-flask'
manifest key → 'acid-flask-var-<N>'
runtime key → 'equipment/weapon/acid-flask'
```

The stable ID `weapon.acid-flask` → runtime key `equipment/weapon/acid-flask` is declared in `FLOOR2_EQUIPMENT_ART_DEFINITIONS`. Once the PNG and manifest entry land on `main`, the engine's equipment icon resolver picks it up automatically. Run `npm run sprites:placeholder-audit` after the art PR merges to confirm no dangling placeholder remains.

## Sprite-judge pre-flight (brief expectations for the local review)

Apply the **sprite-judge** eyeball checklist to the generated sheet:

| Check                | Expectation                                                                       |
| -------------------- | --------------------------------------------------------------------------------- |
| Silhouette           | Reads as "small corked bottle" at 64×64; not a circle, not a barrel               |
| Orientation          | Vertical — bottle upright, stopper at top, grip at bottom                         |
| Acid liquid          | Vivid acid-green or yellow-green; clearly dominant saturated hue inside the glass |
| Glass tint           | Pale amber or pale green; thin brittle-looking walls                              |
| Stopper              | Cork, wax blob, or metal cap — clearly seated at neck                             |
| No magic             | No glow, no aura, no cracks, no splash                                            |
| Background           | Transparent or high-contrast flood-fill color (no black)                          |
| Sensor: orientation  | `vertical` within ±5° — no diagonal override needed                               |
| Sensor: anchor       | Grip-base pixel (center-bottom region) is opaque                                  |
| Sensor: alpha-binary | No partial-transparency pixels                                                    |

Never loosen a sensor or lower the judge bar to force a pass — fix the brief instead.

## Files committed in this session

| File                                                      | Change                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `briefs/weapons/acid-flask.yaml`                          | New — detailed weapon brief for the acid-flask thrown weapon |
| `docs/knowledge/handoffs/2026-07-18-acid-flask-sprite.md` | This handoff                                                 |
