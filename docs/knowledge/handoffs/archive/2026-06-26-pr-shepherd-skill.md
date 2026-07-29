# Session Handoff: Add pr-shepherd PR shepherding skill

## Date

2026-06-26

## Persona(s) adopted

**Producer** — the task is meta/process tooling (codifying a cross-cutting agent
workflow), which is the Producer's remit for multi-layer or ambiguous work.

## Routing verdict

✅ right persona — capturing an orchestration playbook as a reusable skill is
exactly Producer-shaped work; no specialist routing was needed.

## Apples

Estimated: 🍎 x 1 <!-- declared before work began -->
Actual: 🍎 x 1 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — a single self-contained docs/skill addition with no code
surface; the only friction was discovering the CLI's skill-discovery path.

Hello kitties: 1/5 = 0.20 🎀

## Systems touched

ci-policy

## What Was Done

Added a discoverable **project skill** that codifies the PR shepherding loop:

- `.github/skills/pr-shepherd/SKILL.md` — frontmatter (`name`, `description`) +
  concise playbook: Coordinator vs single-PR Shepherd modes, authoritative
  Crawler merge facts (required checks `ci` + `commit-lint`,
  `required_conversation_resolution`, no required human review,
  `gh pr merge --auto --squash`), scope/worktree decision matrix, and a
  "diagnose before giving up" section.
- `.github/skills/pr-shepherd/references/playbook.md` — command cookbook:
  discovery commands, `open_pr_session` parameters, the `pr_shepherds` SQL
  tracker, cross-session delegation/reporting, the `CANCELLED`-mislabel
  diagnosis recipe, GraphQL-on-PowerShell quoting workaround, byte-faithful
  Contents API edits for locked worktrees, and stacked-PR head-ref restore.

The CLI discovers project skills from `.github/skills/<name>/SKILL.md` (verified
against the bundled SDK loader, which scans `.github/skills`, `.agents/skills`,
`.claude/skills`), so the skill is invokable as `pr-shepherd` and auto-suggested
on requests to "shepherd" a PR.

## What's Next

- The skill ships via this PR; once merged it is available to new sessions
  (project skills are picked up at session config-discovery time).
- Optional future polish: a sibling `.agents/skills` symlink/copy if non-Copilot
  agents should also surface it; not needed for the Copilot CLI.

## Blockers

None. One process note: the `pr-preflight` guard initially denied
`create_pull_request` because a `.github/**` diff is classified as config (not
docs-only), so a handoff is required — this file satisfies it.

## Branch State

- Branch: `nalfeo-crispy-dollop`
- All tests passing: yes (`npm run verify:fast` green)
- PR created: yes (this change)

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 1,
  "guards": {
    "pr-preflight": {
      "deny": 1
    }
  },
  "tools": {
    "create_pull_request": 1
  }
}
```

The single deny is the `pr-preflight` handoff gate described under Blockers;
adding this handoff resolves it.

## Test Results

`npm run verify:fast` → ✅ Fast verification passed (typecheck + lint + unit
tests). Change is markdown-only and outside all TS/lint/test globs. Both skill
files also pass `npx prettier --check`.

## Key Decisions Made

- **Location:** project scope at `.github/skills/` (version-controlled, shared
  across all agents/sessions, consistent with the repo's `.github/` conventions)
  rather than a user-level `~/.copilot` skill, because the playbook is
  Crawler-specific (merge policy, required checks, the `rebase-prs` bot).
- **Structure:** a concise `SKILL.md` (kept well under the skill char budget)
  that points to a `references/playbook.md` for the verbose command recipes,
  matching the builtin-skill layout convention.
- **No `allowed-tools` frontmatter:** the coordinator mode needs the full tool
  set (`open_pr_session`, `send_session_message`, `sql`, `gh`), so the skill
  inherits all tools rather than restricting them.
