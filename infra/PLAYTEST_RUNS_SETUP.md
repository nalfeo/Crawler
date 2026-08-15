# Dev-Build Playtest Runs — Azure Function Setup & Deployment

This document covers deployment of the playtest-runs ingest proxy — an Azure Function that captures dev-build run bundles (stats, logs, telemetry, screenshots) and files GitHub issues from survey responses.

The function handles three concerns:

1. **Blob persistence** — stores run bundles (RunStats + session JSONL + logs + PNG screenshot) to a `playtest-runs` container
2. **Rate limiting** — enforces per-IP request limits (configurable) using blob-backed buckets
3. **GitHub integration** — files issues only when a survey is submitted or an explicit issue request is made (gated to avoid tracker spam)

---

## What is provisioned

| Resource                                  | Purpose                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Azure Function App                        | HTTP-triggered serverless endpoint; POST /runs ingests run bundles |
| Blob container `playtest-runs`            | Persistent run artifacts (JSON + JSONL + logs + PNG)               |
| Storage table `playtest-runs-rate-limits` | Rate-limit tracking per IP (auto-cleaned by retention policy)      |

---

## Prerequisites

- [Azure CLI](https://docs.microsoft.com/cli/azure/install-azure-cli) installed and logged in (`az login`)
- An Azure subscription
- An existing resource group (same one as the sprite pipeline, or create a new one)
- An existing storage account (reuses `AZURE_STORAGE_ACCOUNT` from the sprite setup)
- GitHub PAT with `repo` scope (use the existing `CRAWLER_CI_PAT` if it already has the necessary permissions)

---

## One-time deployment

### 1. Provision the Function App infrastructure

Deploy the Bicep template to create the Function App and storage containers:

```bash
export RG=crawler-sprites-rg
export STORAGE_NAME=crawlersprites
export FUNCTION_NAME=crawler-playtest-runs

# Create the Function App resource group (or reuse existing)
# az group create --name $RG --location eastus

# Deploy the Bicep template (creates Function App + playtest-runs container/table)
az deployment group create \
  --resource-group $RG \
  --template-file infra/playtest-runs-function.bicep \
  --parameters \
    storageAccountName=$STORAGE_NAME \
    functionAppName=$FUNCTION_NAME
```

The deployment takes ~1–2 minutes and creates:

- Azure Function App (consumption plan, Node.js 20.x runtime)
- Blob container `playtest-runs`
- Storage table `playtest-runs-rate-limits`

### 2. Retrieve the Function URL

```bash
az functionapp show \
  --resource-group $RG \
  --name $FUNCTION_NAME \
  --query "defaultHostName" \
  --output tsv
```

This returns `<function-name>.azurewebsites.net`. The endpoint is `https://<function-name>.azurewebsites.net/api/runs`.

Copy this URL — it's the `VITE_CRAWLER_RUNS_API_ENDPOINT` used by the client.

### 3. Configure Function App secrets

The Function needs:

- `CRAWLER_CI_PAT` — GitHub token for filing issues
- `AZURE_STORAGE_ACCOUNT` — storage account name
- `AZURE_STORAGE_CONNECTION_STRING` — connection string for blob + table access

Add these as Function App settings:

```bash
# Retrieve storage connection string (or use the one from .env.local)
CONN_STRING=$(az storage account show-connection-string \
  --name $STORAGE_NAME \
  --resource-group $RG \
  --query "connectionString" \
  --output tsv)

# Set Function App config
az functionapp config appsettings set \
  --resource-group $RG \
  --name $FUNCTION_NAME \
  --settings \
    CRAWLER_CI_PAT="$CRAWLER_CI_PAT" \
    AZURE_STORAGE_ACCOUNT="$STORAGE_NAME" \
    AZURE_STORAGE_CONNECTION_STRING="$CONN_STRING"
```

**Important:** If using GitHub Secrets, the PAT should be added there separately (see "CI/CD integration" below).

### 4. Deploy the Function code

The Function code lives in `src/functions/playtest-runs/` (or wherever it ends up per PR2). Build and deploy:

```bash
# Build the Function
npm run build:functions

# Deploy to Azure
func azure functionapp publish $FUNCTION_NAME --build remote
```

Or, if using GitHub Actions (preferred for CI/CD):

Add a workflow that builds and deploys on main commits. The workflow should:

1. Build the TypeScript function
2. Package and deploy using `func azure functionapp publish`
3. Use the stored `AZURE_FUNCTION_DEPLOYMENT_KEY` secret for authentication

### 5. Verify the deployment

```bash
# Check the Function is responding
curl https://<function-name>.azurewebsites.net/api/runs \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"test": true}'

# Should return 400 (validation error, not a 404)
# 404 = Function didn't deploy; 401 = auth failure; 400 = working
```

Check Function logs:

```bash
az webapp log stream \
  --resource-group $RG \
  --name $FUNCTION_NAME \
  --provider microsoft.web/sites/config/web \
  --instance-identifier ftp
```

Or in the Azure Portal: Function App → Log stream.

---

## Client-side configuration

### Dev build (.env.local)

```dotenv
# Playtest runs ingest endpoint
VITE_CRAWLER_RUNS_API_ENDPOINT=https://<function-name>.azurewebsites.net/api/runs
```

### GitHub Pages deployment (CI)

The dev build is deployed by `.github/workflows/deploy.yml`. Update it to inject the Function endpoint at build time:

```yaml
- name: Build dev
  env:
    DEPLOY_ENV: dev
    VITE_CRAWLER_RUNS_API_ENDPOINT: ${{ secrets.VITE_CRAWLER_RUNS_API_ENDPOINT }}
  run: npm run build
```

Add the secret `VITE_CRAWLER_RUNS_API_ENDPOINT` to the GitHub repo settings, pointing to the deployed Function URL.

---

## Rate limiting & cleanup

The Function enforces per-IP rate limits using storage table entries. Each entry has a TTL; entries older than 24 hours are candidates for cleanup.

Configure in Function code:

```typescript
const RATE_LIMIT_PER_IP = 100; // requests per 24h
const RATE_LIMIT_WINDOW_MS = 86_400_000; // 24h in ms
```

The Azure Storage lifecycle policy automatically deletes entries after 30 days (configurable in Bicep).

---

## GitHub integration & secrets

### Who files issues?

- **Silently uploaded runs** → no issue (just blob storage)
- **Survey submitted** → creates issue with labels `playtest-feedback`
- **Explicit issue request** (in-game F8 dialog) → creates issue with labels `user-reported`

### PAT requirements

The `CRAWLER_CI_PAT` needs:

- `repo` scope (full control of repos)
- `public_repo` scope (if the repo is public)

If the PAT is in the Function App config, the Function can read it at runtime. If using GitHub Secrets for CI/CD, it's available to the deployment workflow.

Check the PAT:

```bash
curl -H "Authorization: token $CRAWLER_CI_PAT" \
  https://api.github.com/user
```

Should return your user info.

---

## Signed blob URLs

When the Function creates an issue, it includes a link to the stored run bundle in the Azure blob. This link is a **signed URL** (SAS token) that's valid for 7 days and allows anonymous read-only access.

The SAS is generated server-side by the Function using `AZURE_STORAGE_CONNECTION_STRING` — no credential is needed in the URL itself. After 7 days, the link expires, but the blob is not deleted (blobs stay permanently unless a lifecycle policy or manual deletion removes them).

To extend the SAS validity or delete old blobs, configure a blob lifecycle policy in the Bicep template (e.g., delete after 90 days of inactivity).

---

## Troubleshooting

### Function returns 401

- `CRAWLER_CI_PAT` is missing, empty, or invalid
- Check Function App settings (Azure Portal or `az functionapp config appsettings list`)
- Verify the PAT has `repo` scope

### Function returns 403 (CORS)

- The Function CORS policy doesn't include the calling origin (https://nalfeo.github.io)
- Update in Bicep or Function settings:
  ```bash
  az functionapp cors add \
    --resource-group $RG \
    --name $FUNCTION_NAME \
    --allowed-origins https://nalfeo.github.io http://localhost:*
  ```

### Blobs not appearing in `playtest-runs` container

- Check Function logs (see "Verify" above)
- Verify `AZURE_STORAGE_CONNECTION_STRING` is correct
- Confirm the blob container exists: `az storage container exists --name playtest-runs`

### GitHub issue not created (but blob was stored)

- Survey payload didn't include survey dimensions or explicit `file_issue` flag
- `CRAWLER_CI_PAT` is invalid or missing the `repo` scope
- Check Function logs for the exact error
- Verify repo slug in issue payload matches `nalfeo/Crawler`

---

## Monitoring & observability

Function invocations, errors, and latency are logged to Application Insights (if configured in Bicep). View live logs:

```bash
az webapp log stream \
  --resource-group $RG \
  --name $FUNCTION_NAME
```

Or in the Azure Portal: Function App → Monitor → Logs.

Blob storage metrics are visible in the storage account's Metrics page (Azure Portal).

---

## Future: Scaling to production

For a public release build, consider:

- **Dedicated storage account** (separate from sprite pipeline; keep PII/playtest runs separate)
- **Managed Identity** instead of hardcoded PAT (Azure Entra auth is more secure)
- **Longer blob retention** (e.g., 90 days instead of auto-delete)
- **Custom domain** for the Function URL (CNAME + SSL cert)
- **Alerting** on error rates, slow invocations, or quota exhaustion
- **Cost monitoring** via Azure Cost Management

---

## Quick recap

```bash
# 1. Deploy infrastructure
az deployment group create \
  --resource-group $RG \
  --template-file infra/playtest-runs-function.bicep \
  --parameters storageAccountName=$STORAGE_NAME functionAppName=$FUNCTION_NAME

# 2. Configure secrets
az functionapp config appsettings set \
  --resource-group $RG \
  --name $FUNCTION_NAME \
  --settings CRAWLER_CI_PAT="..." AZURE_STORAGE_CONNECTION_STRING="..."

# 3. Deploy code
npm run build:functions
func azure functionapp publish $FUNCTION_NAME --build remote

# 4. Test
curl https://<function-name>.azurewebsites.net/api/runs \
  -X POST -H "Content-Type: application/json" -d '{}'

# 5. Configure client
# Add VITE_CRAWLER_RUNS_API_ENDPOINT=https://<function-name>.azurewebsites.net/api/runs to .env.local

# 6. Deploy dev build with the endpoint
# CI will inject the secret into the build
```
