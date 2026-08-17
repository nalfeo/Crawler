---
name: session-kickoff-closeout
description: >-
  Run Crawler's session start and finish ceremony without losing the hard parts.
  Use at the start or end of implementation sessions, when asked to "kick off a
  session", "close out", "prepare to publish", "make sure ceremony is done", or
  when a session is about to create a PR. Wraps preflight, persona selection,
  apple estimate, handoff/memory lookup, verification, review prereqs, handoff,
  apple recording, telemetry capture, and non-draft publication policy.
---

# Session kickoff / closeout

This skill is an operational checklist for existing Crawler policy. It does not
replace `AGENTS.md`; when there is a conflict, `AGENTS.md` and the policy docs win.

## Kickoff

1. Run `bash scripts/agent/preflight.sh`.
2. State the kickoff verdict: **recommended**, **risky**, or **not recommended**.
3. Select the owning persona from `docs/agent-os/personas/README.md` and read that persona.
4. Read the relevant `docs/knowledge/handoffs/INDEX.md` section and skim the top recent handoffs for the touched systems.
5. Declare the apple estimate before editing code. Tooling-only work is capped at 3🍎.
6. Load durable memory through the memory MCP (`read_graph` or `search_nodes`) when available, and skim `docs/knowledge/memory/` for relevant facts.
7. Reflect a bounded ask before implementation when the success gate is missing or ambiguous.
8. Keep plans in session chat unless the human explicitly asks for a file artifact.

## Closeout for merge-intent implementation sessions

1. Run the cheapest relevant targeted tests for touched files.
2. Run `npm run verify:fast` after meaningful changes.
3. Run `npm run verify:pr-prereqs` before PR publication.
4. Run the apple-scaled review harness for ≥3🍎 work and keep its ledger complete.
5. Run code review and CodeQL in the required order when code changed.
6. Write a handoff under `docs/knowledge/handoffs/` with `## Systems touched`.
7. For ≥3🍎 sessions, record apples with `npm run apples:record -- --session <slug> --estimated <n> --actual <n>`.
8. If `files/guard-telemetry.jsonl` exists, run `npm run telemetry:capture -- <session-slug>`.
9. Publish ready-for-review, non-draft PRs unless the human explicitly pre-declared local ownership.

## Lightweight cases

- Investigation-only sessions with no merge-intent fix may skip handoff/review-ledger ceremony.
- 1–2🍎 sessions do not need an apples metrics file.
- Do not rebuild `docs/knowledge/handoffs/INDEX.md`; CI owns that generated file.
- Do not run broad sweeps locally. Use GitHub workflow dispatch and include `project:sweep-results-viewer runId=<run-id>` in every sweep status/result response.

## Related tooling

- `list_pr_cockpit`, `get_pr_cockpit`, `get_pr_blockers` — read-only PR status/blocker summary.
- `dispatch_weapon_sweep`, `dispatch_ai_sweep` — GitHub-backed sweep dispatch that returns the required Sweep Results Viewer reference.
- `.github/skills/review-harness/SKILL.md` — review ledger flow for ≥3🍎 work.
- `.github/skills/pr-shepherd/SKILL.md` — takeover loop for already-published PRs.
