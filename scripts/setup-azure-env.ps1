<#
.SYNOPSIS
    Bootstrap local Azure env vars and optionally sync them to GitHub secrets.

.DESCRIPTION
    Fetches Azure OpenAI credentials (required for image generation tools),
    optionally fetches Azure Storage credentials (required for queue/run-store
    backends), writes .env.local, and can push the same values to GitHub
    Actions secrets with `gh secret set`.

    Variable names are documented in scripts/azure-env.example.

.EXAMPLE
    # Local OpenAI only
    pwsh scripts/setup-azure-env.ps1

.EXAMPLE
    # Local OpenAI + Storage for worker/queue modes
    pwsh scripts/setup-azure-env.ps1 -IncludeStorage

.EXAMPLE
    # Provision missing Azure resources, then configure local env
    pwsh scripts/setup-azure-env.ps1 -ProvisionResources -IncludeStorage

.EXAMPLE
    # Local setup + sync required values to GitHub secrets
    pwsh scripts/setup-azure-env.ps1 -ProvisionResources -IncludeStorage -SyncGitHubSecrets
#>

param(
    [switch]$Force,
    [switch]$IncludeStorage,
    [switch]$ProvisionResources,
    [switch]$SyncGitHubSecrets,
    # Forwarded to setup-azure-resources.ps1 (only used with -ProvisionResources):
    #   -Recreate                 delete + re-create stateful resources (dev/test reset)
    #   -AllowRecreatePersistent  permit -Recreate to destroy a persistent resource
    #   -ForceProvision           redeploy the storage template without deleting it
    # Named -ForceProvision here so it does not collide with -Force (which controls
    # overwriting an existing .env.local below).
    [switch]$Recreate,
    [switch]$AllowRecreatePersistent,
    [switch]$ForceProvision,
    [string]$GitHubRepo = 'nalfeo/Crawler',
    [string]$ExpectedUser = 'nalfeo@hotmail.com',
    [string]$TenantDomain = 'nalfeohotmail.onmicrosoft.com',
    [string]$TenantId = '81f46c6b-e3ce-4db7-bc18-a3375faeb507',
    [string]$Subscription = '308f5463-c4b1-4cfb-94e9-c3e0fd0dc67c',
    [string]$OpenAIResourceGroup = 'rg-crawler-sprites',
    [string]$OpenAIAccountName = 'aoai-crawler-nalfeo',
    [string]$OpenAIChatDeployment = 'gpt-4o',
    [string]$OpenAIVisionDeployment = 'gpt-4o',
    [string]$OpenAIImageDeployment = 'gpt-image-1',
    [string]$OpenAIBriefSelectorDeployment = 'gpt-4o',
    [string]$OpenAIApiVersion = '2025-04-01-preview',
    [string]$StorageResourceGroup = 'crawler-sprites-rg',
    [string]$StorageAccountName = 'crawlersprites',
    [string]$StorageQueueName = 'asset-requests',
    [string]$StorageRunsContainer = 'generated-runs',
    [string]$StoragePlaytestRunsContainer = 'playtest-runs'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Set-GitHubSecretValue([string]$Repo, [string]$Name, [string]$Value) {
    $Value | gh secret set $Name --repo $Repo 1>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to set GitHub secret '$Name' in '$Repo'."
    }
    Write-Host "  - $Name" -ForegroundColor DarkGray
}

$isCloud = [bool]($env:CI -or $env:GITHUB_ACTIONS -or $env:CODESPACES)
if ($isCloud -and -not $SyncGitHubSecrets) {
    Write-Host "Cloud/CI environment detected - skipping local .env.local setup." -ForegroundColor Cyan
    exit 0
}

Require-Command 'az'

if ($ProvisionResources) {
    $provisionScript = Join-Path $PSScriptRoot 'setup-azure-resources.ps1'
    if (-not (Test-Path $provisionScript)) {
        throw "Missing provisioning script: $provisionScript"
    }
    Write-Host "Provisioning Azure resources needed for sprite e2e..." -ForegroundColor Cyan
    & $provisionScript `
        -ExpectedUser $ExpectedUser `
        -TenantDomain $TenantDomain `
        -TenantId $TenantId `
        -Subscription $Subscription `
        -OpenAIResourceGroup $OpenAIResourceGroup `
        -OpenAIAccountName $OpenAIAccountName `
        -OpenAIChatDeployment $OpenAIChatDeployment `
        -OpenAIVisionDeployment $OpenAIVisionDeployment `
        -OpenAIImageDeployment $OpenAIImageDeployment `
        -StorageResourceGroup $StorageResourceGroup `
        -StorageAccountName $StorageAccountName `
        -Recreate:$Recreate `
        -AllowRecreatePersistent:$AllowRecreatePersistent `
        -Force:$ForceProvision
    if ($LASTEXITCODE -ne 0) {
        throw "Azure resource provisioning failed."
    }
}

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

Write-Host "Fetching Azure OpenAI endpoint and key..." -ForegroundColor Cyan
$openAIEndpoint = az cognitiveservices account show `
    --name $OpenAIAccountName `
    --resource-group $OpenAIResourceGroup `
    --subscription $Subscription `
    --query properties.endpoint -o tsv
if ($LASTEXITCODE -ne 0 -or -not $openAIEndpoint) {
    throw "Failed to retrieve Azure OpenAI endpoint."
}

$openAIKey = az cognitiveservices account keys list `
    --name $OpenAIAccountName `
    --resource-group $OpenAIResourceGroup `
    --subscription $Subscription `
    --query key1 -o tsv
if ($LASTEXITCODE -ne 0 -or -not $openAIKey) {
    throw "Failed to retrieve Azure OpenAI API key."
}

$storageKey = $null
if ($IncludeStorage -or $SyncGitHubSecrets) {
    Write-Host "Fetching Azure Storage key..." -ForegroundColor Cyan
    $storageKey = az storage account keys list `
        --account-name $StorageAccountName `
        --resource-group $StorageResourceGroup `
        --subscription $Subscription `
        --query "[0].value" -o tsv
    if ($LASTEXITCODE -ne 0 -or -not $storageKey) {
        throw "Failed to retrieve Azure Storage account key."
    }
}

if (-not $isCloud) {
    $repoRoot = Split-Path $PSScriptRoot
    $outPath = Join-Path $repoRoot '.env.local'
    if ((Test-Path $outPath) -and -not $Force) {
        Write-Host ".env.local already exists. Pass -Force to overwrite." -ForegroundColor Yellow
    } else {
        $storageBlock = ''
        if ($IncludeStorage -and $storageKey) {
            $storageBlock = @"

# Azure Storage (queue + run-store)
AZURE_STORAGE_ACCOUNT=$StorageAccountName
AZURE_STORAGE_KEY=$storageKey
AZURE_STORAGE_QUEUE_NAME=$StorageQueueName
AZURE_STORAGE_RUNS_CONTAINER=$StorageRunsContainer
AZURE_STORAGE_PLAYTEST_RUNS_CONTAINER=$StoragePlaytestRunsContainer
SPRITES_ASSET_QUEUE=azure-queue
SPRITES_RUN_STORE=azure-blob
"@
        }

        @"
# Local-only Azure credentials - DO NOT COMMIT
# Generated by scripts/setup-azure-env.ps1
# Re-run this script on any new machine (requires az login)
# Expected Azure context:
#   user=$ExpectedUser
#   tenant=$TenantId
#   subscription=$Subscription
AZURE_OPENAI_ENDPOINT=$openAIEndpoint
AZURE_OPENAI_API_KEY=$openAIKey
AZURE_OPENAI_CHAT_DEPLOYMENT=$OpenAIChatDeployment
AZURE_OPENAI_VISION_DEPLOYMENT=$OpenAIVisionDeployment
AZURE_OPENAI_IMAGE_DEPLOYMENT=$OpenAIImageDeployment
AZURE_OPENAI_BRIEF_SELECTOR_DEPLOYMENT=$OpenAIBriefSelectorDeployment
AZURE_OPENAI_API_VERSION=$OpenAIApiVersion$storageBlock
"@ | Set-Content $outPath -Encoding UTF8

        Write-Host ".env.local written to: $outPath" -ForegroundColor Green
    }
}

if ($SyncGitHubSecrets) {
    Require-Command 'gh'
    gh auth status 1>$null
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI is not authenticated. Run: gh auth login"
    }

    $connectionString = "DefaultEndpointsProtocol=https;AccountName=$StorageAccountName;AccountKey=$storageKey;EndpointSuffix=core.windows.net"

    Write-Host "Syncing GitHub Actions secrets to $GitHubRepo..." -ForegroundColor Cyan
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'AZURE_OPENAI_ENDPOINT' -Value $openAIEndpoint
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'AZURE_OPENAI_API_KEY' -Value $openAIKey
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'AZURE_OPENAI_CHAT_DEPLOYMENT' -Value $OpenAIChatDeployment
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'AZURE_OPENAI_VISION_DEPLOYMENT' -Value $OpenAIVisionDeployment
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'AZURE_OPENAI_IMAGE_DEPLOYMENT' -Value $OpenAIImageDeployment
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'AZURE_OPENAI_BRIEF_SELECTOR_DEPLOYMENT' -Value $OpenAIBriefSelectorDeployment
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'AZURE_OPENAI_API_VERSION' -Value $OpenAIApiVersion
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'AZURE_STORAGE_ACCOUNT' -Value $StorageAccountName
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'AZURE_STORAGE_KEY' -Value $storageKey
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'AZURE_STORAGE_CONNECTION_STRING' -Value $connectionString
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'AZURE_STORAGE_QUEUE_NAME' -Value $StorageQueueName
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'AZURE_STORAGE_RUNS_CONTAINER' -Value $StorageRunsContainer
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'AZURE_STORAGE_PLAYTEST_RUNS_CONTAINER' -Value $StoragePlaytestRunsContainer
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'SPRITES_ASSET_QUEUE' -Value 'azure-queue'
    Set-GitHubSecretValue -Repo $GitHubRepo -Name 'SPRITES_RUN_STORE' -Value 'azure-blob'

    Write-Host "GitHub secrets sync complete." -ForegroundColor Green
}
