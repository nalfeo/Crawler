# Handoff: Guard the dev-ingest GitHub credential, add OIDC deploy + canary automation

**Date:** 2026-09-01
**Session slug:** dev-ingest-credential-guard
**Apple estimate:** 5🍎 (estimated 3🍎 at kickoff for the bounded Bicep-guard scope;
the maintainer expanded scope mid-session to token-lifecycle hardening, automatic
Function deployment, and a live E2E canary — see "Scope expansion" below)
**Relates:** nalfeo/Crawler#4033, nalfeo/Crawler#4034 (parent investigation session
`ca35944d-1c98-4927-b8c0-6372dd6c7eb5` — both issues closed, real deployed-browser
proof of the fix already captured there)
**PR:** (this branch, `nalfeo-guard-ci-pat-bicep`)

## Systems touched

ci-policy, dev-tooling

## Problem

The in-game **Report Issue → Azure Function (`dev-build-ingest`) → GitHub issue**
flow could silently ship without a GitHub issue-write credential. The parent
investigation session proved this live: `POST .../runs` with `file_issue:true`
returned HTTP 500 `{"error":"missing required configuration: CRAWLER_CI_PAT"}`
because `infra/dev-build-ingest.bicep` provisioned every Function App setting
**except** `CRAWLER_CI_PAT`, and `infra/README.md` said so explicitly. The parent
fixed the _live_ Function App setting (with user approval, from the authenticated
`gh` token) and got a real HTTP 201 + issue #4034 through the deployed game's F8
picker — but nothing stopped the **next** Bicep deployment from silently reverting
to the broken state, because the parameter simply didn't exist.

## Original bounded fix (complete, unchanged from earlier in this session)

- `infra/dev-build-ingest.bicep`: added a **required** `@secure() param githubCiPat
string` (no default) and wired it into the Function App's `CRAWLER_CI_PAT`
  app setting. A deployment that omits the parameter now fails at Bicep
  compile/deploy time (`BCP035`-class "missing required parameter"), not with a
  silent runtime 500.
- `tests/unit/dev-build-ingest-bicep.test.ts` (new): deterministic contract test
  parsing the Bicep source to assert (a) `githubCiPat` exists, is `@secure()`,
  and has no default, and (b) it is wired to the `CRAWLER_CI_PAT` app setting.
  Fails if the wiring is removed or renamed.
- `tests/unit/dev-build-ingest-handler.test.ts`: existing regression coverage
  that `file_issue:true` invokes GitHub issue creation continues to pass
  unchanged — this PR does not touch the handler's runtime behavior.
- `infra/README.md`: updated to stop claiming the credential is unset (it now
  documents the required parameter and the deployment-time failure mode).

## Scope expansion (maintainer, mid-session)

The maintainer explicitly expanded this from the bounded Bicep fix into 4
additional hard requirements, with an explicit instruction to **stop and report**
rather than fake/weaken anything if a step needed a human-owned Azure/GitHub
identity decision:

1. ~~Prevent omission~~ — done above.
2. **Token lifecycle**: the live credential is a static classic PAT that does not
   self-refresh and can expire/be revoked. Preferred durable fix is a GitHub App
   with short-lived installation tokens.
3. **Automatic Function publishing**: `functions/dev-build-ingest` currently has
   **no** release automation at all — `.github/workflows/deploy.yml` only builds
   the Pages/game bundle and injects `VITE_RUNS_INGEST_URL`; nobody deploys the
   Function or applies its app settings. Preferred: Azure OIDC/federated login,
   no client secret.
4. **Automatic E2E canary**: after deploy and on a schedule, drive a real
   `file_issue:true` call through the live endpoint, verify the resulting GitHub
   issue, auto-close it, and raise a durable, deduplicated alert on failure using
   only `GITHUB_TOKEN` (so a broken `CRAWLER_CI_PAT` can't hide its own alarm).
5. Preserve the parent's existing runtime proof (#4033/#4034, both closed) — no
   new manual test issues during implementation.

### What was built for #3/#4

- **`.github/scripts/dev-ingest-canary/alert-lib.mjs`** (+ `alert-lib.test.mjs`,
  7/7 passing): dedup alert-issue library modeled on
  `ci-recovery/loop-incident-lib.mjs`. Files exactly one open alert issue per
  failure class, reopens a previously auto-closed alert instead of duplicating,
  and closes+comments when the canary recovers.
- **`.github/scripts/dev-ingest-canary/run-canary.mjs`** (+
  `run-canary.test.mjs`, 9/9 passing): CLI that POSTs a synthetic, clearly
  labeled `RunBundle` with `file_issue:true` to the live `/runs` endpoint,
  verifies the returned issue URL, labels + closes that issue immediately
  (no permanent noise), and calls into `alert-lib` on success (clear any open
  alert) or failure (file/reopen one, but only when the failure indicates a
  broken credential — see "Independent review findings" below for the
  `credentialSuspected` split). All network I/O is behind injectable
  `requestImpl`/`paginateImpl` params so tests never hit the network.
- **`.github/workflows/dev-ingest-lifecycle.yml`** (new): three jobs, plus a
  workflow-level `concurrency: { group: dev-ingest-lifecycle,
cancel-in-progress: false }` (added after independent review; see
  "Independent review findings" below) so overlapping triggers (a scheduled
  canary landing mid-deploy, or two manual dispatches) can never race the
  alert-dedup logic — GitHub Actions queues them instead of running in
  parallel.
  - `preflight`: skips on `schedule` triggers (a scheduled canary-only run
    never needs OIDC). On other triggers, it **fails the whole run** with an
    `::error::` annotation if the 3 Azure OIDC secrets are missing — this is
    corrected from an earlier draft that soft-warned; a release-triggered
    deployment must not silently omit the Function publish (maintainer
    requirement, see "OIDC setup — corrected subscription" below). The only
    way to skip the deploy without failing is an explicit `workflow_dispatch`
    with `skip_deploy: true`.
  - `deploy`: OIDC `azure/login@v2` (no client secret), `az deployment group
create` passing `githubCiPat=${{ secrets.CRAWLER_CI_PAT }}` (that secret
    already exists in the repo), builds the Function
    (`npm ci && npm run build && npm prune --omit=dev`) and zip-deploys via
    `az functionapp deployment source config-zip`.
  - `canary`: runs unconditionally (`if: always()`) on the `17 */6 * * *`
    schedule, `workflow_dispatch`, or after `deploy`/`preflight` in any
    outcome (success, skip, or failure) — a partial deploy failure is exactly
    the kind of live-credential break the canary exists to catch, so it must
    never be suppressed by an upstream job's outcome. It invokes
    `run-canary.mjs` with only `GITHUB_TOKEN` — it **never** references
    `CRAWLER_CI_PAT`, so a broken Function credential cannot suppress its own
    alert.
  - Top-level `permissions: contents: read`; `id-token: write` scoped only to
    `deploy`; `issues: write` scoped only to `canary`.
- **`tests/unit/dev-ingest-lifecycle-workflow.test.ts`** (new, 9/9 passing):
  parses the workflow YAML and asserts the above contracts deterministically —
  OIDC-only login (no client secret anywhere), `id-token: write` isolated to
  `deploy`, a schedule trigger exists, `githubCiPat` is sourced from
  `secrets.CRAWLER_CI_PAT`, the `canary` job's YAML block never contains a
  `secrets.CRAWLER_CI_PAT` reference (comment lines are stripped before the
  substring check), a top-level `concurrency.group` exists with
  `cancel-in-progress` not `true`, every `run:` shell block has balanced
  if/fi/for/done/while/done tokens (prose inside quoted `echo "..."` strings is
  stripped before counting, so human-readable messages can't be miscounted as
  bash keywords), and the release-triggered missing-OIDC-secrets path actually
  `exit 1`s rather than only warning.
- **`infra/README.md`**: replaced the old two-open-gaps `[!WARNING]` block with
  a `[!NOTE]` pointer to two new sections — **"Automated Function deployment
  (OIDC)"** and **"Token lifecycle"** — both since updated (see below) to
  reflect that OIDC setup is complete and live, not a pending human TODO.

### OIDC setup — corrected subscription, completed live

An earlier draft of this handoff incorrectly reported the Azure identity as
**not** having access to the Function's subscription/RG, based on a check
against the wrong (default) subscription. The maintainer corrected this: the
live `crawler-dev-ingest` resource is in the **Visual Studio Enterprise
Subscription** (`308f5463-c4b1-4cfb-94e9-c3e0fd0dc67c`), RG
`crawler-sprites-rg` — the same subscription the parent investigation session
used to fix the live Function App setting. Against the _correct_ subscription,
this session had sufficient rights, and completed the full OIDC chain live:

- **App Registration + service principal**: `crawler-dev-ingest-deploy-oidc`
  (app id `9a4f41bf-6af3-4b29-ac03-c5c93e5b8841`).
- **Federated credential**: `crawler-main-branch`, issuer
  `https://token.actions.githubusercontent.com`, subject
  `repo:nalfeo/Crawler:ref:refs/heads/main` — matches the `deploy` job's
  `push: branches: [main]` trigger exactly; a manual `workflow_dispatch` run
  from a non-`main` branch will correctly fail OIDC token exchange (by
  design — feature branches should not be able to deploy this Function).
- **RBAC role assignment**: `Contributor` scoped to the resource group
  `crawler-sprites-rg` (not subscription-wide). This was tightened once, then
  widened back after checking what the Bicep template actually needs:
  a Function-App-resource-scoped `Website Contributor` (the first attempt)
  is **not** sufficient, because `az deployment group create` itself needs
  `Microsoft.Resources/deployments/*` at the resource-group scope, and the
  same Bicep template also manages a sibling `Microsoft.Web/serverfarms` plan
  and a `Microsoft.Storage/storageAccounts/blobServices/containers`
  sub-resource + `listKeys` on the storage account — both are different
  resources outside a Function-App-scoped assignment's reach regardless of
  which role is used. `crawler-sprites-rg` contains exactly the three
  resources this pipeline manages (`crawlersprites` storage,
  `crawler-dev-ingest-plan`, `crawler-dev-ingest`), so RG-scoped `Contributor`
  is the least-privilege option that is technically sufficient, not
  subscription-wide `Contributor`. A stronger follow-up would be a custom
  role combining exactly `Microsoft.Resources/deployments/*` +
  `Microsoft.Web/serverFarms/*` + `Microsoft.Web/sites/*` +
  `Microsoft.Storage/storageAccounts/*` scoped to the RG — not done here to
  keep this session's Azure surface area change minimal and reviewable.
- **GitHub Actions secrets**: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
  `AZURE_SUBSCRIPTION_ID` are all set on `nalfeo/Crawler` (values not
  reproduced here — see repo secrets; the client ID alone is not a bearer
  credential, per `infra/README.md`).

`infra/README.md` → "Automated Function deployment (OIDC)" is updated to
state this is **done and live**, with the setup commands kept for
reproducibility (recreating the App Registration, or repeating this for a
different subscription) rather than as an outstanding TODO.

**Not yet independently verified**: an actual push-triggered `deploy` job run
against this live OIDC configuration (the correction above happened after the
workflow was authored; the next push to `main` touching
`infra/dev-build-ingest.bicep` or `functions/dev-build-ingest/**` will be the
first real end-to-end exercise of the `deploy` job with live credentials). If
the RG-scoped `Contributor` role turns out to still be insufficient for any
step, the `deploy` job will fail loudly with the real Azure error rather than
silently — there is no soft-degradation path for a release-triggered run.

## Independent review findings (addressed)

Two independent post-diff code reviews were run per the apple-scaled review
policy (5🍎 → two reviews). All findings were addressed before publishing.
See the PR review threads on nalfeo/Crawler#4042 for the full finding-by-finding
record; the native PR review is the authoritative audit trail.

## Validation

- `npm run verify:fast` — **green** (typecheck, lint, changed-test suite: 28/28
  across `dev-build-ingest-bicep.test.ts`, `dev-build-ingest-handler.test.ts`,
  `dev-ingest-lifecycle-workflow.test.ts`; all data-contract/integrity/coverage
  checks pass).
- `npm run test:guards` — 2849+ tests across 10 suites; 2724 pass, 11 fail. All
  17 `dev-ingest-canary/*.test.mjs` tests pass (confirmed in isolation:
  `node --test .github/scripts/dev-ingest-canary/*.test.mjs` → 17/17, after
  adding the owner/repo-mismatch regression test in the second review round).
  The 11
  failures are entirely in `ci-conflict-coordinator/reconcile.test.mjs` (9
  failures, `ECONNRESET`/`fetch failed` — a Windows-local network-flakiness
  issue unrelated to any file this PR touches) and
  `ci-recovery/reconcile.test.mjs` (2 failures, `UV_HANDLE_CLOSING` —
  documented Windows libuv async-handle teardown flakiness, also unrelated).
  Neither suite is touched by this PR's diff.
- `npm run verify:pr-prereqs` — **green**
  ("✅ PR prerequisites are satisfied (except final PR-title validation).").

## Non-goals honored

No token was placed in source or the browser bundle. No additional manual
GitHub test issues were created (the canary creates and immediately closes a
clearly labeled synthetic issue only when actually invoked in CI — it was not
run against the live endpoint from this session). The anonymous endpoint and
rate limiter were not touched. `#4033`/`#4034` were left exactly as the parent
closed them.

## Follow-ups (not done here, tracked for a human/future session)

- **Watch the first real push-triggered `deploy` run.** OIDC setup (App
  Registration, federated credential, RG-scoped `Contributor`, 3 GitHub
  secrets) is now live/complete — see "OIDC setup — corrected subscription,
  completed live" above — but no real `az deployment group create` /
  `az functionapp deployment source config-zip` has been exercised through
  the actual `deploy` job yet. The first push to `main` touching
  `infra/dev-build-ingest.bicep` or `functions/dev-build-ingest/**` after
  this PR merges is the first live proof. If the RG-scoped `Contributor`
  role is somehow still insufficient for a specific step, the job fails
  loudly with the real Azure error (no soft-degradation path exists for a
  release-triggered run) — the fix at that point is reading the exact
  `az` error and widening only the specific missing action.
- Watch the first scheduled `canary` run (`17 */6 * * *`) and confirm it
  auto-closes its synthetic issue and reports no alert.
- Decide on and execute the GitHub App migration for `CRAWLER_CI_PAT` (App
  creation is a human/org decision — not started here; the static PAT
  works today and the canary mitigates silent expiry, but it does not
  self-refresh). `infra/README.md` → "Token lifecycle" documents the exact
  human inputs needed (App ID, private key, installation ID) if/when this
  is pursued.
- Consider a tighter custom RBAC role (exactly
  `Microsoft.Resources/deployments/*` + `Microsoft.Web/serverFarms/*` +
  `Microsoft.Web/sites/*` + `Microsoft.Storage/storageAccounts/*` scoped to
  `crawler-sprites-rg`) instead of built-in RG-scoped `Contributor`, if a
  future security review wants to shrink the blast radius further.
