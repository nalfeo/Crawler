# Handoff: grave-shovel weapon brief

**Date:** 2026-07-18  
**Session type:** Art pipeline (brief commit, no code change)  
**Branch:** `copilot/asset-request-grave-shovel`  
**Apple estimate:** 🍎🍎 (apple complexity scale; see `docs/agent-os/policies/complexity-policy.md`)

## Summary

Committed the `briefs/weapons/grave-shovel.yaml` sprite brief for the Floor 2
equipment wave (`floor2-equipment-weapon-polearm`). The brief describes a
vertical polearm weapon with a wide rusty iron spade-head blade, weathered
wooden haft, and grave-soil markings. Issue target runtime key:
`equipment/weapon/grave-shovel` (brief `name: grave-shovel` is the art/brief id;
runtime key wiring is handled in a later wiring step).

The brief is authored according to the weapon type defaults
(`data/sprite-types/weapon.json`): 4×4 sprite sheet, anchor at center-bottom
of the grip, vision-language model (VLM) judge enabled. No type overrides were
necessary — the default vertical polearm orientation is correct for this asset.

## Files Touched

- `briefs/weapons/grave-shovel.yaml` — new brief (25 lines)
- `docs/knowledge/handoffs/2026-07-18-grave-shovel-brief.md` — this handoff

## Workflow State

The `asset-request.yml` GitHub Actions pipeline will generate sprites from this
brief. At handoff time:

- **Run #484** (`workflow_dispatch`, status: pending) is queued and will scan
  all open `asset-request` issues (including #1321) and enqueue them into the
  Azure Storage Queue.
- **Run #483** (`surveyor-map`, status: queued) will drain before #484 processes.
- Azure credentials are only available in GitHub Actions (not in local CI runner
  environment), so local generation is blocked.
- Issue #1321 ("Asset request: grave-shovel") is open with `asset-request` label
  and will be picked up when the queue drains.

## Verification Run

- `npm run verify:fast` — ✅ passed (87 test files, 1260 tests)
- `npm run verify:pr-prereqs` — ✅ passed after handoff added

## Unresolved Issues

- **Art not yet generated:** The PR ships only the brief. Sprites will be
  generated when Run #484 (or a subsequent `workflow_dispatch`) completes and
  the Azure pipeline processes issue #1321.
- **Check-in pending:** Once the workflow posts a completion comment with
  `brief: "grave-shovel"` and `runId`, the approve → checkin → asset-pr flow
  needs to run. Commands:
  ```
  npm run sprites:approve -- <runDir> --variant <N>
  env -u CI npm run sprites:checkin
  env -u CI npm run sprites:asset-pr
  ```

## Recommended Next Steps

1. Monitor issue #1321 for a completion comment from the Asset Request Pipeline.
2. Run `npm run sprites:approve` on the generated variants using `sprite-judge`
   verdicting criteria.
3. Run `env -u CI npm run sprites:checkin` to publish approved art.
4. Run `env -u CI npm run sprites:asset-pr` to consolidate into one art PR that
   closes issue #1321 and references #1303.
5. After art PR merges, run `npm run sprites:generate-wiring -- --since main` to
   detect any wiring opportunities.

## Systems Touched

`sprites`
