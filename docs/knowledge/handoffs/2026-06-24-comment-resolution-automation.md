# Handoff — Comment Resolution Automation

**Date:** 2026-06-24
**Session:** comment-resolution-automation
**Persona:** DevOps Engineer (CI/automation, `.github/workflows/**`)
**Apple estimate:** 🍎🍎 → actual 🍎🍎 (exact)

## Summary

Made agents/automation reliably close review threads that are addressed, and
extended the same contract to threads declined as incorrect/irrelevant — always
with a documented reason. The behavior is enforced by a deterministic workflow
(no LLM-as-judge), with supporting instructions so agents produce the required
signal.

## What was done

- **New policy** `docs/agent-os/policies/comment-resolution-policy.md` — the agent
  contract: never resolve a thread without a reply; use `Addressed in <sha>` when
  fixed or `Resolving: <reason>` when declining. No token ⇒ thread stays open.
- **New workflow** `.github/workflows/resolve-addressed-threads.yml` — the
  enforcement mechanism. `github-script` + GraphQL, modeled on
  `pr-ready-reviewer-guard.yml`. Triggers: `pull_request_target` (synchronize/
  opened/reopened), hourly `schedule`, `workflow_dispatch`. Resolves a review
  thread via `resolveReviewThread` **only** when its most recent comment carries a
  disposition token. Idempotent (skips already-resolved threads), paginates
  threads, and warns-but-continues on per-thread/PR errors. Permissions:
  `pull-requests: write`.
- **Instruction updates** so agents emit the token:
  - `AGENTS.md` Rules → rule 10.
  - `.github/copilot-instructions.md` Critical Rules → new bullet.
  - `docs/agent-os/personas/reviewer.md` Tools & Workflows → references the new
    workflow and policy.

## Files touched

- `docs/agent-os/policies/comment-resolution-policy.md` (new)
- `.github/workflows/resolve-addressed-threads.yml` (new)
- `AGENTS.md`
- `.github/copilot-instructions.md`
- `docs/agent-os/personas/reviewer.md`
- `docs/knowledge/metrics/apples/2026-06-24-comment-resolution-automation.json` (new)

## Verification

- `prettier --check` on all changed files — clean.
- `scripts/agent/docs/check-paths.ts` — 0 findings.
- `scripts/agent/docs/check-personas.ts` — 0 findings.
- ESLint/format:check gates only cover `src/**`,`tests/**`,`scripts/**` (.ts), so
  the docs/yaml changes are out of their scope; prettier was run on them directly.

## Design notes

- Resolution is **GraphQL-only** (no REST endpoint); threads ≠ comments.
- Agents do **not** call `resolveReviewThread` directly — they post the token
  reply and the workflow closes the thread. This structurally forces a reason.
- `GITHUB_TOKEN` resolves threads as `github-actions[bot]`; swap for a PAT/app
  token if attribution to a person/app is needed later.

## Unresolved / next steps

- Optional (not implemented, deemed redundant): a `copilot-guards` guard blocking
  a direct `resolveReviewThread` call without a prior token reply. Only worth
  adding if agents ever bypass the workflow and resolve threads inline.
- Consider widening `format:check`/lint to cover `docs/**` and
  `.github/workflows/**` so markdown/yaml are gated mechanically too.
