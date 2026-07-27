# Session Handoff: Apple-scaled review harness skill + pre-PR ledger guard

## Date

2026-06-29

## Persona(s) adopted

**Producer** — the task spanned multiple layers (a new validator module + CLI,
a copilot-guards guard + scope classifier, a reusable skill, all 13 agent
personas, and several policy/instruction/docs files), so it routed as
multi-layer governance/tooling work rather than a single-system change.

## Routing verdict

✅ right persona — Producer fit because the change is cross-cutting process
tooling that touches governance docs, guards, scripts, and personas at once.

## Apples

Estimated: 🍎 x 4 <!-- declared before work began -->
Actual: 🍎 x 4 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — N/A

Hello kitties: 4/5 = 0.80 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-06-29-improve-local-harness.review-ledger.json`
Stages (tier 4): plan_review ✅ · dual_plan_synthesis ✅ · code_review ✅ · multi_model_review ✅
`npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-06-29-improve-local-harness.review-ledger.json` → pass.

This change **dogfooded the harness it introduces**:

- **dual_plan_synthesis**: two independent plans (gpt-5.5 + gemini-3.1-pro-preview)
  synthesized by a claude-opus-4.8 judge into `plan.md`.
- **plan_review**: gpt-5.4 rubber-duck reviewed the synthesized plan
  (approved_with_changes); all 6 concerns adopted before coding.
- **code_review + multi_model_review**: 3 code-review agents (claude-sonnet-4.6,
  gpt-5.3-codex, gemini-3.1-pro-preview) + security-review (CLEAN). gpt-5.4
  (xhigh) adjudicated 9 findings → 7 valid; all resolved with regression tests;
  re-review round clean.

## What Was Done

Encoded an apple-complexity-scaled **plan-review + multi-model code-review**
process as a reusable skill, enforced before PR by a deterministic guard backed
by an auditable review-ledger artifact, and made personas output the full plan
before execution.

- **Validator** `scripts/agent/review/ledger.mjs` — pure-ESM single source of
  truth for the ledger schema, tier→required-stages mapping, path regex, and
  per-stage rules. Exports `STAGE_NAMES`, `DATE_RE`, and the validate/format API.
- **CLI** `scripts/agent/review/cli.mjs` (+ npm `review:ledger`) — `init` /
  `stage` / `validate`. Hardened per review: `--flag=value` + `--` terminator
  parsing, bare-flag rejection (no silent `--apples`→1 downgrade), `--date`
  validated against `DATE_RE` (blocks path traversal), unknown stage names
  rejected against `STAGE_NAMES`.
- **Guard** `.github/extensions/copilot-guards/guards/pr-review-ledger.mjs` —
  `failClosed: true`, matches `create_pull_request`, skips non-code-only diffs
  via `lib/pr-scope.mjs` (strict allowlist; `src/**` is never skippable),
  requires a valid branch-added ledger for code-touching PRs. Exposes an
  injectable `gatherDecision()` so the git-error→allow path is unit-tested.
- **lib/git.mjs** — `branchFiles`/`branchAddedFiles`/`branchCommitSubjects` now
  **throw** on a null merge-base instead of silently returning `[]` (no more
  fail-open on a shallow clone / missing main ref). The guard + pr-preflight both
  already try/catch → allow-with-context, so this is safe.
- **Skill** `.github/skills/review-harness/` — `SKILL.md` + `references/{plan-review,
code-review-loop,ledger-recipes}.md` with copy-pastable `task`-tool recipes and
  ledger CLI commands per stage.
- **Personas** — all 13 docs + `personas/README.md` now require emitting the full
  plan before execution and recording the required review-ledger stages.
- **Docs/policy/instructions** — new `docs/agent-os/policies/review-harness-policy.md`;
  `complexity-policy.md` trigger section; `AGENTS.md` rule #14 + command rows;
  `.github/copilot-instructions.md` mirrors; `handoffs/TEMPLATE.md` Review Harness
  section; `docs/README.md` registry row; `copilot-guards/README.md` guard entry.
- **Tests/CI** — `test:guards` npm script runs the guard suite **and** the
  review-ledger validator + CLI suite (182 tests); wired into `verify.sh` and the
  ci.yml `check-format-and-labs` merge-gate job.

## What's Next

- After merge, the first real PR through the active `pr-review-ledger` guard will
  exercise the enforcement end-to-end on someone else's change — watch for
  false-denies on edge diffs and tune `lib/pr-scope.mjs` if needed.
- Consider a follow-up that auto-stamps the `code_review`/`multi_model_review`
  rounds from `task`-tool agent results to reduce manual ledger authoring.

## Blockers

None.

## Branch State

- Branch: `nalfeo-upgraded-pancake`
- All tests passing: yes (`test:guards` 182, `verify:fast` green, `docs:check` 0)
- PR created: yes (see PR link in session)

> Note: local `main` ref drifted ahead of the branch's true base. The branch is
> exactly one commit on top of the origin/main merge-base — review/diff with
> `git show HEAD` (i.e. `HEAD~1..HEAD`), not against local `main`.

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 165,
  "guards": {
    "boom": { "crash": 22 },
    "ctx": { "allow": 11 },
    "ctx-a": { "allow": 11 },
    "ctx-b": { "allow": 11 },
    "edit-bad": { "bypass": 11 },
    "edit-guard-self-protection": { "ask": 22 },
    "pr-a": { "deny": 11 },
    "pr-b": { "deny": 11 },
    "pr-hard": { "deny": 11 },
    "pr-warn": { "allow": 11 },
    "shell-a": { "deny": 11 },
    "shell-bad": { "deny": 22 }
  },
  "tools": {
    "create_pull_request": 44,
    "edit": 66,
    "powershell": 55
  }
}
```

> These guard names are synthetic fixtures emitted by the guard **test** runs in
> this session (the dispatcher/telemetry unit tests), not production guard
> decisions.

## Test Results

- `npm run test:guards` → **182 tests, 182 pass, 0 fail** (guard suite + review
  ledger validator + CLI suite).
- `npm run verify:fast` → ✅ Fast verification passed.
- `npm run docs:check` → exit 0.
- `npx eslint scripts/agent/review/*.mjs` → clean.
- `npm run review:ledger -- validate <ledger>` → valid 4-apple ledger.

## Key Decisions Made

- Enforcement is **artifact-based** (the agent self-reports stages; the guard
  validates _completeness_, not _truthfulness_) — documented caveat in the policy
  and guard README. Accepted trade-off.
- Enforcement = **hard deny** on `create_pull_request`, scoped to code-touching
  diffs via a strict allowlist; `src/**` is never classified skippable.
- `pr-review-ledger` is a **standalone** guard; `pr-preflight` was left unmodified.
- Lean JSON ledger + JS validator as the single source of truth (no `ajv`).
- See ADR-adjacent reasoning captured in `plan.md` and the
  `docs/agent-os/policies/review-harness-policy.md` policy.

## Retrospective

### Lessons Learned

- The session **workspace directory name** (`nalfeo-upgraded-pancake`) and the
  **git branch name** (`nalfeo-improve-local-harness`, set via `rename_branch`)
  differ. `git push` and `create_pull_request` operate on the actual git branch
  (`git branch --show-current`), not the directory name. Confirm the real branch
  name and that it is pushed to origin before opening a PR.
- `create_pull_request` does **not** auto-push; the branch must already exist on
  origin. A `422 invalid` there means "head branch not found on remote," **not**
  a guard rejection — guards run client-side _before_ the GitHub API call (my
  `pr-review-ledger` guard had already allowed the PR).
- Local `main` had drifted ahead of the branch's true fork point, but
  `git merge-base HEAD main` still resolves the correct common ancestor. Review
  and diff with `git show HEAD` / `HEAD~1..HEAD`, not against local `main`.
- PowerShell has **no heredoc** — `git commit -F - <<'EOF'` fails. Write the
  message to a temp file and use `git commit -F <file>`.
- `lint-staged` runs Prettier on commit and re-stages; Prettier normalizes
  single-quoted strings to double quotes, so subsequent string edits must match
  the **on-disk, post-format** form or `edit` won't find the `old_str`.

### Mistakes Made

- **Two wasted PR/push round-trips** from assuming the workspace-dir name was the
  branch name: `create_pull_request` 422'd, then `git push origin nalfeo-upgraded-pancake`
  failed with "src refspec does not match any." The fix was one `git branch
--show-current` check I should have run first. Early signal: a 422 with no guard
  output ⇒ check the remote/branch, not the diff.
- `cli.test.mjs` initially used `new URL(...)`, which tripped `no-undef` under the
  `scripts/**` ESLint config (no `URL` global). Switched to
  `path.dirname(fileURLToPath(import.meta.url))`.
- The first implementation pass left `lib/git.mjs` **failing open** (returning
  `[]` on a null merge-base) — a real correctness hole that only the multi-model
  review caught. A guard that silently returns "no files" would have skipped
  enforcement on a shallow clone.

### Opportunities for Future Improvement

- **Auto-stamp** the `code_review` / `multi_model_review` ledger rounds directly
  from `task`-tool agent results, removing manual ledger authoring and reducing
  the risk of the self-reported artifact drifting from what actually ran.
- The guard validates ledger **completeness, not truthfulness**. A future
  enhancement could cross-check claimed model ids / concern counts against a
  machine-readable review-run log.
- `docs-check-readme-commands` reports 29 non-blocking findings (pre-existing
  command-table drift between `package.json` and the docs tables) — worth a
  dedicated cleanup pass.
- Have the session tooling reconcile (or prominently surface) the workspace-dir
  name vs. the real branch name to prevent the push/PR confusion above.
