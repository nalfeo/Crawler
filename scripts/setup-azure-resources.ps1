<#
.SYNOPSIS
    Provision Azure resources required for sprite image-generation E2E.

.DESCRIPTION
    Ensures the required resource groups, storage resources, Azure OpenAI
    account, and model deployments exist. Safe to re-run.
#>

param(
    [string]$ExpectedUser = 'nalfeo@hotmail.com',
    [string]$TenantDomain = 'nalfeohotmail.onmicrosoft.com',
    [string]$TenantId = '81f46c6b-e3ce-4db7-bc18-a3375faeb507',
    [string]$Subscription = '308f5463-c4b1-4cfb-94e9-c3e0fd0dc67c',
    [string]$OpenAIResourceGroup = 'rg-crawler-sprites',
    [string]$OpenAILocation = 'eastus',
    [string]$OpenAIAccountName = 'aoai-crawler-nalfeo',
    [string]$OpenAIChatDeployment = 'gpt-4o',
    [string]$OpenAIChatModelName = 'gpt-4o',
    [string]$OpenAIChatModelVersion = '2024-11-20',
    [string]$OpenAIVisionDeployment = 'gpt-4o',
    [string]$OpenAIVisionModelName = 'gpt-4o',
    [string]$OpenAIVisionModelVersion = '2024-11-20',
    [string]$OpenAIImageDeployment = 'gpt-image-1',
    [string]$OpenAIImageModelName = 'gpt-image-1',
    [string]$OpenAIImageModelVersion = 'latest',
    [string]$StorageResourceGroup = 'crawler-sprites-rg',
    [string]$StorageLocation = 'eastus',
    [string]$StorageAccountName = 'crawlersprites'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Ensure-ResourceGroup([string]$Name, [string]$Location) {
    $exists = az group exists --name $Name
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to query resource group '$Name'."
    }
    if ($exists -eq 'true') {
        Write-Host "Resource group exists: $Name" -ForegroundColor DarkGray
        return
    }
    Write-Host "Creating resource group: $Name ($Location)" -ForegroundColor Cyan
    az group create --name $Name --location $Location 1>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create resource group '$Name'."
    }
}

function Ensure-OpenAIAccount([string]$ResourceGroup, [string]$Name, [string]$Location) {
    az cognitiveservices account show --name $Name --resource-group $ResourceGroup 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Azure OpenAI account exists: $Name" -ForegroundColor DarkGray
        return
    }

    Write-Host "Creating Azure OpenAI account: $Name ($Location)" -ForegroundColor Cyan
    az cognitiveservices account create `
        --name $Name `
        --resource-group $ResourceGroup `
        --location $Location `
        --kind OpenAI `
        --sku S0 `
        --yes 1>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create Azure OpenAI account '$Name'."
    }
}

function Ensure-OpenAIDeployment(
    [string]$ResourceGroup,
    [string]$AccountName,
    [string]$DeploymentName,
    [string]$ModelName,
    [string]$ModelVersion
) {
    az cognitiveservices account deployment show `
        --resource-group $ResourceGroup `
        --name $AccountName `
        --deployment-name $DeploymentName 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "OpenAI deployment exists: $DeploymentName" -ForegroundColor DarkGray
        return
    }

    Write-Host "Creating OpenAI deployment: $DeploymentName ($ModelName@$ModelVersion)" -ForegroundColor Cyan
    az cognitiveservices account deployment create `
        --resource-group $ResourceGroup `
        --name $AccountName `
        --deployment-name $DeploymentName `
        --model-format OpenAI `
        --model-name $ModelName `
        --model-version $ModelVersion `
        --sku-name Standard `
        --sku-capacity 1 1>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create OpenAI deployment '$DeploymentName'."
    }
}

Require-Command 'az'

Write-Host "Checking Azure CLI login..." -ForegroundColor Cyan
$accountRaw = az account show --output json 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Not logged in to Azure." -ForegroundColor Red
    Write-Host "Run: az login --tenant $TenantDomain --use-device-code" -ForegroundColor Yellow
    exit 1
}
$account = $accountRaw | ConvertFrom-Json
if ($account.id -ne $Subscription) {
    Write-Host "Switching Azure subscription to $Subscription..." -ForegroundColor Cyan
    az account set --subscription $Subscription 2>$null
}

$activeRaw = az account show --output json 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "Failed to read active Azure account context."
}
$active = $activeRaw | ConvertFrom-Json
if ($active.id -ne $Subscription -or $active.tenantId -ne $TenantId -or $active.user.name -ne $ExpectedUser) {
    Write-Host "Azure context mismatch." -ForegroundColor Red
    Write-Host "Expected user        : $ExpectedUser" -ForegroundColor Yellow
    Write-Host "Expected tenant      : $TenantId ($TenantDomain)" -ForegroundColor Yellow
    Write-Host "Expected subscription: $Subscription" -ForegroundColor Yellow
    Write-Host "Active user          : $($active.user.name)" -ForegroundColor Yellow
    Write-Host "Active tenant        : $($active.tenantId)" -ForegroundColor Yellow
    Write-Host "Active subscription  : $($active.id)" -ForegroundColor Yellow
    Write-Host "Run: az login --tenant $TenantDomain --use-device-code" -ForegroundColor Yellow
    exit 1
}

Ensure-ResourceGroup -Name $StorageResourceGroup -Location $StorageLocation
Ensure-ResourceGroup -Name $OpenAIResourceGroup -Location $OpenAILocation

$repoRoot = Split-Path $PSScriptRoot
$storageBicep = Join-Path $repoRoot 'infra\azure-storage.bicep'
if (-not (Test-Path $storageBicep)) {
    throw "Missing template: $storageBicep"
}

Write-Host "Deploying storage template..." -ForegroundColor Cyan
az deployment group create `
    --resource-group $StorageResourceGroup `
    --template-file $storageBicep `
    --parameters storageAccountName=$StorageAccountName 1>$null
if ($LASTEXITCODE -ne 0) {
    throw "Failed to deploy storage template."
}

Ensure-OpenAIAccount -ResourceGroup $OpenAIResourceGroup -Name $OpenAIAccountName -Location $OpenAILocation
Ensure-OpenAIDeployment -ResourceGroup $OpenAIResourceGroup -AccountName $OpenAIAccountName -DeploymentName $OpenAIChatDeployment -ModelName $OpenAIChatModelName -ModelVersion $OpenAIChatModelVersion
Ensure-OpenAIDeployment -ResourceGroup $OpenAIResourceGroup -AccountName $OpenAIAccountName -DeploymentName $OpenAIVisionDeployment -ModelName $OpenAIVisionModelName -ModelVersion $OpenAIVisionModelVersion
Ensure-OpenAIDeployment -ResourceGroup $OpenAIResourceGroup -AccountName $OpenAIAccountName -DeploymentName $OpenAIImageDeployment -ModelName $OpenAIImageModelName -ModelVersion $OpenAIImageModelVersion

Write-Host "Azure resource provisioning complete." -ForegroundColor Green
