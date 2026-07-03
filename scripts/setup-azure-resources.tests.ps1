<#
.SYNOPSIS
    Dependency-free tests for the pure decision functions in
    setup-azure-resources.ps1 (no Pester, no Azure CLI required).

.DESCRIPTION
    Dot-sources setup-azure-resources.ps1 — the dot-source guard
    (`if ($MyInvocation.InvocationName -ne '.')`) means provisioning does NOT
    run, so we get the pure functions without touching Azure. Asserts every
    branch of Resolve-ResourceAction / Test-IsPersistentResource /
    Assert-NotBlocked, plus the shared Azure AI Foundry catalog helpers
    (Get-FoundryDeploymentPlan / Format-FoundryEnvBlock / Get-FoundrySecretNames,
    dot-sourced transitively via azure-foundry-plan.ps1) and the
    setup-azure-env.ps1 FOUNDRY_* secret-sync contract. Exits non-zero on any
    failure.

.EXAMPLE
    pwsh -NoProfile -File scripts/setup-azure-resources.tests.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Dot-source the script under test; the guard keeps provisioning from running.
. (Join-Path $PSScriptRoot 'setup-azure-resources.ps1')

$script:Failures = 0
$script:Passed = 0

function Assert-Equal {
    param([Parameter(Mandatory)]$Expected, [Parameter(Mandatory)]$Actual, [Parameter(Mandatory)][string]$Message)
    if ($Expected -eq $Actual) {
        $script:Passed++
    }
    else {
        $script:Failures++
        Write-Host "FAIL: $Message (expected '$Expected', got '$Actual')" -ForegroundColor Red
    }
}

function Assert-True {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if ($Condition) { $script:Passed++ }
    else {
        $script:Failures++
        Write-Host "FAIL: $Message (expected true)" -ForegroundColor Red
    }
}

# ── Resolve-ResourceAction ──────────────────────────────────────────────────

# Missing resource is always created, no matter the other flags.
Assert-Equal 'create' (Resolve-ResourceAction -Exists $false) 'missing -> create'
Assert-Equal 'create' (Resolve-ResourceAction -Exists $false -Recreate $true -IsPersistent $true -AllowRecreatePersistent $true) 'missing -> create even with all flags'

# Existing resource, no -Recreate -> idempotent skip (never needlessly re-created).
Assert-Equal 'skip' (Resolve-ResourceAction -Exists $true) 'exists, no recreate -> skip'
Assert-Equal 'skip' (Resolve-ResourceAction -Exists $true -IsPersistent $true) 'exists persistent, no recreate -> skip'

# Existing non-persistent resource with -Recreate -> recreate.
Assert-Equal 'recreate' (Resolve-ResourceAction -Exists $true -Recreate $true) 'exists non-persistent, recreate -> recreate'

# Existing PERSISTENT resource with -Recreate but no opt-in -> blocked (protected).
Assert-Equal 'blocked' (Resolve-ResourceAction -Exists $true -Recreate $true -IsPersistent $true) 'exists persistent, recreate, no allow -> blocked'

# Existing persistent resource with -Recreate AND the explicit opt-in -> recreate.
Assert-Equal 'recreate' (Resolve-ResourceAction -Exists $true -Recreate $true -IsPersistent $true -AllowRecreatePersistent $true) 'exists persistent, recreate, allow -> recreate'

# AllowRecreatePersistent without -Recreate is inert.
Assert-Equal 'skip' (Resolve-ResourceAction -Exists $true -AllowRecreatePersistent $true) 'allow without recreate -> skip'

# ── Test-IsPersistentResource ───────────────────────────────────────────────

$names = @('crawlersprites', 'aoai-crawler-nalfeo')
Assert-True (Test-IsPersistentResource -Name 'crawlersprites' -PersistentNames $names) 'name in list -> persistent'
Assert-True (-not (Test-IsPersistentResource -Name 'crawlerspritesdev' -PersistentNames $names)) 'name not in list -> not persistent'
Assert-True (-not (Test-IsPersistentResource -Name 'crawlersprites' -PersistentNames @())) 'empty list -> not persistent'

# ── Assert-NotBlocked ───────────────────────────────────────────────────────

$threw = $false
try { Assert-NotBlocked -Action 'blocked' -ResourceKind 'storage account' -Name 'crawlersprites' }
catch { $threw = $true }
Assert-True $threw "Assert-NotBlocked throws on 'blocked'"

foreach ($ok in @('create', 'skip', 'recreate')) {
    $threwOk = $false
    try { Assert-NotBlocked -Action $ok -ResourceKind 'storage account' -Name 'x' }
    catch { $threwOk = $true }
    Assert-True (-not $threwOk) "Assert-NotBlocked silent on '$ok'"
}

# ── Get-FoundryDeploymentPlan (ADR 0033, shared azure-foundry-plan.ps1) ──────
# The plan functions are dot-sourced transitively (setup-azure-resources.ps1
# dot-sources azure-foundry-plan.ps1); re-import explicitly so this section is
# self-contained regardless of source order.
. (Join-Path $PSScriptRoot 'azure-foundry-plan.ps1')

$plan = Get-FoundryDeploymentPlan

# Text + Vision share the gpt-4o deployment, so the catalog is THREE deployments.
Assert-Equal 3 (@($plan.Deployments).Count) 'starter catalog -> 3 unique deployments'
$aliases = @($plan.Deployments | ForEach-Object { $_.Alias })
Assert-True ($aliases -contains 'gpt-image-1') 'deployments include gpt-image-1'
Assert-True ($aliases -contains 'gpt-4o') 'deployments include gpt-4o'
Assert-True ($aliases -contains 'gpt-4o-mini') 'deployments include gpt-4o-mini'
Assert-Equal 1 (@($aliases | Where-Object { $_ -eq 'gpt-4o' }).Count) 'gpt-4o deployment is deduped to one entry'
Assert-True (@($plan.Deployments | Where-Object { $_.Format -ne 'OpenAI' }).Count -eq 0) 'every deployment is OpenAI-format'

# Env map: FOUNDRY_*_MODEL -> deployment alias, one entry per role.
Assert-Equal 4 ($plan.Env.Count) 'env map exposes 4 FOUNDRY_*_MODEL vars'
Assert-Equal 'gpt-image-1' ($plan.Env['FOUNDRY_IMAGE_MODEL']) 'image alias'
Assert-Equal 'gpt-4o' ($plan.Env['FOUNDRY_TEXT_MODEL']) 'text alias'
Assert-Equal 'gpt-4o' ($plan.Env['FOUNDRY_VISION_MODEL']) 'vision alias (shares text deployment)'
Assert-Equal 'gpt-4o-mini' ($plan.Env['FOUNDRY_BRIEF_SELECTOR_MODEL']) 'brief-selector alias'
# Mirrors the factory invariant: selector must differ from text.
Assert-True ($plan.Env['FOUNDRY_TEXT_MODEL'] -ne $plan.Env['FOUNDRY_BRIEF_SELECTOR_MODEL']) 'text alias != selector alias'

# Guard 1: text alias == selector alias must throw (factory rejects that pair).
$badRoles = @(
    [pscustomobject]@{ Role = 'Text'; EnvVar = 'FOUNDRY_TEXT_MODEL'; Alias = 'gpt-4o'; ModelName = 'gpt-4o'; ModelVersion = '2024-11-20' }
    [pscustomobject]@{ Role = 'Selector'; EnvVar = 'FOUNDRY_BRIEF_SELECTOR_MODEL'; Alias = 'gpt-4o'; ModelName = 'gpt-4o'; ModelVersion = '2024-11-20' }
)
$threw = $false
try { Get-FoundryDeploymentPlan -Roles $badRoles } catch { $threw = $true }
Assert-True $threw 'Get-FoundryDeploymentPlan throws when text alias == selector alias'

# Guard 2: one alias mapped to conflicting model/version must throw (silent drift).
$conflictRoles = @(
    [pscustomobject]@{ Role = 'Image'; EnvVar = 'FOUNDRY_IMAGE_MODEL'; Alias = 'dup'; ModelName = 'gpt-image-1'; ModelVersion = 'latest' }
    [pscustomobject]@{ Role = 'Text'; EnvVar = 'FOUNDRY_TEXT_MODEL'; Alias = 'dup'; ModelName = 'gpt-4o'; ModelVersion = '2024-11-20' }
)
$threwConflict = $false
try { Get-FoundryDeploymentPlan -Roles $conflictRoles } catch { $threwConflict = $true }
Assert-True $threwConflict 'Get-FoundryDeploymentPlan throws on conflicting alias -> model mapping'

# ── Format-FoundryEnvBlock ──────────────────────────────────────────────────

$block = Format-FoundryEnvBlock -Endpoint 'https://foundry.example/' -ApiKey 'SECRET' -ApiVersion '2025-04-01-preview' -EnvMap $plan.Env
Assert-True ($block -match 'FOUNDRY_ENDPOINT=https://foundry\.example/') 'env block writes the endpoint'
Assert-True ($block -match 'FOUNDRY_API_KEY=SECRET') 'env block writes the api key'
Assert-True ($block -match 'FOUNDRY_TEXT_MODEL=gpt-4o(\r?\n)') 'env block writes text alias'
Assert-True ($block -match 'FOUNDRY_BRIEF_SELECTOR_MODEL=gpt-4o-mini') 'env block writes selector alias'
# Selectors stay COMMENTED so azure-openai remains the default (ADR 0033).
Assert-True ($block -match '#\s*SPRITES_PROVIDER=foundry') 'SPRITES_PROVIDER selector is commented out'
Assert-True (-not ($block -match '(?m)^SPRITES_\w+_?PROVIDER=foundry')) 'no selector is written uncommented'

# ── Get-FoundrySecretNames + setup-azure-env.ps1 contract ───────────────────

$secretNames = @(Get-FoundrySecretNames)
Assert-Equal 7 ($secretNames.Count) 'Get-FoundrySecretNames returns 7 keys'
foreach ($expected in @('FOUNDRY_ENDPOINT', 'FOUNDRY_API_KEY', 'FOUNDRY_API_VERSION', 'FOUNDRY_IMAGE_MODEL', 'FOUNDRY_TEXT_MODEL', 'FOUNDRY_VISION_MODEL', 'FOUNDRY_BRIEF_SELECTOR_MODEL')) {
    Assert-True ($secretNames -contains $expected) "Get-FoundrySecretNames includes $expected"
}

# Contract: setup-azure-env.ps1 drives its FOUNDRY_* secret sync off the shared
# helpers and wires a value for every declared secret name. Guards the exact
# regression class (env-writer / secret-list drift) flagged in plan review.
$envScript = Get-Content (Join-Path $PSScriptRoot 'setup-azure-env.ps1') -Raw
Assert-True ($envScript -match 'Get-FoundrySecretNames') 'env script drives sync loop via Get-FoundrySecretNames'
Assert-True ($envScript -match 'Format-FoundryEnvBlock') 'env script renders .env.local via Format-FoundryEnvBlock'
foreach ($name in $secretNames) {
    Assert-True ($envScript -match ("(?m)^\s*" + [regex]::Escape($name) + "\s*=")) "env script wires a value for secret $name"
}

# ── Foundry resources are protected by default ──────────────────────────────
Assert-True (Test-IsPersistentResource -Name 'aif-crawler-nalfeo' -PersistentNames $PersistentResourceNames) 'Foundry account is persistent by default'
Assert-True (Test-IsPersistentResource -Name 'rg-crawler-foundry' -PersistentNames $PersistentResourceNames) 'Foundry resource group is persistent by default'

# ── Summary ─────────────────────────────────────────────────────────────────

Write-Host ""
if ($script:Failures -eq 0) {
    Write-Host "PASS: $($script:Passed) assertions passed." -ForegroundColor Green
    exit 0
}
else {
    Write-Host "$($script:Failures) failed, $($script:Passed) passed." -ForegroundColor Red
    exit 1
}
