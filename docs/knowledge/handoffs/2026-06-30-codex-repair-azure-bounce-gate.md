# Session Handoff: Codex-repair pipeline — Azure OpenAI provider, gpt-5.3-codex upgrade & cost-cap bounce gate

## Date

2026-06-30

## Persona(s) adopted

**Producer** (default for multi-layer / ambiguous work). The change spans CI
orchestration (workflow YAML), provider shell scripts, Node ESM action scripts,
and docs — no single specialist owns it, so Producer coordinated the provider
work, the cost-gate work, and the review harness.

## Routing verdict

✅ right persona — the task crossed workflow + scripts + docs with no game
`src/**` surface, exactly the cross-cutting shape Producer exists for.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — a full pipeline feature (new provider + model upgrade + a new
pre-flight cost gate) across ~14 CI files, sized as predicted; no architectural
ADR was needed and no game systems were touched.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

azure-infra

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-06-30-azure-openai-provider.review-ledger.json`
Tier: 3🍎 → stages required: `plan_review` ✅ · `code_review` ✅ (loop)
Stages run:

- **plan_review** — gpt-5.4 (rubber-duck), `approved_with_changes`, 4 concerns
  (1 blocking secret-scope/eligibility, 2 non-blocking parity/`set -e`, 1
  router kill-switch) all adopted.
- **code_review** — 3 rounds, claude-sonnet-4.6:
  - r1: 3 concerns (single-page check-runs → `maxFailingChecks` bypassable;
    bounce.mjs re-evaluated complexity → table/reason mismatch; `upsertComment`
    scanned only first 100 comments) → fixed in `65aca40`.
  - r2: 1 concern (status-comment + `fetchCodexStatusState` single-page → auto-
    repair attempt limiter bypassable on >100-comment PRs) → fixed in `e18d067`.
  - r3: clean, no concerns.

`npm run review:ledger -- validate <path>` → **pass (exit 0)**, "valid 3-apple
ledger".

## What Was Done

Three bundled features on this branch, plus review-harness hardening:

1. **Azure OpenAI provider** (`azure`) for the codex-repair pipeline. Drives the
   already-installed Codex CLI against Azure OpenAI via Codex's custom
   model-provider mechanism (Responses API, `api-key` header). New
   `.github/scripts/codex/providers/azure.sh`; dispatch case in
   `run-provider.sh`; local auth gate in `scripts/codex-repair-local.sh`;
   secrets/vars + conditional CLI install in `codex-repair-runner.yml`.
2. **Model upgrade** to `gpt-5.3-codex` (Azure deployment) as the repair model.
3. **Cost/complexity "bounce" gate** — before the expensive agentic loop runs,
   `event-parse.mjs` measures the PR (changed files / diff lines / failing
   checks) against budgets (>20 files OR >1500 lines OR >6 failing checks →
   bounce). On bounce, `bounce.mjs` posts a sticky comment + `auto-heal-bounced`
   label and optionally assigns Copilot (PAT-only). Spends ~0 model tokens on
   oversized repairs.
4. **Pagination / limiter hardening** (from the code-review loop): added a
   `githubPaginate` Link-header helper in `utils.mjs`; paginated check-runs and
   comment lookups in `event-parse.mjs`, `bounce.mjs`, and `report.mjs`; threaded
   event-parse's measured metrics/budgets into `bounce.mjs` via step env so the
   comment table can never contradict the bounce reason. New
   `tests/pagination.test.mjs` (6 cases). 200 guard tests pass.

## What's Next

- **Manual smoke** of the Runner against this PR once open:
  `gh workflow run codex-repair-runner.yml --repo nalfeo/Crawler --ref nalfeo-legendary-fiesta -f pr_number=<n> -f trigger=workflow_dispatch -f mode=auto -f explicit=false`
  (bounce runs finish green in ~10–20s).
- If the user ever wants **true auto-assign** of Copilot on bounce, create a user
  PAT secret `CODEX_ASSIGN_TOKEN` (Actions/App tokens are rejected by GitHub for
  agent assignment — see Key Decisions). Currently the accepted posture is
  comment + label + **manual** assign (no PAT).
- The Router (auto-trigger) stays **disabled** and gated behind
  `vars.CODEX_ROUTER_ENABLED == 'true'`; only the manual Runner is on.

## Blockers

None blocking the PR. Open follow-ups are optional (PAT for auto-assign; manual
smoke after open).

## Branch State

- Branch: `nalfeo-legendary-fiesta`
- All tests passing: yes — `npm run verify` green on the provider state; 200
  guard tests pass after the pagination work (`.github/scripts/codex/**` is not
  covered by the main `verify` lint/test, so guard tests are the gate there).
- PR created: yes (see below)

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

> Note: the counts below are dominated by **guard test-suite fixtures**
> (synthetic guard names like `boom`, `ctx-a`, `pr-hard`, `edit-bad`) emitted by
> repeated `npm run test:guards` runs this session, not real tool-call decisions.
> The meaningful real entries are `pr-review-ledger: allow` and
> `pr-preflight: allow`.

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 152,
  "guards": {
    "boom": { "crash": 20 },
    "ctx": { "allow": 10 },
    "ctx-a": { "allow": 10 },
    "ctx-b": { "allow": 10 },
    "edit-bad": { "bypass": 10 },
    "edit-guard-self-protection": { "ask": 20 },
    "pr-a": { "deny": 10 },
    "pr-b": { "deny": 10 },
    "pr-hard": { "deny": 10 },
    "pr-preflight": { "allow": 1 },
    "pr-review-ledger": { "allow": 1 },
    "pr-warn": { "allow": 10 },
    "shell-a": { "deny": 10 },
    "shell-bad": { "deny": 20 }
  },
  "tools": { "create_pull_request": 42, "edit": 60, "powershell": 50 }
}
```

## Test Results

- `npm run test:guards` → 200 guard tests pass (incl. new
  `pagination.test.mjs`, existing `complexity.test.mjs`).
- `npm run verify` → green (exit 0) on the provider commit (`56d782d`);
  subsequent commits are `.github/**`-only, which `verify` does not lint/test.
- `node --check` clean on all touched `.mjs`; prettier clean on md/yml/json.
- `npm run review:ledger -- validate …` → exit 0.

## Key Decisions Made

- **GitHub rejects Copilot/agent assignment from BOTH the Actions
  `GITHUB_TOKEN` AND GitHub App installation tokens** (`FORBIDDEN: "Assigning
agents is not supported with GitHub App installation tokens. Use a user token
instead"`). A **user PAT** (`CODEX_ASSIGN_TOKEN`) is mandatory for auto-assign;
  PR assignment additionally requires GraphQL `replaceActorsForAssignable` (REST
  `addAssignees` 201s but silently drops Copilot on PRs). The comment + label
  path needs no token. → We ship PAT-only auto-assign with a clean early-return
  when no PAT is present (user accepted manual-assign as the default posture).
- **Bounce metrics are measured once** in `event-parse.mjs` and rendered by
  `bounce.mjs` purely from step env — no second fetch/eval — so the "measured vs
  budget" table can never disagree with the bounce reason.
- **`gather-context.mjs` per_page caps are intentionally left un-paginated** —
  they bound prompt tokens; paginating them would _raise_ cost (counter to this
  PR's goal). Only the _gating_ fetches (check-runs, status/marker comments) were
  paginated.
- **Router stays disabled in code**, not just the UI: `route` job gated on
  `vars.CODEX_ROUTER_ENABLED == 'true'` (default off). Re-enabling the workflow in
  the UI alone won't start auto-repair.
- Whole branch declared **3🍎** → 2–3🍎 tier (plan_review + looped code_review);
  no dual-plan synthesis / multi-model review required.

## Retrospective

### Lessons Learned

- For CI-automation work under `.github/scripts/**`, `npm run verify` is **not**
  the gate — CI lint/format/test only cover `src/**` and `tests/scripts/**`. Use
  `npm run test:guards` (`node --test .github/scripts/codex/tests/*.test.mjs`) as
  the real signal, and `node --check` + prettier for the rest.
- The "right" fix for a cost-reduction PR sometimes means **not** paginating:
  prompt-context fetches are deliberately capped to bound tokens. Distinguish
  _gating_ reads (must be complete/correct) from _prompt_ reads (bounded on
  purpose) before reflexively paginating everything a review flags.
- Agent assignment on PRs is GraphQL-only and PAT-only; this cost two earlier
  dead-end detours (App token, then REST) before landing on the verified path.

### Mistakes Made

- Pursued an **App-token-assigns-Copilot** detour (`78ced5d4` → `d5019972`)
  before discovering App installation tokens are also forbidden for agent
  assignment — had to revert to PAT-only (`56d782d`). Early signal missed: the
  first `FORBIDDEN` error already said "Use a user token instead"; I should have
  taken "user token" literally (PAT) instead of trying another non-user token.
- The first code-review round only happened _after_ I'd assembled the branch;
  three real pagination/limiter bugs slipped through initial authoring. Running
  the code-review loop earlier (per-feature) would have caught them with less
  churn.

### Opportunities for Future Improvement

- Add `.github/scripts/codex/**` to a lightweight lint/format CI job so ESM
  `process`/`fetch` `no-undef` and prettier drift are caught in CI, not just
  locally via guard tests.
- Consider a tiny integration smoke that drives `event-parse.mjs` → `bounce.mjs`
  end-to-end with a fixture PR payload, so the metric-threading contract is
  regression-tested (today only `githubPaginate` and the budget math are unit-
  tested).
- The guard-telemetry artifact is polluted by test-suite fixtures; a future
  session could teach `test:guards` to write to a separate telemetry sink so the
  handoff summary reflects only real tool decisions.
