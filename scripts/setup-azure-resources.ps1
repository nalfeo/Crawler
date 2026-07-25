<#
.SYNOPSIS
    Provision Azure resources required for sprite image-generation E2E.

.DESCRIPTION
    Ensures the required resource groups, storage resources, Azure OpenAI
    account, and model deployments exist.

    Idempotent by default: anything that already exists is left untouched and
    is never needlessly re-created (this includes the storage template, which
    is only deployed when the account is missing — pass -Force to redeploy it).

    Optional -Recreate deletes and re-creates the *stateful* resources (the
    storage account and the model deployments) so a dev/test environment can be
    reset to a known-good state. Resource groups and the Azure OpenAI account
    are containers and are only ever created-if-missing, never auto-deleted.

    SAFETY: deleting the storage account destroys every stored sprite run and
    the durable workflow-state queue the devtools UI reads. To protect the
    environment you interact with day to day, -Recreate REFUSES to delete any
    resource named in -PersistentResourceNames unless you also pass
    -AllowRecreatePersistent. In other words: the persistent version is never
    blown away without you explicitly asking for it.

.EXAMPLE
    # Idempotent provisioning (default): create anything missing, touch nothing else.
    pwsh scripts/setup-azure-resources.ps1

.EXAMPLE
    # Reset a DEV/TEST storage account to a clean slate (non-persistent name,
    # so no extra confirmation is required):
    pwsh scripts/setup-azure-resources.ps1 -StorageAccountName crawlerspritesdev -Recreate

.EXAMPLE
    # Recreate the PERSISTENT storage account — DESTRUCTIVE: deletes all stored
    # runs + workflow-state. Requires the explicit opt-in flag:
    pwsh scripts/setup-azure-resources.ps1 -Recreate -AllowRecreatePersistent
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
    [string]$StorageAccountName = 'crawlersprites',

    # ── Recreate / safety controls ──────────────────────────────────────────
    # Delete + re-create the stateful resources (storage account, model
    # deployments) for a clean dev/test slate. Off by default.
    [switch]$Recreate,
    # Required to let -Recreate destroy a resource listed in
    # -PersistentResourceNames. This is the "yes, I really mean the persistent
    # one" confirmation.
    [switch]$AllowRecreatePersistent,
    # Redeploy the storage template even when the account already exists,
    # WITHOUT deleting it (idempotent ARM redeploy — e.g. to re-assert the
    # container/queue). Distinct from the destructive -Recreate.
    [switch]$Force,
    # Resources that hold state you interact with. -Recreate will not delete
    # any of these without -AllowRecreatePersistent.
    [string[]]$PersistentResourceNames = @(
        'aoai-crawler-nalfeo', # persistent Azure OpenAI account
        'crawlersprites',      # persistent Storage account (stored runs + workflow-state)
        'rg-crawler-sprites',  # persistent OpenAI resource group
        'crawler-sprites-rg'   # persistent Storage resource group
    )
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Pure decision logic (no Azure calls; unit-testable) ─────────────────────

function Test-IsPersistentResource {
    # A resource is "persistent" (protected from -Recreate) when its name is in
    # the supplied list. Kept pure so the guard can be exercised without Azure.
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Name,
        [string[]]$PersistentNames = @()
    )
    return @($PersistentNames) -contains $Name
}

function Resolve-ResourceAction {
    <#
        Decide what to do with a single resource given whether it exists and the
        requested mode. Pure — returns one of:
          'create'   resource is missing -> create it
          'skip'     exists, no -Recreate -> leave it alone (idempotent default)
          'recreate' exists, -Recreate, and deletion is permitted
          'blocked'  exists, -Recreate, but it is persistent and the caller has
                     not passed -AllowRecreatePersistent (refuse to destroy)
        No side effects, so it is unit-testable without an Azure subscription.
    #>
    param(
        [Parameter(Mandatory)][bool]$Exists,
        [bool]$Recreate = $false,
        [bool]$IsPersistent = $false,
        [bool]$AllowRecreatePersistent = $false
    )
    if (-not $Exists) { return 'create' }
    if (-not $Recreate) { return 'skip' }
    if ($IsPersistent -and -not $AllowRecreatePersistent) { return 'blocked' }
    return 'recreate'
}

function Assert-NotBlocked {
    # Translate a 'blocked' decision into a clear, actionable failure so a
    # persistent resource is never silently destroyed.
    param(
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$ResourceKind,
        [Parameter(Mandatory)][string]$Name
    )
    if ($Action -eq 'blocked') {
        throw (
            "Refusing to delete and re-create the persistent $ResourceKind '$Name'. " +
            "It is listed in -PersistentResourceNames and holds state you interact " +
            "with (stored sprite runs and the durable workflow queue). Re-run with " +
            "-AllowRecreatePersistent to confirm destruction, or target a " +
            "differently-named dev/test resource."
        )
    }
}

# ── Azure helpers ───────────────────────────────────────────────────────────

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Ensure-ResourceGroup([string]$Name, [string]$Location) {
    # Resource groups are containers: only ever created-if-missing, never
    # auto-deleted (deleting an RG would cascade to every resource inside it).
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

function Test-OpenAIAccountExists([string]$ResourceGroup, [string]$Name) {
    az cognitiveservices account show --name $Name --resource-group $ResourceGroup 1>$null 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Ensure-OpenAIAccount([string]$ResourceGroup, [string]$Name, [string]$Location) {
    # The Azure OpenAI account is a persistent container (deleting it soft-deletes
    # the account and all of its deployments), so it is only created-if-missing.
    if (Test-OpenAIAccountExists -ResourceGroup $ResourceGroup -Name $Name) {
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

function New-OpenAIDeployment(
    [string]$ResourceGroup,
    [string]$AccountName,
    [string]$DeploymentName,
    [string]$ModelName,
    [string]$ModelVersion
) {
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

function Ensure-OpenAIDeployment(
    [string]$ResourceGroup,
    [string]$AccountName,
    [string]$DeploymentName,
    [string]$ModelName,
    [string]$ModelVersion,
    [switch]$Recreate,
    [switch]$AllowRecreatePersistent,
    [string[]]$PersistentNames
) {
    az cognitiveservices account deployment show `
        --resource-group $ResourceGroup `
        --name $AccountName `
        --deployment-name $DeploymentName 1>$null 2>$null
    $exists = ($LASTEXITCODE -eq 0)
    $isPersistent = Test-IsPersistentResource -Name $DeploymentName -PersistentNames $PersistentNames
    $action = Resolve-ResourceAction -Exists $exists -Recreate ([bool]$Recreate) `
        -IsPersistent $isPersistent -AllowRecreatePersistent ([bool]$AllowRecreatePersistent)
    Assert-NotBlocked -Action $action -ResourceKind 'OpenAI deployment' -Name $DeploymentName

    switch ($action) {
        'skip' {
            Write-Host "OpenAI deployment exists: $DeploymentName" -ForegroundColor DarkGray
        }
        'recreate' {
            Write-Host "Deleting OpenAI deployment: $DeploymentName" -ForegroundColor Yellow
            az cognitiveservices account deployment delete `
                --resource-group $ResourceGroup `
                --name $AccountName `
                --deployment-name $DeploymentName 1>$null
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to delete OpenAI deployment '$DeploymentName'."
            }
            New-OpenAIDeployment -ResourceGroup $ResourceGroup -AccountName $AccountName `
                -DeploymentName $DeploymentName -ModelName $ModelName -ModelVersion $ModelVersion
        }
        'create' {
            New-OpenAIDeployment -ResourceGroup $ResourceGroup -AccountName $AccountName `
                -DeploymentName $DeploymentName -ModelName $ModelName -ModelVersion $ModelVersion
        }
    }
}

function Test-StorageAccountExists([string]$ResourceGroup, [string]$Name) {
    az storage account show --name $Name --resource-group $ResourceGroup 1>$null 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Deploy-StorageTemplate([string]$ResourceGroup, [string]$Name, [string]$TemplateFile) {
    Write-Host "Deploying storage template -> $Name" -ForegroundColor Cyan
    az deployment group create `
        --resource-group $ResourceGroup `
        --template-file $TemplateFile `
        --parameters storageAccountName=$Name 1>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to deploy storage template."
    }
}

function Ensure-StorageAccount(
    [string]$ResourceGroup,
    [string]$Name,
    [string]$TemplateFile,
    [switch]$Recreate,
    [switch]$Force,
    [switch]$AllowRecreatePersistent,
    [string[]]$PersistentNames
) {
    $exists = Test-StorageAccountExists -ResourceGroup $ResourceGroup -Name $Name
    $isPersistent = Test-IsPersistentResource -Name $Name -PersistentNames $PersistentNames
    $action = Resolve-ResourceAction -Exists $exists -Recreate ([bool]$Recreate) `
        -IsPersistent $isPersistent -AllowRecreatePersistent ([bool]$AllowRecreatePersistent)
    Assert-NotBlocked -Action $action -ResourceKind 'storage account' -Name $Name

    switch ($action) {
        'create' {
            Deploy-StorageTemplate -ResourceGroup $ResourceGroup -Name $Name -TemplateFile $TemplateFile
        }
        'recreate' {
            Write-Host "Deleting storage account: $Name (and all stored runs + workflow-state)" -ForegroundColor Yellow
            az storage account delete --name $Name --resource-group $ResourceGroup --yes 1>$null
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to delete storage account '$Name'."
            }
            Deploy-StorageTemplate -ResourceGroup $ResourceGroup -Name $Name -TemplateFile $TemplateFile
        }
        'skip' {
            if ($Force) {
                Write-Host "Storage account exists: $Name — -Force set, redeploying template (no delete)." -ForegroundColor Cyan
                Deploy-StorageTemplate -ResourceGroup $ResourceGroup -Name $Name -TemplateFile $TemplateFile
            }
            else {
                Write-Host "Storage account exists: $Name — skipping template deploy (pass -Force to redeploy, -Recreate to delete+recreate)." -ForegroundColor DarkGray
            }
        }
    }
}

function Assert-AzureContext {
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
}

function Invoke-Provisioning {
    Require-Command 'az'
    Assert-AzureContext

    if ($Recreate) {
        if ($AllowRecreatePersistent) {
            Write-Host "-Recreate enabled WITH -AllowRecreatePersistent: persistent resources MAY be deleted." -ForegroundColor Yellow
        }
        else {
            Write-Host "-Recreate enabled: non-persistent resources will be reset; persistent ones are protected." -ForegroundColor Yellow
        }
    }

    Ensure-ResourceGroup -Name $StorageResourceGroup -Location $StorageLocation
    Ensure-ResourceGroup -Name $OpenAIResourceGroup -Location $OpenAILocation

    $repoRoot = Split-Path $PSScriptRoot
    $storageBicep = Join-Path $repoRoot 'infra\azure-storage.bicep'
    if (-not (Test-Path $storageBicep)) {
        throw "Missing template: $storageBicep"
    }

    Ensure-StorageAccount `
        -ResourceGroup $StorageResourceGroup `
        -Name $StorageAccountName `
        -TemplateFile $storageBicep `
        -Recreate:$Recreate `
        -Force:$Force `
        -AllowRecreatePersistent:$AllowRecreatePersistent `
        -PersistentNames $PersistentResourceNames

    Ensure-OpenAIAccount -ResourceGroup $OpenAIResourceGroup -Name $OpenAIAccountName -Location $OpenAILocation
    Ensure-OpenAIDeployment -ResourceGroup $OpenAIResourceGroup -AccountName $OpenAIAccountName `
        -DeploymentName $OpenAIChatDeployment -ModelName $OpenAIChatModelName -ModelVersion $OpenAIChatModelVersion `
        -Recreate:$Recreate -AllowRecreatePersistent:$AllowRecreatePersistent -PersistentNames $PersistentResourceNames
    Ensure-OpenAIDeployment -ResourceGroup $OpenAIResourceGroup -AccountName $OpenAIAccountName `
        -DeploymentName $OpenAIVisionDeployment -ModelName $OpenAIVisionModelName -ModelVersion $OpenAIVisionModelVersion `
        -Recreate:$Recreate -AllowRecreatePersistent:$AllowRecreatePersistent -PersistentNames $PersistentResourceNames
    Ensure-OpenAIDeployment -ResourceGroup $OpenAIResourceGroup -AccountName $OpenAIAccountName `
        -DeploymentName $OpenAIImageDeployment -ModelName $OpenAIImageModelName -ModelVersion $OpenAIImageModelVersion `
        -Recreate:$Recreate -AllowRecreatePersistent:$AllowRecreatePersistent -PersistentNames $PersistentResourceNames

    Write-Host "Azure resource provisioning complete." -ForegroundColor Green
}

# Only run provisioning when executed directly (not when dot-sourced for tests).
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-Provisioning
}
