# Handoff: Stop agents blocking on issue/PR comment writes

## Date

2026-08-24

## Persona

DevOps Engineer

## Systems touched

ci-policy, agent-personas

## Apples

2🍎 (instruction/text fix in the intake kickoff body plus one small deterministic shell guard)

## Summary

Issue #3479: agents repeatedly halted mid-session — "I'm blocked before implementation: the environment has no GitHub CLI token, and no available tool can create an issue comment" — because the CI-recovery kickoff comment (`ISSUE_INTAKE_BODY`) literally instructs Copilot to _post a detailed plan comment on this issue_ before writing any code. Cloud coding-agent sessions have no issue-comment credentials, so the instruction is unsatisfiable and whole sessions were lost to it.

Fix, at the source of the instruction plus a deterministic backstop:

- `ISSUE_INTAKE_BODY` now asks for exactly the same plan content (design, key decisions, checklist) but tells the agent to publish it with the progress-report tool — progress summary and PR description — and explicitly says never to block on comment access. The bot-side retroactive plan machinery (`buildRetroactivePlanComment`, `ISSUE_RECOVERY_PLAN_MARKER`) is unchanged: the reconciler _does_ have a token and still mirrors the plan onto the issue.
- `AGENTS.md` gains a **Never block on posting a comment** standing rule; the personas standing plan-first rule is aligned with it.
- New `shell-issue-comment` copilot guard denies `gh issue comment`, `gh pr comment`, and REST/GraphQL issue-comment writes with a remediation that points at the progress-report tool. Comment _reads_ and PR **review-thread** replies (the `✅ Addressed in <sha>` markers the merge gate depends on) stay allowed.

## Files touched

- `.github/scripts/ci-recovery/issue-intake-lib.mjs`
- `.github/scripts/ci-recovery/issue-intake.test.mjs`
- `.github/extensions/copilot-guards/guards/shell-issue-comment.mjs` (new)
- `.github/extensions/copilot-guards/tests/shell-issue-comment.test.mjs` (new)
- `.github/extensions/copilot-guards/extension.mjs`, `config.json`, `README.md`
- `AGENTS.md`, `docs/agent-os/personas/README.md`

## Verification run

- `node --test .github/scripts/ci-recovery/issue-intake.test.mjs` — 33/33 pass.
- `node --test ".github/extensions/copilot-guards/tests/*.test.mjs"` — 237/237 pass (includes the 17 new guard cases).
- `npx eslint` on the changed `.mjs` files — clean; `npx prettier --write` on all changed files.
- `npm run test:guards` — the only failures are the pre-existing `set-piece-editor` / sprite-editor Playwright suites failing on a sandbox with no downloaded Chromium (`browserType.launch: Executable doesn't exist`), unrelated to this change.

## Unresolved issues

- None. (Per this very change, the plan for this session was published through the progress-report tool and PR description rather than an issue comment.)

## Recommended next steps

- If any other automation body still asks an agent to "post a comment", route it through the same progress-report phrasing.
