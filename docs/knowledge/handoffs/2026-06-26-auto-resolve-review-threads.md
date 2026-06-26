# Handoff: Auto-resolve addressed review threads

**Date:** 2026-06-26
**Branch:** nalfeo-auto-resolve-review-threads
**Persona:** DevOps Engineer (CI/workflow automation)

## Apples

- Estimated: 🍎🍎 (Small)
- Actual: 🍎🍎 (Small)
- Delta: 0
- Verdict: 🎯 Exact
- Hello kitties: 2/5 = 0.40 🎀

## Goal

Investigate, then implement, a way to **automatically resolve PR review-comment
threads once addressed** with two hard constraints: **no PATs** and **nothing
that runs as the human owner**. The driver is the branch-protection "Require
conversation resolution before merging" gate (see ADR 0014) — Copilot code-review
threads otherwise have to be resolved by hand before `gh pr merge --auto` clears.

## Investigation findings

- The only API that resolves a thread is the GraphQL `resolveReviewThread`
  mutation (no REST equivalent).
- **Default `GITHUB_TOKEN` is not reliable** for this: resolving a thread authored
  by another app (Copilot) returns `Resource not accessible by integration`. Same
  second-class-identity problem we already hit with `@copilot` issue assignment.
- **A GitHub App installation token with `pull_requests: write` works** and is a
  bot identity — not a PAT, not a human. The repo already has this App wired up
  (`secrets.APP_ID` / `APP_PRIVATE_KEY` via `actions/create-github-app-token@v1`,
  used by auto-rebase / coverage-gap / nightly-mutation).
- There is **no native "addressed" signal**. `isOutdated` means the commented
  code changed (good proxy, not proof); `isResolved` is the end state we set.
  Copilot code review does **not** auto-resolve its own threads on push.
- An LLM judge was considered and **rejected for CI**: it violates the
  "Deterministic CI only — no LLM-as-judge in CI" rule, adds non-determinism, and
  creates a prompt-injection surface on a merge gate. (Cost in $ is trivial; the
  cost is governance/security.) Instead the judgment lives at fix-time: whoever
  fixes the comment emits a marker.

## What was implemented

- **`.github/workflows/auto-resolve-review-threads.yml`** — runs as the GitHub
  App bot and resolves a thread when an **authorized** actor (PR
  owner/member/collaborator, or a trusted bot like the Copilot coding agent)
  leaves a reply matching the **`✅ Addressed`** marker. The code does **not**
  need to be outdated — a comment can be addressed without a change (e.g. the
  agent explains in-thread why none is needed).
  - Triggers: `pull_request: synchronize`, `pull_request_review_comment`,
    hourly `schedule`, and `workflow_dispatch` (optional `pr_number` to scope).
  - Tunable via env: `REQUIRE_OUTDATED` (default `false` — opt in to also require
    the thread to be outdated), `ADDRESSED_MARKER` regex, `MARKER_BOTS` allowlist.
    Token step is guarded so fork-PR events (no secrets) skip gracefully; resolve
    failures are best-effort warnings.
- **`AGENTS.md`** + **`.github/copilot-instructions.md`** — added a short
  "Resolving addressed review comments" note so agents/humans know to reply
  `✅ Addressed in <sha>: <note>` in-thread (otherwise nothing gets resolved).

## Validation

- Embedded github-script body: `node --check` → syntax OK.
- Workflow YAML: parsed with js-yaml → structure OK (triggers, steps, `uses`,
  script body all present).
- No code (`src/`/`tests/`/`scripts/`) touched, so typecheck/lint/tests are
  unaffected; `format:check` only globs TS, and there is no action/yaml lint gate.

## ⚠️ Prerequisite to confirm before this works

The GitHub App behind `APP_ID`/`APP_PRIVATE_KEY` must have the
**`pull_requests: write`** permission (Repository permissions → Pull requests:
Read & write). Could not be verified from the repo (App config lives in App
settings). If it lacks the scope, `resolveReviewThread` fails (logged as a
warning) and no threads resolve — grant it, then re-run `workflow_dispatch`.

## Follow-ups / options

- If the team later wants threads resolved without any marker, flip
  `REQUIRE_OUTDATED` reasoning to marker-only or outdated-only (single env edit).
- A standalone LLM "addressed" judge remains possible but would need an ADR + a
  carve-out from the no-LLM-in-CI rule.
