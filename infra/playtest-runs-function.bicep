// ============================================================================
// infra/playtest-runs-function.bicep
//
// Provisions the Azure Function and storage resources for playtest-runs ingest:
// - Azure Function App (Node.js 20.x, consumption plan)
// - Blob container `playtest-runs` (private, for run artifacts)
// - Storage table `playtest-runs-rate-limits` (TTL-based rate-limit tracking)
//
// Deploy with:
//   az deployment group create \
//     --resource-group <rg-name> \
//     --template-file infra/playtest-runs-function.bicep \
//     --parameters \
//       storageAccountName=<name> \
//       functionAppName=<name>
//
// ============================================================================

@description('Existing storage account name (e.g., crawlersprites).')
param storageAccountName string

@description('Globally unique Function App name (3–24 alphanumeric chars, lowercase).')
param functionAppName string

@description('Azure region. Defaults to the resource group location.')
param location string = resourceGroup().location

// ── Existing Storage Account (reference only) ────────────────────────────

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

// ── Blob Service & Containers ───────────────────────────────────────────

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' existing = {
  parent: storageAccount
  name: 'default'
}

// Blob container for playtest run artifacts (stats, JSONL, logs, PNG)
resource playtestRunsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'playtest-runs'
  properties: {
    publicAccess: 'None'  // Private — no anonymous read
  }
}

// ── Table Service & Tables ──────────────────────────────────────────────

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-01-01' existing = {
  parent: storageAccount
  name: 'default'
}

// Storage table for rate-limit tracking (per IP, TTL-based)
resource rateLimitTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name: 'playtestRunsRateLimits'
}

// ── Function App Hosting ────────────────────────────────────────────────

// App Service Plan (consumption-based pricing)
resource appServicePlan 'Microsoft.Web/serverfarms@2022-03-01' = {
  name: '${functionAppName}-plan'
  location: location
  kind: 'functionapp'
  sku: {
    name: 'Y1'           // Consumption tier
    tier: 'Dynamic'
  }
  properties: {
    reserved: false      // Windows (not Linux)
  }
}

// Function App resource
resource functionApp 'Microsoft.Web/sites@2022-03-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp'
  identity: {
    type: 'SystemAssigned'  // Managed Identity for secure auth
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true  // Enforce HTTPS
    siteConfig: {
      appSettings: [
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '20.x'
        }
        // Runtime settings (secure; set via az CLI, not in code)
        {
          name: 'CRAWLER_CI_PAT'
          value: ''  // Injected at deployment time
        }
        {
          name: 'AZURE_STORAGE_ACCOUNT'
          value: storageAccountName
        }
        {
          name: 'AZURE_STORAGE_CONNECTION_STRING'
          value: ''  // Injected at deployment time
        }
      ]
      cors: {
        allowedOrigins: [
          'https://nalfeo.github.io'  // Dev Pages URL
          'http://localhost:*'         // Local dev
          'http://127.0.0.1:*'         // Local dev (alternative)
        ]
      }
      nodeVersion: '20.x'
    }
  }
}

// ── Outputs ─────────────────────────────────────────────────────────────

@description('Function App default hostname.')
output functionHostname string = functionApp.properties.defaultHostName

@description('Function POST /runs endpoint URL.')
output playtestRunsEndpoint string = 'https://${functionApp.properties.defaultHostName}/api/runs'

@description('Storage account primary connection string (for app settings).')
output storageConnectionString string = 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=core.windows.net'

@description('Playtest runs blob container name.')
output playtestRunsContainer string = playtestRunsContainer.name

@description('Rate-limit tracking table name.')
output rateLimitTableName string = rateLimitTable.name
