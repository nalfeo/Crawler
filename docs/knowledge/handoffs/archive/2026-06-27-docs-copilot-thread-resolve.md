# Session Handoff: Document the cross-App auto-resolve limitation (Copilot reviewer threads)

## Date

2026-06-27

## Persona(s) adopted

Producer — a small, cross-cutting docs change touching CI workflow comments and
two agent-instruction files; no specialist layer involved.

## Routing verdict

✅ right persona — pure documentation/process capture, no code or game-layer
work.

## Apples

Estimated: 🍎 x 1 <!-- declared before work began -->
Actual: 🍎 x 1 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — two-file docs note plus a synced third file; mechanism was
already confirmed from PR #401 logs.

Hello kitties: 1/5 = 0.20 🎀

## What Was Done

Captured a day-long papercut as a permanent doc note: the
`auto-resolve-review-threads.yml` workflow cannot resolve review threads
**authored by another GitHub App** — notably `copilot-pull-request-reviewer`
(Copilot code review). The workflow's App installation token gets
`viewerCanResolve: false` for those threads, and the resolve loop guards on
`viewerCanResolve`, so it **skips** them even when the owner has already replied
with the `✅ Addressed` marker. This was observed directly on PR #401: the App
run logged "Threads resolved: 0. Threads skipped: 1" for a
copilot-pull-request-reviewer thread carrying an OWNER ✅ Addressed reply, and
querying as the owner showed `viewerCanResolve: true` — so the owner must resolve
such threads via the GraphQL `resolveReviewThread` mutation.

Files changed (docs only):

- `.github/workflows/auto-resolve-review-threads.yml` — added an
  "Observed limitation (cross-App threads)" paragraph to the header comment,
  stated as observed behavior with the PR #401 evidence.
- `AGENTS.md` — new bullet under "Resolving addressed review comments" with the
  practical consequence (an already-armed `--auto` merge stays BLOCKED) and a
  copy-pasteable `gh api graphql … resolveReviewThread` example.
- `.github/copilot-instructions.md` — synced the same bullet (this file mirrors
  the AGENTS.md review-process section).

## What's Next

- If the team wants this fully automated, a follow-up could have the workflow run
  under a token/identity that GitHub treats as able to resolve Copilot-reviewer
  threads, or add a separate owner-PAT step scoped to those threads. Out of scope
  here — this PR only documents the current observed behavior.

## Blockers

None.

## Branch State

- Branch: `nalfeo-docs-copilot-thread-resolve` (off fresh `origin/main` @ 2f5271ef)
- All tests passing: n/a (docs-only; no code/test changes)
- PR created: yes — auto-merge armed (`--auto --squash`)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` not present this session — nothing to paste.

## Test Results

Docs-only change; no build/test impact. Verified the workflow edit is
comment-only (YAML structure untouched) and the markdown renders as intended.

## Key Decisions Made

- **Stated as observed behavior**, not an asserted token-permission theory: the
  concrete evidence is the PR #401 run log ("resolved: 0, skipped: 1") plus the
  `viewerCanResolve` divergence (false for the App, true for the owner). The
  inferred "an App can't resolve another App's thread" mechanism is consistent
  with the workflow header's existing GITHUB_TOKEN note and is phrased as the
  reason, not an over-claimed fact.
- **Synced all three instruction surfaces** (`AGENTS.md`,
  `.github/copilot-instructions.md`, and the workflow header) so future agents
  hit the guidance wherever they look.
