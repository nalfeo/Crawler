// ============================================================================
// infra/azure-storage.bicep
//
// Provisions the Azure Storage Account used by the Crawler sprite pipeline.
//
// Resources created:
//   - Storage Account (Standard_LRS, StorageV2, HTTPS only)
//   - Blob container:  generated-runs   (private, for ephemeral run artifacts)
//   - Queue:           asset-requests   (sprite-generation request queue)
//
// The approved sprites and metadata stay in the git repo for now, so no
// separate "approved" container is provisioned here. See infra/README.md
// when it's time to migrate those assets out.
//
// Deploy with:
//   az deployment group create \
//     --resource-group <rg-name> \
//     --template-file infra/azure-storage.bicep \
//     --parameters storageAccountName=<name>
//
// The storage account name must be globally unique, 3–24 lowercase
// alphanumeric characters (no hyphens). Suggested: crawlersprites<suffix>
// ============================================================================

@description('Globally unique storage account name (3–24 lowercase alphanum).')
param storageAccountName string

@description('Azure region. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Storage SKU. Standard_LRS is sufficient for dev/prod sprite artifacts.')
@allowed(['Standard_LRS', 'Standard_GRS', 'Standard_ZRS'])
param sku string = 'Standard_LRS'

// ── Storage Account ─────────────────────────────────────────────────────────

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: sku
  }
  properties: {
    accessTier: 'Hot'
    // Enforce HTTPS for all data-plane calls.
    supportsHttpsTrafficOnly: true
    // Disable anonymous public access to all blobs — run artifacts contain
    // potentially unpublished game art; require authenticated access.
    allowBlobPublicAccess: false
    // Disable shared-key access entirely in favour of SAS tokens or managed
    // identity, unless overridden. For simplicity during dev bootstrapping
    // we leave shared-key enabled; tighten this for production.
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
  }
}

// ── Blob Service ─────────────────────────────────────────────────────────────

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      // Retain deleted blobs for 7 days so an accidental deletion of a
      // run artifact is recoverable without re-generating sprites.
      enabled: true
      days: 7
    }
  }
}

// ── Blob Containers ──────────────────────────────────────────────────────────

resource generatedRunsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'generated-runs'
  properties: {
    publicAccess: 'None'
    metadata: {
      purpose: 'Ephemeral sprite-generation run artifacts (sheets, processed variants, scorecards).'
    }
  }
}

resource playtestRunsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'playtest-runs'
  properties: {
    publicAccess: 'None'
    metadata: {
      purpose: 'Dev-build run bundles, feedback surveys, and optional screenshots.'
    }
  }
}

resource storageLifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2022-09-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-rate-limit-markers'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'playtest-runs/rate-limit/'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 1
                }
              }
            }
          }
        }
      ]
    }
  }
}

// ── Queue Service ─────────────────────────────────────────────────────────────

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource assetRequestQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-01-01' = {
  parent: queueService
  name: 'asset-requests'
  properties: {
    metadata: {
      purpose: 'Sprite-generation request queue consumed by the generation worker.'
    }
  }
}

// ── Outputs ──────────────────────────────────────────────────────────────────

@description('Storage account resource ID.')
output storageAccountId string = storageAccount.id

@description('Primary blob endpoint URL.')
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob

@description('Primary queue endpoint URL.')
output queueEndpoint string = storageAccount.properties.primaryEndpoints.queue

@description('Generated-runs blob container name.')
output generatedRunsContainerName string = generatedRunsContainer.name

@description('Dev-build ingest blob container name.')
output playtestRunsContainerName string = playtestRunsContainer.name

@description('Asset-requests queue name.')
output assetRequestQueueName string = assetRequestQueue.name
