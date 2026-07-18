# 2026-07-18 — bone-chakram Floor 2 equipment icon

## Summary

Added the sprite brief for the `bone-chakram` Floor 2 thrown-weapon equipment icon (issue #1359). The brief is authored and committed; the actual image-generation step requires the `asset-request.yml` CI workflow to run with Azure OpenAI credentials.

## Systems touched

`sprites`, `briefs`

## What was done

1. **Brief authored** — `briefs/weapons/bone-chakram.yaml`
   - Type: `weapon` (inherits from `data/sprite-types/weapon.json`)
   - Orientation: `diagonal` (same as `compact-disk`, the other thrown ring weapon)
   - Anchor: `{x: 32, y: 40}` (center of ring body; default grip anchor is too low)
   - `diagonalToleranceDeg: 10` — ring has no strong principal axis, needs wider window
   - VLM judge enabled (inherited from weapon type defaults)
   - Variations seeded with bone-texture cues: cracked ring with bone-splint repair, engraved spiral grooves

2. **Branch rebased on main** — merged `84489aa6` (latest main) into `copilot/add-bone-chakram-icon`

3. **verify:fast passed** — 1260 tests, 87 suites, all green

## What remains

- **Image generation**: The `asset-request.yml` CI workflow needs to run to completion for issue #1359. Both prior runs (01:27:50 and 02:17:10 UTC 2026-07-18) were cancelled before generation completed. A fresh `workflow_dispatch` or issue edit will trigger a new run.
- **Approve/check-in/batch PR**: After a successful CI run produces generated variants, use `npm run sprites:approve` + `npm run sprites:checkin` + `npm run sprites:asset-pr`.
- **Wiring**: `equipment/weapon/bone-chakram` runtime key needs to be wired once the art-only PR merges. Run `npm run sprites:generate-wiring -- --since main` to produce the wiring patch.

## Apple estimate

- Brief + PR: **1🍎** art lane (review-ledger exempt)
- Wiring: **1🍎** code PR (full gates required)

## Lessons learned

- The coding agent environment has no `AZURE_OPENAI_*` credentials — generation must go through the `asset-request.yml` CI workflow
- GitHub API (`api.github.com`) is blocked by DNS monitoring proxy in this environment; only the local git proxy at `localhost:26831` is accessible for push/pull
- GitHub MCP server tools (read-only) work and can be used to inspect issues and workflow runs
- The asset-request workflow for bone-chakram was triggered twice but both runs were cancelled; investigation of why is needed

## PR

Draft PR #1429: https://github.com/nalfeo/Crawler/pull/1429
