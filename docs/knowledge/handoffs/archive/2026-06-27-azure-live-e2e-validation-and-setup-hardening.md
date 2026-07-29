# Handoff — 2026-06-27 azure-live-e2e-validation + setup-script hardening

## Date

2026-06-27

## Persona(s) adopted

**Producer** — coordinated the close-out of the PR2 7-stage epic: ran the
live-Azure E2E validation that PR2c documented as "not runnable", then hardened
the Azure provisioning scripts so they never needlessly recreate resources and
never destroy the persistent environment without an explicit opt-in. Infra +
docs only; no game-runtime or ECS code.

## Routing verdict

✅ right persona — this was an operate-the-real-backend validation pass plus a
self-contained infra-script change with a pure-function unit test. No specialist
hand-off needed.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began: small infra-script change + documented live run -->
Actual: 🍎 x 2
Verdict: 🎯 Exact — the live validation exercised already-merged endpoints (no
code), and the hardening was one rewritten provisioning script + a passthrough +
a dependency-free pwsh test + docs. No new subsystem, no ADR.

Hello kitties: 2/5 = 0.40 🎀

## Systems touched

azure-infra

## What Was Done

Two deliverables, both closing the loop on the PR2 epic and the user's
Azure-setup follow-up.

### 1. Live-Azure E2E validation (DoD evidence for the 7-stage flow)

PR2a→PR2c repeatedly skipped the live-Azure flow with a stale "no creds" claim.
After the user logged in (`az` authenticated; `npm run setup:azure` succeeded and
wrote `.env.local` with the OpenAI + Storage creds), the sidecar was started
against the **real Azure backends** (`store=azure-blob`, `queue=azure-queue`,
worker auto-started) on `127.0.0.1:8200` and every DoD item was exercised against
live endpoints. All six passed:

| #   | DoD item                                        | Evidence (live endpoint response)                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Generate produces a sheet                       | `POST /api/workflow/generate` for the healing-potion brief → HTTP 202 queued → worker `processed=1` → **new run with `candidateCount=0`** (Option B: raw sheet only). PostProcessing that fresh sheet → 16 candidates.                                                                                                                             |
| 2   | Re-run PostProcess on a stored sheet (no regen) | `POST /api/runs/:b/:r/postprocess` → HTTP 200 (~25s), re-sliced `sheet-00.png`, 16 candidates persisted to Azure. The sheet was **not** regenerated. After default postprocess only variant 12 still fails `opaque-bbox-fits` (15 fixed).                                                                                                          |
| 3   | Sensor gate skips a failing variant             | Non-forced `POST …/judge {variantIndexes:[12]}` → `judgeSkipReason: "sensor-failed"`, `judgeScorecard: null` — **no LLM call** for the gated variant.                                                                                                                                                                                              |
| 4   | Per-variant structured sensor detail            | Each candidate carries `breakdown: SensorResult[]` (`{ok, sensor, reason?, pixels?}`); variant 12 reported `opaque-bbox-fits` failing with reason "silhouette touches frame edge".                                                                                                                                                                 |
| 5   | Force-judge past a failing sensor               | `POST …/judge {force:true, variantIndexes:[12]}` → HTTP 200 (~20s), real `gpt-4o` VLM call: `judgeScorecard` populated (`modelDeployment: gpt-4o`, real rationales, `usage` ≈ 2491 tokens, `rejectedBy: ["style_match"]`); the sensor **still honestly fails** (`combinedPassed: false`). The force flag overrides the gate, not the sensor truth. |
| 6   | Resume-after-refresh persists                   | `GET /api/workflow/state` → durable queue (11 items, `selectedId` item-12, `nextSeq` 14, real ETag). ETag concurrency proven: stale `If-Match` → **409**; correct `If-Match` → **200** idempotent; queue intact.                                                                                                                                   |

Total paid Azure cost: ~1 `gpt-image-1` generation (attempts:1) + 1 small `gpt-4o`
VLM call. The real queue state was **preserved** (non-destructive validation).

This supersedes the PR2c handoff's "live-Azure NOT runnable" constraint — the
7-stage flow (Synthesize → Choose → Generate → PostProcess → Judge → Approve →
Tag) is now validated end-to-end against live Azure.

### 2. Azure setup-script hardening (idempotent + guarded recreate)

The user asked that `setup:azure` not needlessly recreate resources, and that the
**persistent** environment they interact with never be blown away without asking.

- **`scripts/setup-azure-resources.ps1`** — rewritten:
  - **Idempotent by default.** The previous version deployed the storage Bicep
    template **unconditionally** on every run; now `Ensure-StorageAccount` only
    deploys when the account is missing (or `-Force` is passed for a non-destructive
    ARM redeploy). Resource groups + the OpenAI account remain create-if-missing.
  - **Opt-in `-Recreate`** deletes + re-creates the _stateful_ resources (storage
    account, model deployments) for a clean dev/test slate.
  - **Persistent-resource protection.** `-Recreate` **refuses** to delete any
    resource in `-PersistentResourceNames` (default: `crawlersprites`,
    `aoai-crawler-nalfeo`, and their RGs) unless `-AllowRecreatePersistent` is also
    passed. Deleting the storage account would destroy every stored run + the
    durable workflow-state queue, so the persistent version is never destroyed
    silently.
  - **Pure, testable decision core:** `Resolve-ResourceAction` (→
    `create`/`skip`/`recreate`/`blocked`), `Test-IsPersistentResource`,
    `Assert-NotBlocked`. The provisioning body is wrapped in `Invoke-Provisioning`
    behind a dot-source guard (`if ($MyInvocation.InvocationName -ne '.')`) so the
    pure functions can be loaded for tests without any `az` calls.
- **`scripts/setup-azure-env.ps1`** — threads `-Recreate`,
  `-AllowRecreatePersistent`, and `-ForceProvision` (named to avoid colliding with
  its existing `-Force`, which controls overwriting `.env.local`) through to the
  resource script.
- **`scripts/setup-azure-resources.tests.ps1`** — new dependency-free pwsh test
  (no Pester, no Azure) covering every branch of the three pure functions. 15/15
  assertions pass via `pwsh -NoProfile -File`.
- **`infra/README.md`** — new "Idempotency & re-creating resources" section
  documenting the default no-op behavior, `-Recreate`, the persistent guard, and
  `-Force`/`-ForceProvision`.

## Verification

- `pwsh -NoProfile -File scripts/setup-azure-resources.tests.ps1` → **15/15 pass**.
- All three pwsh scripts parse cleanly via
  `[System.Management.Automation.Language.Parser]::ParseFile`.
- `npm run verify:fast` → green (tsc + eslint over `src/ tests/ scripts/` pass;
  `vitest --changed` finds no affected TS tests because the change is `.ps1`/`.md`
  only → `--passWithNoTests`).
- `bash scripts/agent/lab-gate-check.sh` → pass.

## Carry-forwards / Notes for the next session

- **Pre-existing lockfile drift (flag, do not bundle):** `package-lock.json` on
  `main` lists `canvas@^3.2.3` as a **direct** dependency in the root package
  entry, but `package.json` does **not** declare `canvas`. A local `npm install`
  "corrects" the lockfile by removing it (408-line delete). I reverted that churn
  so this PR stays infra-only; the drift deserves its own focused fix/PR.
- **Shared-queue poison message (flag, do NOT purge):** the live `asset-requests`
  queue has a stale `rat-slime-v1` message pointing at a non-existent
  `briefs/draft/enemys/rat-slime.yaml`; the worker fails it fast and returns it to
  the queue (failed count climbs), but it does **not** block new messages. Because
  the queue may be shared across sessions, it was left in place per the user's
  "don't blow away the persistent env without asking" guidance.
- The destructive `-Recreate` az-delete paths cannot be exercised live (they would
  delete the user's persistent env); only the pure decision function is unit-tested.

## Apple metric file

`docs/knowledge/metrics/apples/2026-06-27-azure-live-e2e-and-setup-hardening.json`
