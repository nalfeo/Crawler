# 2026-06-04 — Convention Enforcement Hooks Extension

## Summary

Built `.github/extensions/copilot-guards/` — a project-scoped Copilot CLI extension
that registers `onPreToolUse` hooks to deterministically enforce Crawler conventions
at the tool-call boundary. Stops the agent from doing the wrong thing instead of
relying on it to remember.

Nine guards across three categories: shell-command safety, file-edit policy, and
PR preflight aggregation. All guards run before the matching tool executes; first
deny wins for shell/edit, PR guards aggregate into a single combined report.

## What ships

| Category | Guards                                                                                        |
| -------- | --------------------------------------------------------------------------------------------- |
| Shell    | `shell-force-push-main`, `shell-main-branch-delete`, `shell-gh-pr-create`, `shell-rm-rf-repo` |
| Edit     | `edit-determinism`, `edit-phaser-in-core`, `edit-repo-md-junk`, `edit-guard-self-protection`  |
| PR       | `pr-preflight` (semantic title, handoff, lab-gate, forbidden paths, cross-system ADR warning) |

Full descriptions, bypass mechanisms, and "NOT enforced" rationale in
`.github/extensions/copilot-guards/README.md`.

## Architecture

- `extension.mjs` — joinSession + dispatcher entry
- `lib/dispatcher.mjs` — guard walking; first-deny for shell/edit, aggregate for PR; per-guard `failClosed` flag
- `lib/shell.mjs` — command normalization (handles `&&`, `;`, `|`, `\` continuations, `bash -c` wrappers, quoted tokens, `.exe` suffix, `/path/to/git` prefix)
- `lib/git.mjs` — merge-base/branch-files/branch-subjects cached by HEAD sha
- `lib/strip-comments.mjs` — two strippers: `stripCommentsAndStrings` (for code-pattern searches) and `stripCommentsOnly` (preserves string literals, used for phaser-import detection)
- `lib/config.mjs` — config loader + `COPILOT_GUARDS_DISABLE` / `COPILOT_GUARDS_EDIT` env var handling
- `config.json` — committed per-guard `{disabled, severity}` flags

## Verification

- `npx tsc --noEmit` ✓
- `npx eslint src/ tests/ scripts/ --max-warnings 0` ✓
- `npx vitest run --project unit` ✓ (341 tests)
- `node --test ".github/extensions/copilot-guards/tests/*.test.mjs"` ✓ (88 tests)
- `extensions_reload` → extension loads as `copilot-guards` PID running cleanly
- Live PR creation in this very session must pass `pr-preflight` — eating own dog food

## Rubber-duck findings incorporated

The pre-build critique caught:

- Handoff check must verify a NEW handoff file in the branch diff, not just that any handoff exists (repo already has many).
- Aggregate PR guards into one report so the agent fixes everything in one round.
- Use the full conventional-commit allowlist from `docs/agent-os/policies/ci-policy.md`, not a guessed subset.
- Shell normalization needs to handle quote stripping, line continuations, and chained operators robustly.
- Determinism guard must ignore matches in strings/comments to avoid false positives on docstrings or string literals.
- Self-protection guard needed so an agent can't disable the extension by editing it without confirmation.
- Per-guard fail-closed/fail-open flag so safety guards deny on exception but advisory guards stay out of the way.
- Specific allowlist for `edit-repo-md-junk` rather than a blanket "no markdown in repo".

## Bypass

Documented escape hatches (always logged):

- `COPILOT_GUARDS_DISABLE=guard-id,other-id` (specific) or `=*` (all)
- `COPILOT_GUARDS_EDIT=1` short-circuits the self-protection guard
- `config.json` → `"disabled": true` per guard for repo-wide opt-out (committed)

## Unresolved / deferred

- **Co-authored-by trailer on commits.** Considered but deferred — modify-vs-warn ambiguity. Documented in README under "NOT enforced". Add `shell-commit-trailer` later if needed.
- **Verify-fast freshness.** Tracking last successful `verify:fast` in `.git/copilot-last-verify` and warning at PR time was in the original brief; deferred — value-vs-noise tradeoff not yet clear.
- **ADR cross-system rule** is a warning (`additionalContext`), not a deny. Promote to deny once we've watched real PRs for a while.

## Next agent steps

1. Watch PRs over the next 1–2 weeks for false positives. Tune `pr-preflight` allowlists.
2. Consider promoting the cross-system ADR warning to a deny once we've validated it doesn't block legitimate small refactors.
3. Add `shell-commit-trailer` guard when we decide on the modify-vs-warn question.
4. Consider a CI workflow that runs `node --test` against the extension on every PR.

## Files touched

- `.github/extensions/copilot-guards/` (extension, 24 files)
- `docs/knowledge/handoffs/2026-06-04-enforcement-hooks-extension.md` (this file)
- `AGENTS.md` (pointer to enforcement extension)

## Coordination

- Parallel sprite session (`4a980391-...`) untouched — different branch, different files.
- Lab-scroll PR #20 unaffected.
- Branch `nalfeo/enforcement-hooks-extension` is fresh off `main` — no stacking.
