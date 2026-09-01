# Azure Storage — Setup & Operations

This document covers one-time Azure provisioning and the environment variables
that unlock the Azure backends for the sprite pipeline.

## What is provisioned

| Resource                        | Purpose                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Storage Account                 | Parent resource for blobs and queues                                                                                                             |
| Blob container `generated-runs` | Ephemeral sprite-generation artifacts (sheets, processed variants, scorecards, summaries) — replaces the gitignored local `generated/runs/` tree |
| Blob container `playtest-runs`  | Dev-build run bundles, feedback surveys, and optional screenshots                                                                                |
| Queue `asset-requests`          | Generation-request queue consumed by the worker                                                                                                  |

Approved sprites and metadata **stay in the git repo for now**. Nothing in this
setup touches `public/assets/generated/` or `src/shared/data/sprite-catalog.json`.

---

## Prerequisites

- [Azure CLI](https://docs.microsoft.com/cli/azure/install-azure-cli) installed and logged in (`az login`)
- An Azure subscription

---

## One-time provisioning

### 1. Create a resource group (skip if you already have one)

```bash
az group create \
  --name crawler-sprites-rg \
  --location eastus
```

### 2. Choose a storage account name

The name must be globally unique, 3–24 lowercase alphanumeric characters (no hyphens).
Suggestion: `crawlersprites` + a short suffix (your alias, date, etc.).

```bash
export STORAGE_NAME=crawlersprites       # change this
export RG=crawler-sprites-rg
```

### 3. Deploy the Bicep template

```bash
az deployment group create \
  --resource-group $RG \
  --template-file infra/azure-storage.bicep \
  --parameters storageAccountName=$STORAGE_NAME
```

The deployment takes ~30 seconds. It creates:

- The storage account
- The `generated-runs` blob container
- The `playtest-runs` blob container
- The `asset-requests` queue

### 4. Retrieve the access key

```bash
az storage account keys list \
  --account-name $STORAGE_NAME \
  --resource-group $RG \
  --query "[0].value" \
  --output tsv
```

Copy the output — this is your `AZURE_STORAGE_KEY`.

---

## Environment variables

Add these to your `.env.local` file (which is gitignored):

```dotenv
# ── Azure Storage ──────────────────────────────────────────────────────────
AZURE_STORAGE_ACCOUNT=crawlersprites          # your storage account name
AZURE_STORAGE_KEY=<paste key from step 4>

# Run store / asset queue backend selection.
# `sprites:run`, `sprites:batch` and the sidecar all default to Azure when
# credentials are present, and FAIL CLOSED rather than silently writing
# generated art to ephemeral local-only storage. Set `local` to opt explicitly
# into offline mode (runs generated that way cannot be approved into git).
SPRITES_RUN_STORE=azure-blob                  # 'local' | 'azure-blob'
SPRITES_ASSET_QUEUE=azure-queue               # 'noop' (default) | 'azure-queue'

# Optional overrides (uncomment to change defaults):
# AZURE_STORAGE_RUNS_CONTAINER=generated-runs
# AZURE_STORAGE_QUEUE_NAME=asset-requests
# AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT=900

# ── Shared resource cache (ADR 0065) ────────────────────────────────────────
# One content-addressable cache (npm `cacache`) fronts Azure Blob reads, shared
# by every worktree/session on the machine. Defaults below need no changes.
# CRAWLER_AZURE_CACHE=on                       # 'on' (default) | 'off' to disable caching
# CRAWLER_AZURE_CACHE_DIR=                     # cache base dir; default $COPILOT_HOME/crawler/azure-resource-cache
# CRAWLER_AZURE_CACHE_MAX_BYTES=5368709120     # unique-content LRU cap in bytes (default 5 GiB; 0 = unbounded)
# CRAWLER_AZURE_OFFLINE=off                    # 'on'/'1' serves reads from cache only, never contacting Azure
# Legacy aliases still honoured: SPRITES_AZURE_CACHE, SPRITES_AZURE_CACHE_DIR,
# SPRITES_AZURE_CACHE_MAX_BYTES, SPRITES_AZURE_OFFLINE.

# ── Azure AI Foundry (RETIRED — ADR 0072) ──────────────────────────────────
# Foundry vars are no longer read. Safe to delete from your .env.local.
# FOUNDRY_ENDPOINT=
# FOUNDRY_API_KEY=
# FOUNDRY_API_VERSION=
# FOUNDRY_IMAGE_MODEL=
# FOUNDRY_TEXT_MODEL=
# FOUNDRY_VISION_MODEL=
# FOUNDRY_BRIEF_SELECTOR_MODEL=
# SPRITES_PROVIDER=foundry             # ← now throws Unknown SPRITES_PROVIDER
# SPRITES_TEXT_PROVIDER=foundry        # ← now throws Unknown SPRITES_TEXT_PROVIDER
# SPRITES_SYNTH_PROVIDER=foundry       # ← now throws Unknown SPRITES_SYNTH_PROVIDER
# SPRITES_VISION_PROVIDER=foundry      # ← now throws Unknown SPRITES_VISION_PROVIDER
```

Alternatively, use a **connection string** (simplifies local Azurite use):

```dotenv
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net
SPRITES_RUN_STORE=azure-blob
SPRITES_ASSET_QUEUE=azure-queue
```

---

## Sidecar backend defaults

The sprite **sidecar** (`npm run sprites:gallery`, plus the DevTools/lab
workflow server) is wired to the shared Azure environment: it loads `.env.local`
and **defaults to the Azure backends** (`SPRITES_RUN_STORE=azure-blob`,
`SPRITES_ASSET_QUEUE=azure-queue`) even when those selectors are unset. If an
Azure backend is selected but no Storage credentials are found, the sidecar
**exits non-zero** with setup guidance instead of silently falling back to the
local filesystem.

The `local` / `noop` backends are still the `createRunStore` /
`createAssetQueue` factory defaults (used by tests and direct callers) and
remain selectable — they are simply no longer a silent fallback for the sidecar.
To run the sidecar fully local (offline, or in a test), opt in explicitly:

```bash
SPRITES_RUN_STORE=local SPRITES_ASSET_QUEUE=noop npm run sprites:gallery
```

---

## Generation durability (`sprites:run`, `sprites:batch`, `sprites:approve`)

Direct generation CLIs follow the **same** Azure-first policy as the sidecar.
`sprites:run` and `sprites:batch` resolve their run store through
`scripts/sprites/run-durability.ts`:

| `SPRITES_RUN_STORE` | Azure credentials | Result                                                                                |
| ------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| unset               | present           | **durable** — Azure, mirrored to `generated/runs/` for local review                   |
| unset               | missing           | **fails closed** with setup guidance (no silent local-only generation)                |
| `local`             | (any)             | explicit offline mode — clearly labelled `LOCAL ONLY`; publish after durable backfill |
| `azure-blob`        | present           | durable, mirrored                                                                     |

Every run additionally persists a `provenance/` record — the authored brief
verbatim (`provenance/brief.yaml`) plus the exact prompt, expanded effective
brief, reference-sprite and seed-frame provenance, and content hashes
(`provenance/prompt.json`) — so a run can be reproduced from durable storage
alone rather than only from a hash in `summary.json`.

`sprites:approve` then gates git publication on that durability: before it
writes a manifest `sourceRun` pointer or commits to `assets/queue`, it backfills
anything the durable store is missing from the local run directory and verifies
the required artifact set. If verification fails it exits **5** and publishes
nothing. The backfill is `has`-gated, so re-running a failed approve is
idempotent.

To generate offline (backfill to durable storage before approval into git):

```bash
SPRITES_RUN_STORE=local npm run sprites:run -- --brief <path>
```

---

## Automated setup (recommended)

Use the setup script to provision missing resources, fetch credentials, and
populate `.env.local`:

```powershell
# OpenAI account/deployments + Storage account/container/queue + local env vars
pwsh scripts/setup-azure-env.ps1 -ProvisionResources -IncludeStorage
```

To also push the same values into GitHub Actions secrets:

```powershell
pwsh scripts/setup-azure-env.ps1 -ProvisionResources -IncludeStorage -SyncGitHubSecrets
```

With `-SyncGitHubSecrets` the following repo secrets are written (for `nalfeo/Crawler` by default):

- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_CHAT_DEPLOYMENT`, `AZURE_OPENAI_VISION_DEPLOYMENT`
- `AZURE_OPENAI_IMAGE_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`
- `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_KEY`, `AZURE_STORAGE_CONNECTION_STRING`
- `AZURE_STORAGE_QUEUE_NAME`, `AZURE_STORAGE_RUNS_CONTAINER`
- `AZURE_STORAGE_PLAYTEST_RUNS_CONTAINER`
- `SPRITES_ASSET_QUEUE`, `SPRITES_RUN_STORE`

Use `-GitHubRepo owner/repo` to target a different repository.

## Dev-build ingest Function

The static dev build posts run bundles to the Azure Function in
`functions/dev-build-ingest`. The Function stores every accepted request in the
private `playtest-runs` container and only files a GitHub issue when a survey or
an explicit `file_issue` request is present.

Provision the Function App using the existing storage account. `githubCiPat` is
a **required, `@secure()` parameter with no default** — the deployment fails
up front (instead of silently succeeding without it) if you omit it. Pass it
from an environment variable so it never lands in shell history or a
committed file:

```powershell
az deployment group create `
  --resource-group crawler-sprites-rg `
  --template-file infra/dev-build-ingest.bicep `
  --parameters functionAppName=<globally-unique-name> storageAccountName=crawlersprites githubCiPat=$env:CRAWLER_CI_PAT
```

> [!IMPORTANT]
> `githubCiPat` must be a PAT scoped to `repo` (issues:write) on
> `nalfeo/Crawler`. Every deployment — first-time or a later update to any
> other setting — re-supplies this parameter; there is no default value to
> fall back to. This is intentional: it is what turns a missing GitHub
> credential into an immediate, loud deployment failure instead of a
> Function that silently returns HTTP 500 the first time a player reports an
> issue (see `tests/unit/dev-build-ingest-bicep.test.ts` for the contract
> test that fails if this wiring is removed or renamed).

> [!IMPORTANT]
> The template uses a **Flex Consumption (FC1)** plan, not the classic Dynamic
> (Y1) plan. Y1 provisions against the subscription's regional VM-core quota
> (`Microsoft.Compute`), and that quota is **0** on some subscription types
> (e.g. Visual Studio Enterprise) with no self-service increase path. FC1 draws
> from a separate `Microsoft.Web` quota pool and deploys successfully on those
> subscriptions. FC1 is **not** offered in every region that supports Y1, and
> the supported list changes over time — check it before deploying with
> `az functionapp list-flexconsumption-locations` and pick a listed region.
> Live deployment: `crawler-dev-ingest` in `crawler-sprites-rg` (eastus),
> state `Running`.

Build and publish the Function from its directory:

```powershell
Push-Location functions/dev-build-ingest
npm ci
npm run build
func azure functionapp publish <function-app-name> --javascript
Pop-Location
```

> [!NOTE]
> If `npm ci`/`npm install` in `functions/dev-build-ingest` fails on a nested
> transitive dependency (seen with `strnum@2.4.2` behind some corporate npm
> proxies that 404 on that specific tarball while `npm view`/`npm pack` for the
> same package succeed), you do not need working `npm install` for every
> package to deploy: `npm pack <name>@<version>` fetches the missing tarball
> directly, or you can build with `tsc` alone (once dependency folders are
> present) and zip-deploy without the `func` CLI:
>
> ```powershell
> az functionapp deployment source config-zip `
>   --resource-group crawler-sprites-rg `
>   --name <function-app-name> `
>   --src <path-to-zip-containing-dist+host.json+package.json+node_modules>
> ```
>
> Include only the **production** dependencies (`dependencies` in
> `package-lock.json`, not `devDependencies`) in the zip's `node_modules` to
> keep the package small.

The `githubCiPat` Bicep parameter (above) sets `CRAWLER_CI_PAT` as part of
deployment; never commit its value or put it in the browser bundle. To rotate
the credential without a full redeployment, you can still update the app
setting directly:

```powershell
# Store the new value in a local env-var first — never pass the raw token
# as a positional argument because command-line arguments land in shell
# history, process listings, and audit logs.
$env:CRAWLER_CI_PAT = '<repository-owner-PAT-with-issues-write>'   # populate securely (e.g. Read-Host -AsSecureString, a vault CLI, or a CI secret)

az functionapp config appsettings set `
  --name <function-app-name> `
  --resource-group crawler-sprites-rg `
  --settings CRAWLER_CI_PAT=$env:CRAWLER_CI_PAT
```

Note this is an **out-of-band** rotation path only — the next Bicep
deployment still requires `githubCiPat` to be passed, and will overwrite
whatever value was set this way.

The app setting `GITHUB_REPOSITORY` defaults to `nalfeo/Crawler` in the Bicep
template. The endpoint is anonymous by design because the public GitHub Pages
client cannot hold a credential; request size and blob-backed IP rate limiting
are enforced by the Function. Rate-limit marker blobs are lifecycle-deleted
after one day. The Function CORS allowlist is
`https://nalfeo.github.io` and `http://localhost:5173` (override with the
`allowedOrigins` Bicep parameter).

### Current deployment status (as of this writing)

- Storage: `playtest-runs` container exists on `crawlersprites`.
- Function App `crawler-dev-ingest` is deployed and **running** the built
  `functions/dev-build-ingest` code. Only **routing and request validation**
  have been verified end-to-end (a manual smoke test with a malformed body
  returned the expected 400). That request is rejected before the Function
  touches Blob Storage, so it does **not** prove the storage connection or
  `playtest-runs` write access works. To verify the persistence path, POST a
  well-formed `RunBundle` and confirm the resulting blob:

  ```powershell
  az storage blob list --account-name crawlersprites --container-name playtest-runs --output table
  ```

- `CRAWLER_CI_PAT` **is set** on the live `crawler-dev-ingest` Function App and
  has been verified end-to-end: a real browser session against the deployed
  GitHub Pages dev build filed
  [nalfeo/Crawler#4034](https://github.com/nalfeo/Crawler/issues/4034) through
  the in-game Report Issue flow. Telemetry ingest (storing run bundles) works
  without this credential; only the **survey/explicit "file an issue"** path
  (which creates a GitHub issue) needs it — see `infra/dev-build-ingest.bicep`'s
  `githubCiPat` parameter, which now makes a fresh or repeated deployment fail
  immediately instead of silently omitting the credential.

  > [!NOTE]
  > `.github/workflows/dev-ingest-lifecycle.yml` now automates the two gaps
  > that used to be open follow-up work here — a `deploy` job publishes this
  > Bicep template + the Function code, and a `canary` job runs a live E2E
  > check of the `file_issue:true` path on a schedule. See
  > **"Automated Function deployment (OIDC)"** and **"Token lifecycle"**
  > below for exactly what is automated, what remains a one-time **human**
  > setup step, and why.

If you only want resource provisioning (no `.env.local` writes or secrets sync), run:

```powershell
pwsh scripts/setup-azure-resources.ps1
```

### Automated Function deployment (OIDC)

`.github/workflows/dev-ingest-lifecycle.yml`'s `deploy` job publishes
`infra/dev-build-ingest.bicep` and the built `functions/dev-build-ingest` code
on every push that touches either path, plus on manual `workflow_dispatch`. It
authenticates to Azure with **OIDC federated login**
(`azure/login@v2` + `id-token: write`) — **there is no Azure client secret
anywhere in this repo or workflow**, and the contract test
`tests/unit/dev-ingest-lifecycle-workflow.test.ts` fails the build if one is
ever added.

**Status: this one-time Azure AD setup is complete and live** — the App
Registration, federated credential, RBAC role assignment, and all three
GitHub Actions secrets described below already exist for
`nalfeo/Crawler`/`crawler-sprites-rg` in the **Visual Studio Enterprise
Subscription** (`308f5463-c4b1-4cfb-94e9-c3e0fd0dc67c`). A push to `main`
touching `infra/dev-build-ingest.bicep` or `functions/dev-build-ingest/**` (or
a manual `workflow_dispatch`) deploys automatically today; the manual
`func azure functionapp publish` / zip-deploy path above is now a fallback,
not the primary path. The steps below are recorded so the setup is
reproducible (e.g. against a new subscription, or if the App Registration is
ever recreated) — they are not a pending TODO.

Creating an App Registration and granting it a subscription-scoped role
assignment are identity/security decisions that require someone with
Owner/User Access Administrator rights on the target subscription — this is
inherently a human/one-time step, not something a CI job can bootstrap for
itself. **If these secrets are ever missing** (e.g. a new environment, a
rotated App Registration), the `deploy` job's `preflight` step **fails the
whole run** with an `::error::` annotation — it does not soft-skip or warn,
because release-triggered deployment automation must not silently omit the
Function publish (see "release automation must fail loud" below). The only
way to intentionally omit the deploy without failing the run is an explicit
`workflow_dispatch` with `skip_deploy: true` (a human-requested canary-only
run), or the periodic `schedule` trigger, which never attempts a deploy.

Setup steps (already applied; re-run only to reproduce or recreate):

```powershell
# 1. Create the App Registration used only for GitHub Actions OIDC login.
$app = az ad app create --display-name "crawler-dev-ingest-deploy-oidc" | ConvertFrom-Json
az ad sp create --id $app.appId

# 2. Federate it to this repo's GitHub Actions OIDC issuer. One credential
#    with this subject covers push-to-main, workflow_dispatch (run against
#    main), and schedule (which also runs against the default branch ref) —
#    add a second federated-credential block only if you need to dispatch
#    the deploy job from a non-main branch.
az ad app federated-credential create --id $app.appId --parameters '{
  "name": "crawler-main-branch",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:nalfeo/Crawler:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

# 3. Grant least-privilege access scoped to ONLY the resource group this
#    Function lives in — never subscription-wide. A single resource-scoped
#    role (e.g. Website Contributor on just the Function App) is NOT
#    sufficient here: `az deployment group create` also needs
#    `Microsoft.Resources/deployments/*` at the *resource group* scope, and
#    the same Bicep template also manages the sibling `Microsoft.Web/
#    serverfarms` plan and a `Microsoft.Storage/storageAccounts/
#    blobServices/containers` sub-resource + `listKeys` on the storage
#    account — both outside a Function-App-scoped assignment's reach.
#    `crawler-sprites-rg` contains exactly the three resources this pipeline
#    manages (the storage account, the plan, and the Function App), so
#    Contributor scoped to that RG (not the subscription) is the
#    "least privilege that is technically required" choice, not
#    subscription-wide Contributor. Tightening further would mean a custom
#    role combining `Microsoft.Resources/deployments/*` +
#    `Microsoft.Web/serverFarms/*` + `Microsoft.Web/sites/*` +
#    `Microsoft.Storage/storageAccounts/*`, scoped to the RG.
az role assignment create `
  --assignee $app.appId `
  --role "Contributor" `
  --scope "/subscriptions/<subscription-id>/resourceGroups/crawler-sprites-rg"

# 4. Store the three identifiers as GitHub Actions secrets. None of these
#    are bearer credentials by themselves — a stolen client ID/tenant
#    ID/subscription ID cannot authenticate without also controlling a
#    workflow run in this exact repo whose OIDC token matches the federated
#    subject above.
gh secret set AZURE_CLIENT_ID --body $app.appId
gh secret set AZURE_TENANT_ID --body (az account show --query tenantId -o tsv)
gh secret set AZURE_SUBSCRIPTION_ID --body (az account show --query id -o tsv)
```

The Pages build (`.github/workflows/deploy.yml`) and this Function release
are independently versioned; if a future change makes them tightly coupled
(e.g. a breaking `/runs` request/response shape change), gate the Pages
deploy on the Function's `deploy` job completing, or pin a version query
param, rather than assuming push order is deployment order.

### Token lifecycle

The live `CRAWLER_CI_PAT` is a **static personal/classic GitHub token**,
manually copied into the Function App setting from an authenticated `gh`
session (see "Current deployment status" above). It does not self-refresh:
if it is revoked, expires, or the account is deactivated, the Function
returns the same `missing required configuration` / GitHub-401 failure it
had before this work, until someone notices and re-sets it by hand.

**Preferred durable design**: replace it with **GitHub App short-lived
installation tokens** (minted per-request, scoped to `issues: write` only,
auto-expiring in ~1 hour, and revocable without touching a personal
account). This requires a human to:

1. Create a GitHub App (Settings → Developer settings → GitHub Apps), grant
   it repository permission `Issues: Read and write` only, and install it on
   `nalfeo/Crawler`.
2. Record the **App ID** and **installation ID**, and generate a private key.
3. Store the private key as a Function App setting (e.g.
   `GITHUB_APP_PRIVATE_KEY`) instead of `CRAWLER_CI_PAT`, and update
   `functions/dev-build-ingest/src/index.ts` to mint an installation access
   token per request (e.g. via `@octokit/auth-app`) rather than using a
   long-lived PAT directly.

This is a real code change to the Function's auth path, not just an infra
setting swap, so it is intentionally **not** done in this pass — doing it
without also testing the new auth path live would just trade one
unverified assumption for another. **Interim mitigation implemented now
instead**: `.github/workflows/dev-ingest-lifecycle.yml`'s `canary` job runs a
real end-to-end check of the `file_issue:true` path
(`.github/scripts/dev-ingest-canary/run-canary.mjs`) every 6 hours, on
`workflow_dispatch`, and after every deploy. It:

- POSTs a synthetic `RunBundle` with `file_issue: true` to the live `/runs`
  endpoint using **no credential of its own** (the endpoint is anonymous by
  design);
- on success, labels and closes the canary-filed GitHub issue immediately
  (so canaries never accumulate as issue noise), and closes any existing
  alert issue if one was open;
- on failure (non-201 response, missing `issueUrl`, or an unparseable issue
  URL — which is exactly what a revoked/expired `CRAWLER_CI_PAT` produces),
  files or updates a single deduplicated alert issue labeled
  `dev-ingest-canary-alert` using **only the workflow's own `GITHUB_TOKEN`**
  — never `CRAWLER_CI_PAT` — so a broken credential cannot also suppress its
  own alert. The alert issue is reused/updated across repeated failures
  rather than creating a new one every 6 hours.

This does not make the token self-refresh, but the six-hour schedule is the intended detection cadence — a failure will open a GitHub issue when the canary job completes successfully and the alert-filing step runs. Note that an API or network failure can make the job exit non-zero without ever reaching the issue-filing step, so issue delivery is not guaranteed on every failure; the canary exists to surface broken credentials promptly under normal operating conditions rather than to provide a hard SLA.

### Idempotency & re-creating resources

`setup-azure-resources.ps1` is **idempotent by default** — every resource is
created only if missing and is otherwise left untouched. In particular the
storage template is **not** redeployed when the account already exists, so a
normal `setup:azure` run never needlessly re-creates resources. Resource groups
and the Azure OpenAI account are containers and are only ever created-if-missing;
they are never deleted automatically.

For dev/test environments you can reset the **stateful** resources (the storage
account and the model deployments) with `-Recreate`:

```powershell
# Reset a NON-persistent dev/test storage account to a clean slate:
pwsh scripts/setup-azure-resources.ps1 -StorageAccountName crawlerspritesdev -Recreate
```

> [!WARNING]
> Deleting the storage account destroys **every stored sprite run and the durable
> workflow-state queue** the DevTools UI reads. To protect the environment you
> interact with day to day, `-Recreate` **refuses** to delete any resource named
> in `-PersistentResourceNames` (default: `crawlersprites`, `aoai-crawler-nalfeo`,
> `aif-crawler-nalfeo`, and their resource groups) unless you also pass
> `-AllowRecreatePersistent`. The persistent version is never blown away without
> you explicitly asking for it:

```powershell
# DESTRUCTIVE — deletes the persistent account's runs + workflow-state. Opt-in required:
pwsh scripts/setup-azure-resources.ps1 -Recreate -AllowRecreatePersistent
```

To re-assert the storage template (container/queue) on an existing account
**without deleting it**, use `-Force` (an idempotent ARM redeploy, no data loss):

```powershell
pwsh scripts/setup-azure-resources.ps1 -Force
```

These flags pass through `setup-azure-env.ps1` as `-Recreate`,
`-AllowRecreatePersistent`, and `-ForceProvision` (the latter renamed so it does
not collide with that script's `-Force`, which controls overwriting `.env.local`):

```powershell
pwsh scripts/setup-azure-env.ps1 -ProvisionResources -IncludeStorage -ForceProvision
```

The pure decision logic behind these flags is covered by a dependency-free test
(no Azure CLI needed):

```powershell
pwsh -NoProfile -File scripts/setup-azure-resources.tests.ps1
```

---

## Azure AI Foundry — **RETIRED (ADR 0072)**

> The Foundry backend was retired in favour of standardising the entire asset
> pipeline on **`azure-openai`** (direct Azure OpenAI resource). See
> `docs/knowledge/adr/0072-retire-foundry-standardize-azure-openai.md` for
> rationale. Passing `foundry` as any `SPRITES_*_PROVIDER` value now throws an
> unknown-backend error at factory time. The `setup:azure:foundry` and
> `setup:azure:foundry:env` npm scripts and the `-IncludeFoundry` PowerShell flag
> have been removed. The `.env.local` template block below is kept for reference
> so existing dotfiles can be cleaned up, but the values are no longer read.

```dotenv
# ── Azure AI Foundry (RETIRED — ADR 0072) ─────────────────────────────────
# These env vars are no longer consumed by the provider factory. Safe to delete.
# FOUNDRY_ENDPOINT=
# FOUNDRY_API_KEY=
# FOUNDRY_API_VERSION=
# FOUNDRY_IMAGE_MODEL=
# FOUNDRY_TEXT_MODEL=
# FOUNDRY_VISION_MODEL=
# FOUNDRY_BRIEF_SELECTOR_MODEL=
# SPRITES_PROVIDER=foundry        ← throws Unknown SPRITES_PROVIDER
# SPRITES_TEXT_PROVIDER=foundry   ← throws Unknown SPRITES_TEXT_PROVIDER
# SPRITES_SYNTH_PROVIDER=foundry  ← throws Unknown SPRITES_SYNTH_PROVIDER
# SPRITES_VISION_PROVIDER=foundry ← throws Unknown SPRITES_VISION_PROVIDER
```

---

## Local emulation with Azurite

[Azurite](https://github.com/Azure/Azurite) emulates Azure Blob and Queue
storage locally. Useful for offline development without real Azure credentials.

```bash
# Install (once)
npm install -g azurite

# Start (blobs on 10000, queues on 10001)
azurite --silent --location /tmp/azurite --debug /tmp/azurite/debug.log

# Use the well-known Azurite connection string
export AZURE_STORAGE_CONNECTION_STRING="UseDevelopmentStorage=true"
export SPRITES_RUN_STORE=azure-blob
export SPRITES_ASSET_QUEUE=azure-queue

# Create the required containers/queues (run once after starting Azurite)
az storage container create --name generated-runs --connection-string "$AZURE_STORAGE_CONNECTION_STRING"
az storage queue create --name asset-requests --connection-string "$AZURE_STORAGE_CONNECTION_STRING"
```

---

## Verifying the setup

```bash
# Check the blob container is accessible
az storage blob list \
  --account-name $STORAGE_NAME \
  --container-name generated-runs \
  --account-key $AZURE_STORAGE_KEY

# Check the queue
az storage queue show \
  --account-name $STORAGE_NAME \
  --name asset-requests \
  --account-key $AZURE_STORAGE_KEY
```

---

## Enqueueing a generation request

```bash
# Noop (default — prints and exits, no Azure needed):
npm run sprites:enqueue -- --brief iron-sword --path briefs/weapons/iron-sword.yaml

# Real queue (set env vars first):
SPRITES_ASSET_QUEUE=azure-queue npm run sprites:enqueue -- \
  --brief iron-sword \
  --path briefs/weapons/iron-sword.yaml \
  --priority high
```

---

## Asset-request issue flow (automated)

Use the **Asset request** GitHub issue template (`asset-request` label). The issue
body carries a machine-readable marker block (`asset-request:v1`) with:

- `name` (kebab-case sprite id)
- `briefSentence` (single sentence)

When the sidecar is running with queue backend `azure-queue`, it runs a local
issue-ingester loop that:

1. Polls open `asset-request` issues
2. Parses the marker payload
3. Enqueues idempotent `issue-request` jobs (keyed by `issueNumber+fingerprint`)

Worker lifecycle for issue jobs:

1. synthesize brief candidates
2. LLM brief selection (dedicated selector deployment)
3. promote selected brief
4. generate
5. postprocess
6. judge

Progress and completion are posted as issue comments, and worker/ingester state
is visible in sidecar health/status endpoints:

- `GET /api/health`
- `GET /api/workflow/worker/status`
- `GET /api/workflow/issues/status`

Failure recovery:

- Fix env/provider/config issue
- restart worker/ingester (`POST /api/workflow/worker/start`, `POST /api/workflow/issues/start`)
- messages are at-least-once; idempotency claims prevent duplicate issue jobs

---

## Future: migrating approved sprites out of the repo

When the approved-sprite assets grow large enough to warrant their own repo or
CDN, add a second blob container (`approved`) to the Bicep template:

```bicep
resource approvedContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'approved'
  properties: { publicAccess: 'None' }
}
```

Then update `scripts/sprites/approve.ts` to write to `AzureBlobRunStore` with
`AZURE_STORAGE_APPROVED_CONTAINER=approved` instead of (or alongside) the
`public/assets/generated/` path. The `ApproveFs` injection interface is
already designed for this swap.

---

## Environment Isolation

When multiple sessions or CI jobs share a single Azure storage account, the
default queue name `asset-requests` becomes a **shared drain point** — a
worker in one session dequeues messages another session enqueued, and the
work disappears from that session's perspective.

- For **E2E / validation runs**, set a per-suite queue name so drains stay
  isolated:

  ```bash
  AZURE_STORAGE_QUEUE_NAME=asset-requests-e2e
  ```

  Any suite that has its own storage backend (e.g. Azurite) does not need
  this, but any suite pointing at the shared cloud account does.

- **Never `path.join(blobUrl, …)` unconditionally.** When the sprite store
  is Azure blob, `store.rootPath` is a URL like
  `https://acct.blob.core.windows.net/generated-runs`, and `path.join` on
  Windows silently strips the scheme and normalizes it into a bogus
  CWD-relative filesystem path (e.g. `C:\repo\https:\acct.blob...`). Guard
  first:

  ```ts
  if (store.backend === 'local') {
    return path.join(store.rootPath, ...rest);
  }
  return store.joinUrl(...rest); // or the backend's own concat
  ```

  The bug surfaces as "file not found" errors that reference a path
  containing `https:` — a good signal that a `path.join` needs a backend
  guard added.

<!-- Source handoff: 2026-06-24-azure-workflow-state-persistence.md -->

## Security notes

- The storage account is provisioned with `allowBlobPublicAccess: false`.
  All reads require an authenticated request (key, SAS token, or managed identity).
- `AZURE_STORAGE_KEY` is a root credential. For production, consider switching
  to a scoped SAS token or Azure Managed Identity.
- `FOUNDRY_API_KEY` is likewise a root credential for the AI Services account;
  the same SAS/Managed-Identity guidance applies (Entra/MI auth is Phase 3 of
  ADR 0033).
- Never commit `.env.local`. It is in `.gitignore`.
