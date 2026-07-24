<#
.SYNOPSIS
    [ARCHIVED — ADR 0072] Azure AI Foundry starter catalog helpers (ADR 0033).

.DESCRIPTION
    ARCHIVED: The foundry backend was retired in ADR 0072. The aif-crawler-nalfeo
    Foundry resource has zero deployments and no obtainable quota. The asset
    pipeline standardized on the azure-openai backend.

    This file is kept for reference and to allow the existing
    setup-azure-resources.tests.ps1 assertions to continue to pass during the
    transition period. The functions it defines are no longer called by
    setup-azure-env.ps1 or setup-azure-resources.ps1.

    Original description: Pure, paramless, side-effect-free helpers shared by three callers:
      - setup-azure-resources.ps1 (provisions the deployments),
      - setup-azure-env.ps1       (writes .env.local + GitHub secrets),
      - setup-azure-resources.tests.ps1 (dependency-free unit tests).

    It defines functions ONLY — no param block, no top-level Azure/gh calls — so
    dot-sourcing it into either setup script leaves that script's own bound
    parameters untouched, and the test harness gets the pure functions without
    touching Azure.

    KEY SEMANTICS — alias, not model ID:
    `FOUNDRY_*_MODEL` values are Azure **deployment aliases**: the
    `{FOUNDRY_ENDPOINT}/openai/deployments/{ALIAS}/...` path segment the sprite
    factory (scripts/sprites/provider/factory.ts) puts in every request URL —
    NOT raw catalog model IDs. Provisioning creates a deployment named <Alias>
    from <ModelName>@<ModelVersion>. Text and Vision intentionally share one
    gpt-4o deployment, so the starter catalog is THREE deployments mapped to
    FOUR env vars.

    SCOPE (ADR 0033 Phase 2 groundwork): OpenAI-compatible models only, because
    the `/openai/deployments/` route above is the Azure OpenAI data-plane
    surface. Non-OpenAI catalog (FLUX/SDXL/Llama/Phi) and the model router use
    the Azure AI Model Inference route and are deferred to Phase 4.
#>

Set-StrictMode -Version Latest

function Get-FoundryStarterRoles {
    # The fixed starter catalog: one row per sprite-factory provider role. `Alias`
    # is the deployment name == URL path segment == FOUNDRY_*_MODEL value.
    # `ModelName`/`ModelVersion` are what Azure actually deploys under that alias.
    # Text and Vision share the gpt-4o alias on purpose (gpt-4o is vision-capable).
    return @(
        [pscustomobject]@{ Role = 'Image'; EnvVar = 'FOUNDRY_IMAGE_MODEL'; Alias = 'gpt-image-1'; ModelName = 'gpt-image-1'; ModelVersion = 'latest' }
        [pscustomobject]@{ Role = 'Text'; EnvVar = 'FOUNDRY_TEXT_MODEL'; Alias = 'gpt-4o'; ModelName = 'gpt-4o'; ModelVersion = '2024-11-20' }
        [pscustomobject]@{ Role = 'Vision'; EnvVar = 'FOUNDRY_VISION_MODEL'; Alias = 'gpt-4o'; ModelName = 'gpt-4o'; ModelVersion = '2024-11-20' }
        [pscustomobject]@{ Role = 'Selector'; EnvVar = 'FOUNDRY_BRIEF_SELECTOR_MODEL'; Alias = 'gpt-4o-mini'; ModelName = 'gpt-4o-mini'; ModelVersion = '2024-07-18' }
    )
}

function Get-FoundryDeploymentPlan {
    <#
        Build the provisioning + env plan from a role table (defaults to the
        starter catalog). Returns an object with:
          .Deployments  ordered, DEDUPED list of { Alias; ModelName; ModelVersion;
                        Format='OpenAI' } — the deployments to create.
          .Env          ordered map of FOUNDRY_*_MODEL -> alias (one entry per role).

        Guards (both mirror real invariants so provisioning fails loudly rather
        than producing a broken .env.local):
          1. THROWS if the text alias equals the brief-selector alias — the
             sprite factory (createBriefSelectorProvider) rejects that pair.
          2. THROWS if one alias is mapped to two different model/version pairs
             (silent catalog drift).
        Pure — no Azure calls — so it is exercised by the dependency-free tests.
    #>
    param(
        [pscustomobject[]]$Roles = (Get-FoundryStarterRoles)
    )

    if (-not $Roles -or @($Roles).Count -eq 0) {
        throw 'Get-FoundryDeploymentPlan: -Roles must contain at least one role.'
    }

    # FOUNDRY_*_MODEL -> alias, preserving role order.
    $envMap = [ordered]@{}
    foreach ($r in $Roles) {
        $envMap[$r.EnvVar] = $r.Alias
    }

    if ($envMap.Contains('FOUNDRY_TEXT_MODEL') -and $envMap.Contains('FOUNDRY_BRIEF_SELECTOR_MODEL') -and
        $envMap['FOUNDRY_TEXT_MODEL'] -eq $envMap['FOUNDRY_BRIEF_SELECTOR_MODEL']) {
        throw (
            "Foundry brief-selector alias ('$($envMap['FOUNDRY_BRIEF_SELECTOR_MODEL'])') must differ from the " +
            'text alias; the sprite factory (createBriefSelectorProvider) rejects an identical pair.'
        )
    }

    # Dedup by alias so Text + Vision collapse to one deployment; reject an alias
    # that resolves to conflicting model/version pairs.
    $byAlias = [ordered]@{}
    foreach ($r in $Roles) {
        if ($byAlias.Contains($r.Alias)) {
            $existing = $byAlias[$r.Alias]
            if ($existing.ModelName -ne $r.ModelName -or $existing.ModelVersion -ne $r.ModelVersion) {
                throw (
                    "Foundry deployment alias '$($r.Alias)' is mapped to conflicting models " +
                    "('$($existing.ModelName)@$($existing.ModelVersion)' vs '$($r.ModelName)@$($r.ModelVersion)')."
                )
            }
            continue
        }
        $byAlias[$r.Alias] = [pscustomobject]@{
            Alias        = $r.Alias
            ModelName    = $r.ModelName
            ModelVersion = $r.ModelVersion
            Format       = 'OpenAI'
        }
    }

    return [pscustomobject]@{
        Deployments = @($byAlias.Values)
        Env         = $envMap
    }
}

function Format-FoundryEnvBlock {
    <#
        Render the FOUNDRY_* block appended to .env.local. The SPRITES_*_PROVIDER
        selectors are written COMMENTED so azure-openai stays the default
        (ADR 0033); the operator opts in by uncommenting one.
    #>
    param(
        [Parameter(Mandatory)][string]$Endpoint,
        [Parameter(Mandatory)][string]$ApiKey,
        [Parameter(Mandatory)][string]$ApiVersion,
        [Parameter(Mandatory)][System.Collections.IDictionary]$EnvMap
    )
    $image = $EnvMap['FOUNDRY_IMAGE_MODEL']
    $text = $EnvMap['FOUNDRY_TEXT_MODEL']
    $vision = $EnvMap['FOUNDRY_VISION_MODEL']
    $selector = $EnvMap['FOUNDRY_BRIEF_SELECTOR_MODEL']
    return @"

# --- Azure AI Foundry (ADR 0033, opt-in - OpenAI-compatible subset only) -----
# Uncomment a selector to route that provider through Foundry instead of the
# default azure-openai backend. FLUX/SDXL/Llama + the model router are NOT wired
# yet (Phase 4 - they need the Azure AI Model Inference route, not the
# /openai/deployments route these deployment aliases use).
# SPRITES_PROVIDER=foundry          # image
# SPRITES_TEXT_PROVIDER=foundry     # variation expansion
# SPRITES_SYNTH_PROVIDER=foundry    # brief synthesis + brief selector
# SPRITES_VISION_PROVIDER=foundry   # judge
FOUNDRY_ENDPOINT=$Endpoint
FOUNDRY_API_KEY=$ApiKey
FOUNDRY_API_VERSION=$ApiVersion
FOUNDRY_IMAGE_MODEL=$image
FOUNDRY_TEXT_MODEL=$text
FOUNDRY_VISION_MODEL=$vision
FOUNDRY_BRIEF_SELECTOR_MODEL=$selector
"@
}

function Get-FoundrySecretNames {
    # The exact FOUNDRY_* GitHub Actions secret keys setup-azure-env.ps1 syncs
    # under -IncludeFoundry -SyncGitHubSecrets. Drives the sync loop AND the
    # contract test, so the two can never drift.
    return @(
        'FOUNDRY_ENDPOINT'
        'FOUNDRY_API_KEY'
        'FOUNDRY_API_VERSION'
        'FOUNDRY_IMAGE_MODEL'
        'FOUNDRY_TEXT_MODEL'
        'FOUNDRY_VISION_MODEL'
        'FOUNDRY_BRIEF_SELECTOR_MODEL'
    )
}
