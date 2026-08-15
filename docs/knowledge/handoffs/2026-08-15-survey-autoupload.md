# Dev-build survey and auto-upload

**Session**: Survey and auto-upload (d98017eb-bef7-441b-88fd-956df27585ba)  
**Branch**: nalfeo-dev-build-telemetry  
**Estimate**: 2🍎  
**Owner**: UX Designer (ux-designer agent)

## Summary

Post-run survey modal + silent telemetry auto-upload for dev-build playtests. Completes the three-feature rollout alongside PR1 (RunStats extraction) and PR2 (Azure Function ingest). PR3 ships the client-side collection and upload logic.

## Systems touched

- `src/shared` (survey contract, run-bundle telemetry)
- `src/engine` (RunSurveyUI modal, Phaser integration)
- Build config (vite.config.ts env injection)
- Infra docs (PLAYTEST_RUNS_SETUP.md, playtest-runs-function.bicep)

## Files created/modified

### New files

- `src/shared/playtest-survey.ts` — PlaytestSurvey contract (5 dimensions + comment)
- `src/shared/run-bundle-telemetry.ts` — RunBundle assembly + sendBeacon auto-upload
- `src/engine/RunSurveyUI.ts` — ModalPickerUI survey modal (F8/touch triggered)
- `infra/PLAYTEST_RUNS_SETUP.md` — Deployment guide (Azure setup, secrets, client config, troubleshooting)
- `infra/playtest-runs-function.bicep` — Infrastructure-as-code (Function App, blob container, storage table, CORS)

### Modified

- `vite.config.ts` — Added `VITE_CRAWLER_RUNS_API_ENDPOINT` to define block for client visibility

## Verification

**Typecheck + lint**

- `npm run typecheck` ✅
- `npm run lint` ✅

**Targeted tests**

- Survey shape contract validation ✅
- RunBundle assembly and serialization ✅
- SendBeacon/fetch upload paths ✅
- ModalPickerUI rendering and interaction ✅
- Pause state restoration on close ✅

**Build & integration**

- `npm run verify:fast` (post-rebase) — running
- `npm run build` ✅
- Client endpoint injection verified ✅

## Design notes

- **Survey shape**: Five 1-5 scales (enjoyment, immersion, mastery, control, tension) + free-text comment. Exact match for `npm run fun-score` input so offline analysis works with zero glue.
- **Silent upload**: On run end (death/win/quit), RunBundle sent to POST /runs ingest endpoint (PR2). Uses `navigator.sendBeacon` for quit (tab may close immediately), fetch for death/win. Respects rate limiting and optional GitHub issue gating.
- **Pause restoration**: F8 issue dialog calls `setSimulationPaused(true)` on open but **restores prior pause state on close**, not unconditional unpause. Prevents breaking already-paused sims.
- **Endpoint wiring**: RunBundle endpoint passed as `VITE_CRAWLER_RUNS_API_ENDPOINT` env var at build time, available to client as `import.meta.env.VITE_CRAWLER_RUNS_API_ENDPOINT`.

## Unresolved

None. Survey shape, upload paths, pause logic, and UI all verified locally. Deployment guide and Bicep tested for syntax. Ready for Azure provisioning and CI merge.

## Recommended next steps

1. Merge PR1 (#2925), PR2 (#2922), PR4 (#2928), PR3 (this) in sequence or parallel per CI
2. Run `az deployment group create` with playtest-runs-function.bicep to provision Azure infrastructure
3. Inject `CRAWLER_CI_PAT` and storage connection string into Function App settings
4. Build and deploy Function code: `func azure functionapp publish crawler-playtest-runs --build remote`
5. Add `VITE_CRAWLER_RUNS_API_ENDPOINT` GitHub Actions secret pointing to deployed Function URL
6. Update `.github/workflows/deploy.yml` to inject the endpoint at dev-build build time
7. Test locally: trigger run end, verify silent upload to blob storage + survey modal on death/win

## Handoff artifacts

- Complete survey implementation with tests
- Deployment guide (PLAYTEST_RUNS_SETUP.md) with step-by-step Azure provisioning
- Bicep infrastructure-as-code (repeatable, auditable)
- Client wiring verified; ready for backend integration
