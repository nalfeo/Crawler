# Handoff: crescent-glaive issue #1341 audit

**Date:** 2026-07-18  
**Issue:** #1341  
**Persona:** Graphics Designer  
**Apples:** 1🍎 estimated → 1🍎 actual

## Systems touched

sprite-pipeline, asset-request workflow, GitHub Actions recovery

## What changed

- Authored the canonical source brief:
  - `briefs/weapons/crescent-glaive.yaml`
- Added this handoff documenting the reachable `crescent-glaive` asset state and blockers.
- Deliberately made **no** changes to generated assets, manifests, check-in metadata, or placeholder wiring because no normal pipeline-owned approved artifact was reachable from this sandbox.

## Audit findings

1. **No approved `crescent-glaive` asset exists on `main` in the checked-out repo state.**
   - Local search found only the newly-authored `briefs/weapons/crescent-glaive.yaml`.
   - No `public/assets/generated/*crescent-glaive*` file exists locally.
   - No local manifest entry references `weapon.crescent-glaive`, `equipment/weapon/crescent-glaive`, or `crescent-glaive-var-*`.

2. **The authoritative asset-request branch only contains the brief.**
   - `origin/copilot/asset-request-crescent-glaive` contains `briefs/weapons/crescent-glaive.yaml`.
   - Draft PR #1412 currently has no file diff, so it offers no recoverable approved-art state.

3. **The normal issue-pipeline run for this request did not produce work artifacts.**
   - Workflow run **#29625225668** (`Asset request: crescent-glaive`) exists.
   - It was **cancelled almost immediately** with **zero jobs** and **zero artifacts**.
   - Therefore there is no normal workflow-owned sheet/run artifact to review, approve, or check in from this environment.

4. **A separate open PR exists, but it is not normal pipeline output.**
   - PR #1535 adds:
     - `public/assets/generated/equipment/weapon/crescent-glaive-placeholder.png`
     - a hand-edited manifest row keyed by `equipment/weapon/crescent-glaive`
   - Its content identifies itself as a **placeholder** (`sensorScore: "placeholder"`, `sourceRun: "floor2-equipment-placeholder/v1"`), not as output from `sprites:approve` / `sprites:checkin`.
   - I did **not** adopt or extend that PR because the issue explicitly requires normal sprite-pipeline rules and forbids hand-editing generated metadata outside normal tooling.

5. **The duplicate issue path also does not recover an approved asset.**
   - Duplicate issue #1441 was closed as a duplicate of #1341.
   - Its comments reference queueing, but no reachable approved asset/check-in branch/manifest entry/artifact was found from that path.

## Validation / review status

- Preflight completed successfully via `bash scripts/agent/preflight.sh`.
- Baseline `npm run verify:fast` completed successfully **before** the audit-only blocker investigation.
- Brief validation succeeded via `loadBrief('./briefs/weapons/crescent-glaive.yaml', ...)`.
- Reviewed:
  - `docs/agent-os/personas/graphics-designer.md`
  - `docs/agent-os/sprite-style.md`
  - `.github/skills/sprite-judge/references/rubric.md`
- No sprite sheet existed to post inline or judge.
- No `sprites:run`, `sprites:approve`, or `sprites:checkin` action was possible here because the required Azure env is unavailable in this coding-agent CI environment.

## Blockers

- `npm run sprites:run -- --brief briefs/weapons/crescent-glaive.yaml` cannot run here because `AZURE_OPENAI_ENDPOINT` is unavailable.
- `npm run setup:azure:env` intentionally exits early in cloud/CI, so this sandbox cannot bootstrap the sidecar creds locally.
- The normal CI issue-pipeline run for this issue was cancelled before jobs started, leaving no artifacts to recover.
- This sandbox has no working authenticated path to post the required issue-plan comment or manually dispatch the asset-request workflow as a maintainer.

## Recommended next recovery step

Use a **normal supported write-capable environment** to do one of the following:

1. Re-dispatch `.github/workflows/asset-request.yml` for issue #1341 so the Azure-backed worker can generate/judge the sheet, then approve/check in the winning variant normally; or
2. Run the Azure-backed local sidecar path outside CI (`sprites:run` → sprite-judge review → `sprites:approve` → `sprites:checkin`) and then batch via the art-only PR lane.

Until one of those succeeds, the correct minimal state for #1341 is **audit-only, no asset mutation**.
