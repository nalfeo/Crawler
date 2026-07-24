<#
.SYNOPSIS
    Dependency-free tests for the pure decision functions in
    setup-azure-resources.ps1 (no Pester, no Azure CLI required).

.DESCRIPTION
    Dot-sources setup-azure-resources.ps1 — the dot-source guard
    (`if ($MyInvocation.InvocationName -ne '.')`) means provisioning does NOT
    run, so we get the pure functions without touching Azure. Asserts every
    branch of Resolve-ResourceAction / Test-IsPersistentResource /
    Assert-NotBlocked. Exits non-zero on any failure.

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
