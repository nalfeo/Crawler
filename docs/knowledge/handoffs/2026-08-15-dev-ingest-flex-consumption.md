# 2026-08-15 — Dev-build ingest: Flex Consumption fix + real Azure provisioning

## Systems touched

devops, telemetry

## Summary

PRs #2922, #2925, #2928, #2952 shipped the code for dev-build run telemetry,
survey, and in-game issue filing, but **no real Azure infrastructure was ever
provisioned** to receive it — the storage container and Function App
described in `infra/README.md` did not exist. This session:

1. Deployed `infra/azure-storage.bicep` to create the missing `playtest-runs`
   blob container on the existing `crawlersprites` storage account.
2. Attempted to deploy `infra/dev-build-ingest.bicep` (classic Dynamic/Y1
   Function plan) and hit `SubscriptionIsOverQuotaForSku` — this subscription
   ("Visual Studio Enterprise Subscription") has a **hard 0 VM-core quota in
   every region**, and Y1 provisions against that quota even though it
   conceptually shouldn't need dedicated VMs. Confirmed across eastus,
   eastus2, westus2, centralus. Self-service `az quota` CLI increase did not
   complete in time (required registering `Microsoft.Quota` RP; subsequent
   `az quota show/list` still failed/empty).
3. **Rewrote `infra/dev-build-ingest.bicep` to use Flex Consumption (FC1)**
   instead of Dynamic (Y1). FC1 draws from a separate `Microsoft.Web` quota
   pool, not `Microsoft.Compute` VMs, and deployed successfully on the first
   try. Key changes: `sku: FC1/FlexConsumption`, `kind: functionapp,linux`,
   `reserved: true`, added a `${functionAppName}-deploy` blob container for
   FC1 package deployment, added a `functionAppConfig` block (deployment
   storage + auth, `node`/`22` runtime, `scaleAndConcurrency`), removed the
   Y1-only app settings (`FUNCTIONS_EXTENSION_VERSION`,
   `FUNCTIONS_WORKER_RUNTIME`, `WEBSITE_NODE_DEFAULT_VERSION`,
   `FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR`, `WEBSITE_RUN_FROM_PACKAGE`) —
   FC1 doesn't use them.
4. Deployed the updated bicep — **succeeded**. Function App
   `crawler-dev-ingest` is `Running` at `crawler-dev-ingest.azurewebsites.net`.
5. Built `functions/dev-build-ingest` and deployed it via
   `az functionapp deployment source config-zip` (zipping `dist/`, `host.json`,
   `package.json`, and only the **production** deps from `package-lock.json`).
   `npm ci`/`npm install` in that directory failed on a nested transitive dep
   (`strnum@2.4.2`, pulled in via an Azure SDK's XML parser) — the internal
   proxy 404s on that exact tarball while `npm view`/`npm pack` for the same
   package succeed; the public npm registry TLS-handshake-fails from this
   network. Worked around it by using `npm pack <pkg>@<version>` per missing
   package (works even when `npm install` doesn't) and copying already-resolved
   packages from the sibling repo-root `node_modules` for the rest, then
   compiling with `tsc` directly (copied from repo-root `node_modules/.bin`)
   instead of `npm run build`, then zip-deploying with `az functionapp
deployment source config-zip` instead of `func azure functionapp publish`
   (avoids needing the `func` CLI at all).
6. **Verified end-to-end**: `POST https://crawler-dev-ingest.azurewebsites.net/runs`
   with a malformed body returns `400 {"error":"runStats must be an object"}` —
   confirms the Function is live, routed, and validating requests correctly.
7. Added `VITE_RUNS_INGEST_URL: https://crawler-dev-ingest.azurewebsites.net/runs`
   to the `Build dev` step in `.github/workflows/deploy.yml` — this env var
   was never wired into the dev-build deploy pipeline, so even with a working
   Function the deployed dev build had no endpoint configured to send to.

## Files touched

- `infra/dev-build-ingest.bicep` — Y1 → FC1 Flex Consumption rewrite.
- `infra/README.md` — documented the quota workaround, the `npm ci` fallback
  (pack + manual tsc + zip-deploy), and current live-deployment status.
- `.github/workflows/deploy.yml` — added `VITE_RUNS_INGEST_URL` to the dev
  build env.

## Live Azure state after this session

- Resource group `crawler-sprites-rg` (eastus).
- Storage account `crawlersprites`: `playtest-runs` container now exists.
- Function App `crawler-dev-ingest`: Flex Consumption, Linux, Node 22,
  `Running`. `POST /runs` deployed and verified responding correctly.
- App settings present: `AZURE_STORAGE_CONNECTION_STRING`, `AzureWebJobsStorage`,
  `FUNCTIONS_REQUEST_BODY_SIZE_LIMIT`, `RUNS_CONTAINER=playtest-runs`,
  `ALLOWED_ORIGINS` (`https://nalfeo.github.io`, `http://localhost:5173`),
  `GITHUB_REPOSITORY=nalfeo/Crawler`.
- **`CRAWLER_CI_PAT` is NOT set** — telemetry ingest works without it; the
  survey/explicit "file an issue" path (which creates a GitHub issue) will
  fail until it's set. This requires a PAT scoped to `repo` (issue creation)
  on `nalfeo/Crawler`; I did not set my own CLI session token as a stopgap
  since that's a distinct security/ownership decision, not a routine
  engineering step — needs an explicit human-provided or newly minted
  service credential.

## Verification run

- `az functionapp show` confirms `state: Running`.
- Manual `Invoke-WebRequest POST /runs` with malformed body → `400` with
  `{"error":"runStats must be an object"}` (validation working, endpoint
  live).
- `npm run verify:pr-prereqs` passes (2🍎 infra/config change; no review
  ledger required per the tier matrix).

## Unresolved issues / recommended next steps

1. **Set `CRAWLER_CI_PAT`** on the Function App before relying on in-game
   issue filing (survey + F8 dialog). Command is in `infra/README.md`.
2. Confirm the exact CORS/allowed-origin list still matches the live GitHub
   Pages URL (`https://nalfeo.github.io`) — not changed in this session, just
   inherited from PR2's bicep.
3. Do a real end-to-end smoke test from the actual deployed dev build once the
   next `deploy.yml` dev build runs with `VITE_RUNS_INGEST_URL` set: trigger a
   death/quit/victory and confirm a blob lands in `playtest-runs`.
4. The `strnum@2.4.2` / internal-npm-proxy 404 issue is unresolved as a general
   problem (this session only worked around it for one build) — worth raising
   with whoever manages the corporate npm proxy allowlist, since it has now
   blocked `npm ci` in at least two separate sessions (PR4's `verify:fast`,
   and this session's function build).
