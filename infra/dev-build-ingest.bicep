@description('Globally unique Azure Function App name.')
param functionAppName string

@description('Existing storage account containing the playtest-runs container.')
param storageAccountName string

@description('Azure region.')
param location string = resourceGroup().location

@description('GitHub repository in owner/name form.')
param githubRepository string = 'nalfeo/Crawler'

@description('Allowed browser origins.')
param allowedOrigins array = [
  'https://nalfeo.github.io'
  'http://localhost:5173'
]

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

// Flex Consumption (FC1) is used instead of the classic Dynamic (Y1) plan
// because Y1 provisions against the subscription's regional VM-core quota,
// which is 0 on some subscription types (e.g. Visual Studio Enterprise) and
// cannot be self-service increased. FC1 draws from a separate Microsoft.Web
// quota pool that is available on those subscriptions.
resource plan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: '${functionAppName}-plan'
  location: location
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  kind: 'functionapp'
  properties: {
    reserved: true
  }
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  name: '${storageAccountName}/default/${functionAppName}-deploy'
}

resource functionApp 'Microsoft.Web/sites@2023-01-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      cors: {
        allowedOrigins: allowedOrigins
      }
      appSettings: [
        {
          name: 'AZURE_STORAGE_CONNECTION_STRING'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${listKeys(storageAccount.id, '2023-01-01').keys[0].value};EndpointSuffix=core.windows.net'
        }
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${listKeys(storageAccount.id, '2023-01-01').keys[0].value};EndpointSuffix=core.windows.net'
        }
        {
          name: 'FUNCTIONS_REQUEST_BODY_SIZE_LIMIT'
          value: '8388608'
        }
        {
          name: 'RUNS_CONTAINER'
          value: 'playtest-runs'
        }
        {
          name: 'ALLOWED_ORIGINS'
          value: join(allowedOrigins, ',')
        }
        {
          name: 'GITHUB_REPOSITORY'
          value: githubRepository
        }
      ]
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storageAccount.properties.primaryEndpoints.blob}${functionAppName}-deploy'
          authentication: {
            type: 'StorageAccountConnectionString'
            storageAccountConnectionStringName: 'AzureWebJobsStorage'
          }
        }
      }
      runtime: {
        name: 'node'
        version: '22'
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 40
        instanceMemoryMB: 2048
      }
    }
  }
  dependsOn: [
    deploymentContainer
  ]
}

output functionAppName string = functionApp.name
output defaultHostName string = functionApp.properties.defaultHostName
