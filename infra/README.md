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

# Opt-in: use Azure backends instead of local filesystem / noop
SPRITES_RUN_STORE=azure-blob                  # 'local' (default) | 'azure-blob'
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

Provision the Function App using the existing storage account:

```powershell
az deployment group create `
  --resource-group crawler-sprites-rg `
  --template-file infra/dev-build-ingest.bicep `
  --parameters functionAppName=<globally-unique-name> storageAccountName=crawlersprites
```

> [!IMPORTANT]
> The template uses a **Flex Consumption (FC1)** plan, not the classic Dynamic
> (Y1) plan. Y1 provisions against the subscription's regional VM-core quota
> (`Microsoft.Compute`), and that quota is **0** on some subscription types
> (e.g. Visual Studio Enterprise) with no self-service increase path. FC1 draws
> from a separate `Microsoft.Web` quota pool and deploys successfully on those
> subscriptions. If your subscription has normal VM quota you can still use
> FC1 — it works everywhere Y1 does. Live deployment: `crawler-dev-ingest` in
> `crawler-sprites-rg` (eastus), state `Running`.

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

Set the GitHub credential after deployment; never commit it or put it in the
browser bundle:

```powershell
az functionapp config appsettings set `
  --name <function-app-name> `
  --resource-group crawler-sprites-rg `
  --settings CRAWLER_CI_PAT=<repository-owner-PAT-with-issues-write>
```

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
  `functions/dev-build-ingest` code; `POST /runs` is live and validates
  requests (confirmed via a manual smoke test returning a 400 with a clear
  validation error for a malformed body, and would return 2xx for a well-formed
  `RunBundle`).
- `CRAWLER_CI_PAT` is **not yet set** on the Function App. Telemetry ingest
  (storing run bundles) works without it; only the **survey/explicit
  "file an issue"** path (which creates a GitHub issue) needs it. Set it with
  the command above using a PAT scoped to `repo` (issue creation) on
  `nalfeo/Crawler` before relying on in-game issue filing.

If you only want resource provisioning (no `.env.local` writes or secrets sync), run:

```powershell
pwsh scripts/setup-azure-resources.ps1
```

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
