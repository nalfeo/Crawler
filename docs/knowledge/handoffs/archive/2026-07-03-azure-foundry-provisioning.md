# Session Handoff: Azure AI Foundry provisioning + selection (ADR 0033 Phase 2)

## Date

2026-07-03

## Persona(s) adopted

Toolsmith — agent/operator infrastructure: PowerShell setup scripts, env/secret
wiring, and provisioning docs for the sprite asset-gen pipeline. No gameplay
`src/core|engine|game` systems touched, so no lab / wired-systems guard applies.

## Routing verdict

✅ right persona — single-owner infra-scripting change (2 setup scripts + 1 new
shared helper + tests/docs), no cross-layer gameplay concerns.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — scope matched the plan: a new pure PowerShell catalog module
plus surgical wiring into two existing scripts, mirrored tests, and docs. Plan
review surfaced 7 concerns (all adopted before coding); code review came back
clean on round 1 with zero rework.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

azure-infra

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-03-azure-foundry-provisioning.review-ledger.json`
Tier: 3🍎 → stages `plan_review` + `code_review` (loop).

- **plan_review**: separate model (`gpt-5.4` rubber-duck) reviewed the plan →
  `approved_with_changes`, 7 concerns (1 blocking, 5 non-blocking, 1 suggestion),
  **all 7 adopted** before implementation. Key one (#1, blocking):
  `FOUNDRY_*_MODEL` are Azure **deployment aliases** (the
  `/openai/deployments/{alias}` path segment), NOT catalog model IDs — drove the
  single-source-of-truth design.
- **code_review** (loop, clean): round 1 via the `code-review` agent on
  `claude-sonnet-4.6` over the full working-tree diff — **0 concerns**. It ran
  the ps1 + vitest suites and parse-checked the scripts, and independently
  confirmed all six invariants (see below). Single clean round satisfies the loop.

`npm run review:ledger -- validate <path>` → pass (`valid 3-apple ledger`).

## What Was Done

Extended the Azure setup tooling so Azure **AI Foundry** can be provisioned and
selected for asset (sprite/art) generation, while keeping `azure-openai` the
default. This is **Phase 2 groundwork** for ADR 0033 (Phase 1 — factory
`foundry` backend + `FOUNDRY_*` env reading — already merged).

### New shared module — `scripts/azure-foundry-plan.ps1`

Paramless, side-effect-free single source of truth for the Foundry catalog, so
all three callers (resources.ps1, env.ps1, tests) can dot-source it without the
param-clobber that dot-sourcing a param'd script would cause:

- `Get-FoundryStarterRoles` — the role→(alias, model, version, env var) table.
- `Get-FoundryDeploymentPlan [-Roles]` — returns `{ Deployments (deduped,
ordered), Env (ordered FOUNDRY_*_MODEL→alias map) }`. **Two guards**: throws if
  the text alias == selector alias (mirrors the factory's
  `createBriefSelectorProvider` invariant), and throws if one alias maps to a
  conflicting model/version.
- `Format-FoundryEnvBlock -Endpoint -ApiKey -ApiVersion -EnvMap` — renders the
  `.env.local` block with every `SPRITES_*_PROVIDER=foundry` selector left
  **commented** (azure-openai stays default).
- `Get-FoundrySecretNames` — the 7 GitHub-secret keys.

**Starter catalog = 3 deployments / 4 env vars** (OpenAI-format only):
`gpt-image-1`→`FOUNDRY_IMAGE_MODEL`; `gpt-4o`→`FOUNDRY_TEXT_MODEL` **and**
`FOUNDRY_VISION_MODEL` (shared, deduped to one deployment);
`gpt-4o-mini`→`FOUNDRY_BRIEF_SELECTOR_MODEL` (distinct so selector≠text holds).

### `scripts/setup-azure-resources.ps1`

Added `-IncludeFoundry` + `-FoundryResourceGroup` / `-FoundryLocation` (default
`eastus`) / `-FoundryAccountName` params; the two Foundry names in the default
`$PersistentResourceNames`; dot-sources the plan module; `Ensure-AIFoundryAccount`
(`az cognitiveservices account --kind AIServices`); and a Foundry provisioning
block **inside `Invoke-Provisioning`** (so the dot-source guard keeps it inert
during tests) that loops `$foundryPlan.Deployments` through the existing
kind-agnostic `Ensure-OpenAIDeployment`.

### `scripts/setup-azure-env.ps1`

Added the matching Foundry params (incl. `-FoundryApiVersion`, default
`2025-04-01-preview`); dot-sources the plan module; forwards `-IncludeFoundry` +
Foundry flags to resources.ps1 only under `-ProvisionResources`; fetches the
Foundry endpoint+key (guarded, throw-on-empty); appends `$foundryBlock` to the
`.env.local` here-string; and a **data-driven** FOUNDRY\_\* GitHub-secret sync loop
driven off `Get-FoundrySecretNames` (throws on any name/value drift). The
existing no-clobber guard (refuses to overwrite `.env.local` without `-Force`) is
unchanged.

### Tests

- `scripts/setup-azure-resources.tests.ps1` (dependency-free, +Foundry section):
  default-plan shape (3 deployments, gpt-4o deduped once, 4 env keys/values),
  both adversarial throws (text==selector; conflicting alias), `Format-FoundryEnvBlock`
  content + commented selectors, `Get-FoundrySecretNames` == 7 keys, Foundry
  names persistent by default, and an **env.ps1 contract scan** asserting it
  drives sync off the shared helpers and wires a value for every secret. **54
  assertions pass.**
- `tests/unit/sprites/factory.test.ts` (+2 cases): a contract test building all
  four providers from the **exact** env the script writes (image=gpt-image-1,
  text/vision=gpt-4o, selector=gpt-4o-mini) — selector≠text passes, synth label
  = `foundry:gpt-4o`. **18 tests pass.**

### Docs + scripts

- `package.json`: `setup:azure:foundry` (+`:env`) scripts.
- `scripts/azure-env.example`: scope-accurate Foundry block (dropped the FLUX/router
  overclaim — that's Phase 4).
- `infra/README.md`: new "Azure AI Foundry (optional — ADR 0033)" section
  (what's provisioned, catalog table, OpenAI-format scope note, `setup:azure:foundry`
  usage, secret list, **live smoke** curl steps, **sidecar-bootstrap gap** note),
  a FOUNDRY\_\* env block, updated persistent-names + a `FOUNDRY_API_KEY` security note.
- `docs/knowledge/adr/0033-azure-foundry-content-generation.md`: **Proposed →
  Accepted**; Migration Phases annotated (Phase 1 done, Phase 2 groundwork
  landed, non-OpenAI catalog + router explicitly deferred to Phase 4).

## Verification

- `pwsh -NoProfile -File scripts/setup-azure-resources.tests.ps1` → **exit 0, 54
  assertions pass** (before + after).
- `npx vitest run tests/unit/sprites/factory.test.ts` → **18 passed**.
- `npm run verify` → typecheck, lint, format, guards, unit+integration (53
  passed | 1 skipped), build all **green**. (Headless Floor-1 gate correctly
  deferred to CI; no `src/**` change so it's N/A. `verify:pr-prereqs` flagged only
  this handoff + the then-unfilled code_review stage — both now resolved.)
- Code-review agent independently re-ran the ps1 + vitest suites and
  parse-checked the scripts as part of its clean verdict.

**Observe-before-done note:** this change ships **no runtime `src/**`system** —
it is provisioning tooling + env wiring. "Observation" is therefore the
deterministic test suites above (ps1 plan/guards/contract + factory
provider-construction from the real emitted env), not a lab or headless run.
Real end-to-end Foundry provisioning is an **operator step** (requires live Azure
creds) documented as the`infra/README.md` live-smoke curls; it is intentionally
NOT run in CI.

## What's Next

Tracked ADR 0033 follow-ups (out of scope here):

1. **Phase 2 default flip** — once an operator provisions Foundry and runs the
   live smoke, flip live image+text to Foundry by default and re-baseline the
   sensors/judge.
2. **Sidecar bootstrap parity** — the sprite sidecar's Azure auto-bootstrap
   writes Storage/OpenAI env but not `FOUNDRY_*`; Foundry users must run
   `npm run setup:azure:foundry:env` themselves until parity lands.
3. **Phase 3** — Entra/Managed-Identity auth; deprecate `AZURE_OPENAI_*` root keys.
4. **Phase 4** — non-OpenAI catalog (FLUX/SDXL/Llama/Phi) + model router via the
   Azure AI Model-Inference route (needs a provider URL change).

## Blockers

None.

## Merge Policy Note

Authorized-to-merge path: `gh pr merge --auto --squash`, then bounded final-state
verification (`state=MERGED`, non-null `mergeCommit`) + clear any unresolved
review threads. No human review is required by branch protection.
