# Session Handoff: Azure OpenAI provider for codex-repair + manual CI

## Date

2026-06-29

## Persona(s) adopted

DevOps / CI engineer (Producer-style for a multi-file infra+docs change). The work
is pipeline plumbing (provider abstraction + GitHub Actions wiring + secrets), so the
emphasis was on safe credential handling and least-privilege CI, not game systems.

## Routing verdict

✅ right persona — the change is entirely CI/tooling and provider wiring; no `src/**`
game code involved.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2
Verdict: 🎯 Exact — the provider mirrors the existing `gemini` provider and the
plan-review hardening (secret scoping, eligibility gate, escape-hatch parity, az
error handling, router kill switch) stayed within the 2-apple envelope.

Hello kitties: 2/5 = 0.40 🎀

## Systems touched

azure-infra

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-06-30-azure-openai-provider.review-ledger.json`
Stages (2🍎 tier): plan_review ✅ · code_review ✅

- plan_review: gpt-5.4 (rubber-duck) → approved_with_changes, 4 concerns, all 4 resolved.
- code_review: claude-sonnet-4.6 → round 1 clean (0 concerns).
  `npm run review:ledger -- validate <path>` → ✅ valid 2-apple ledger.

## What Was Done

Added a third provider, **`azure`** (Azure OpenAI), to the codex-repair autonomous
PR-repair pipeline, because the OpenAI key has no credits and Gemini's free tier is
20 req/day. The user's personal Azure account (VS Enterprise, monthly credits) has an
existing Azure OpenAI resource `aoai-crawler-nalfeo` (rg `rg-crawler-sprites`) with a
`gpt-4o` deployment.

Code (branch `nalfeo-legendary-fiesta`, commits `fc2bc227` + `1649934`):

- `.github/scripts/codex/providers/azure.sh` (new) — drives the already-installed
  **Codex CLI** against Azure OpenAI via a custom model provider (Responses API).
  `env_key` auth (no `codex login`). `CODEX_MODEL` = Azure **deployment** name
  (default `gpt-4o`). Endpoint required; api-version default `2025-04-01-preview`.
  Keyless local runs supported via `az` key-fetch when
  `AZURE_OPENAI_RESOURCE`/`AZURE_OPENAI_RESOURCE_GROUP` are set under `az login`.
- `.github/scripts/codex/run-provider.sh` — `azure)` dispatch case.
- `scripts/codex-repair-local.sh` — `azure` auth pre-flight gate.
- `.github/workflows/codex-repair-runner.yml` — azure env; install Codex CLI for
  `azure` too; **model-provider secrets moved to step scope** (provider step only);
  **"Enforce repair eligibility" gate** fails fast on ineligible `workflow_dispatch`
  (fork/draft/codex-authored/limit) before checkout/install/provider.
- `.github/workflows/codex-repair.yml` — `route` job gated on
  `vars.CODEX_ROUTER_ENABLED == 'true'` (auto-trigger disabled in-repo by default).
- `docs/codex-repair.md` — documented the provider, secrets/vars, keyless path,
  the router kill switch, and the hardened security model.

GitHub config applied (repo `nalfeo/Crawler`):

- Secret `AZURE_OPENAI_API_KEY` (set). Vars `AZURE_OPENAI_ENDPOINT`,
  `CODEX_PROVIDER=azure`, `CODEX_MODEL=gpt-4o`.
- **Runner** (`303747196`, `workflow_dispatch`-only) = **active** (manual testing).
- **Router** (`303704008`, auto-trigger) = **disabled_manually** AND now in-repo
  gated off (belt-and-suspenders).

Proven end-to-end before this session's hardening: Azure Responses API (`AZURE_OK`),
Codex CLI w/ azure overrides (`CODEX_AZURE_OK`), full dispatcher
(`PIPELINE_AZURE_OK`).

## What's Next

- **Open the PR** for this branch (this handoff + valid ledger unblock the guards),
  synthesize a holistic title/description, then `gh pr merge --auto --squash`.
- **After merge to main**: manual CI smoke test —
  `gh workflow run codex-repair-runner.yml --repo nalfeo/Crawler -f pr_number=<N> -f mode=manual`
  against an eligible same-repo, non-draft PR; confirm the azure provider
  authenticates and runs against `gpt-4o`. Watch with `gh run watch`.
- If/when auto-routing is wanted: set repo var `CODEX_ROUTER_ENABLED=true` AND
  `gh workflow enable` the Router.

## Blockers

None blocking the PR. Operational reminder for the user (not code): **rotate the
OpenAI service-account key** that was pasted in chat earlier — treat it as exposed.

## Branch State

- Branch: `nalfeo-legendary-fiesta` (pushed; upstream `origin/nalfeo-legendary-fiesta`)
- All tests passing: n/a locally — `node_modules` is not installed in this worktree,
  so `typecheck`/`lint`/unit could not run here. The diff touches **no** `src/**` or
  any TS/JS, so those gates are unaffected; CI runs the full `verify` on the PR. The
  checks that matter for this diff all passed locally (see Test Results).
- PR created: pending (next action this session)

## Agent-OS Telemetry

<!-- See Test Results — no files/guard-telemetry.jsonl present this session. -->

## Test Results

- `npx prettier --check` on the two workflows + `docs/codex-repair.md` → all clean.
- `npx prettier --check`/`--write` on the handoff + apple metric + ledger → clean.
- `bash -n .github/scripts/codex/providers/azure.sh` → syntax OK.
- `npm run review:ledger -- validate …` → valid 2-apple ledger.
- `npm run verify:fast` / `npm run typecheck` could NOT run locally — `node_modules`
  absent in this worktree (`tsc not recognized`). Not run rather than falsely green.
  No TS/`src` changed, so the typecheck/lint/unit scope is identical to `main`; CI
  is the authoritative gate for those and runs on the PR.

## Key Decisions Made

- **Reuse the Codex CLI** for Azure (custom model provider) rather than add a new
  CLI dependency — Azure exposes an OpenAI-compatible Responses API.
- **`CODEX_MODEL` = Azure deployment name** for this provider (not a base model id);
  default `gpt-4o` since Azure has no implicit default deployment.
- **Least-privilege CI**: model secrets at step scope, eligibility gate before any
  secret-bearing step, router disabled in-repo by default — so a public repo + a
  billed credential stays safe even if the workflow is re-enabled in the UI.
- **Manual-only posture**: Runner enabled for `workflow_dispatch`; Router stays off.

## Retrospective

### Lessons Learned

- On Windows PowerShell, passing a JSON `--json '{...}'` arg to the ledger CLI must
  use **literal double quotes inside single quotes** and call `node …/cli.mjs`
  directly; `\"`-escaping gets passed through literally and fails JSON.parse.
- The `pr-preflight` handoff guard matches any `YYYY-MM-DD-<slug>.md` (regex), not
  strictly today's date — but keep the date consistent with the local clock.
- The ledger CLI stamps the filename in **UTC** (created `2026-06-30` while the local
  clock read `2026-06-29`); ledger discovery is by `<date>-<slug>` glob so the
  off-by-one date is harmless.
- `event-parse.mjs` computes `should_run` even for `workflow_dispatch`, but the
  Runner never enforced it — adding the explicit gate closes a real
  fork/draft/limit bypass for manual dispatch.

### Mistakes Made

- First pass put Azure auth resolution **before** the `CODEX_EXEC_COMMAND` branch,
  breaking the documented escape hatch (the sibling providers resolve auth inside
  the `else`). Plan review (gpt-5.4) caught it; fixed to match parity. Early signal:
  diffing against `gemini.sh`/`codex.sh` structure would have flagged it sooner.
- First pass injected the new billed secret at **job scope**. Plan review flagged the
  blast radius; moved all three model secrets to the provider step.

### Opportunities for Future Improvement

- No shell linter in CI — a `shellcheck`/`actionlint` gate would have independently
  caught the `set -e` + command-substitution footgun in `azure.sh`.
- Consider promoting the "ineligible dispatch is rejected before secrets" behavior
  into a guard test so it can't silently regress.
- The local auth gate (`codex-repair-local.sh`) is a shallow pre-flight; a future
  pass could verify `az account show` for a crisper local error.
