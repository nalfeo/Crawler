# Azure Storage — Setup & Operations

This document covers one-time Azure provisioning and the environment variables
that unlock the Azure backends for the sprite pipeline.

## What is provisioned

| Resource                        | Purpose                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Storage Account                 | Parent resource for blobs and queues                                                                                                             |
| Blob container `generated-runs` | Ephemeral sprite-generation artifacts (sheets, processed variants, scorecards, summaries) — replaces the gitignored local `generated/runs/` tree |
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
# AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT=300
```

Alternatively, use a **connection string** (simplifies local Azurite use):

```dotenv
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net
SPRITES_RUN_STORE=azure-blob
SPRITES_ASSET_QUEUE=azure-queue
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

If you only want resource provisioning (no `.env.local` writes), run:

```powershell
pwsh scripts/setup-azure-resources.ps1
```

This sets these repo secrets (for `nalfeo/Crawler` by default):

- `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_CHAT_DEPLOYMENT`, `AZURE_OPENAI_VISION_DEPLOYMENT`
- `AZURE_OPENAI_IMAGE_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`
- `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_KEY`, `AZURE_STORAGE_CONNECTION_STRING`
- `AZURE_STORAGE_QUEUE_NAME`, `AZURE_STORAGE_RUNS_CONTAINER`
- `SPRITES_ASSET_QUEUE`, `SPRITES_RUN_STORE`

Use `-GitHubRepo owner/repo` to target a different repository.

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

## Security notes

- The storage account is provisioned with `allowBlobPublicAccess: false`.
  All reads require an authenticated request (key, SAS token, or managed identity).
- `AZURE_STORAGE_KEY` is a root credential. For production, consider switching
  to a scoped SAS token or Azure Managed Identity.
- Never commit `.env.local`. It is in `.gitignore`.
