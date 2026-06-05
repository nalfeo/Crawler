# copilot-guards

Deterministic pre-tool-use guards that enforce Crawler project conventions at
the tool-call boundary. Stops the agent from doing the wrong thing instead of
hoping it remembers to do the right thing.

Loaded automatically because it lives under `.github/extensions/`.

---

## What's enforced

| Guard ID                     | Tool(s)                                 | Decision | What it blocks                                                                                                                                                                    |
| ---------------------------- | --------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell-force-push-main`      | `powershell`, `bash`                    | **deny** | `git push --force` (or `-f`, `--force-with-lease`, `+main:main` refspec) targeting `main`/`master`.                                                                               |
| `shell-main-branch-delete`   | `powershell`, `bash`                    | **deny** | `git push origin --delete main`, `git push origin :main`, `git branch -D main` (and `master`).                                                                                    |
| `shell-gh-pr-create`         | `powershell`, `bash`                    | **deny** | `gh pr create` from the shell. Tells the agent to use the `create_pull_request` tool so PR guards run.                                                                            |
| `shell-rm-rf-repo`           | `powershell`, `bash`                    | **deny** | `rm -rf .` / `./` / `*` / `./*` / `/` / `~` / `..` / absolute paths, plus the PowerShell equivalent `Remove-Item . -Recurse -Force`. Recognizes both `-r`/`-R` and `--recursive`. |
| `edit-determinism`           | `edit`, `create` (src/core,game,shared) | **deny** | New `Math.random()`, `Date.now()`, `performance.now()` calls. Tests and `src/labs/**` exempt. Comments/strings ignored.                                                           |
| `edit-phaser-in-core`        | `edit`, `create` (src/core)             | **deny** | `import 'phaser'`, `require('phaser')`, `import('phaser')` inside `src/core/**`.                                                                                                  |
| `edit-repo-md-junk`          | `create` (`*.md`)                       | **deny** | New `.md` files outside the allowlist (see below). Use the session artifacts folder for planning notes.                                                                           |
| `edit-guard-self-protection` | `edit`, `create` (this extension)       | **ask**  | Modifications to `.github/extensions/copilot-guards/**` unless `COPILOT_GUARDS_EDIT=1`.                                                                                           |
| `pr-preflight`               | `create_pull_request`                   | **deny** | Aggregated PR checks (semantic title, handoff, lab-gate, forbidden paths, cross-system ADR warning).                                                                              |

### `pr-preflight` checks in detail

| Check            | What                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Semantic title   | Title must match `<type>(scope?)!?: <subject>` where type ∈ feat,fix,chore,lab,docs,refactor,test,perf,ci,build.          |
| Handoff required | A `docs/knowledge/handoffs/YYYY-MM-DD-<slug>.md` file must be added in the branch diff. Skipped for docs-only diffs.      |
| Lab gate         | Runs `scripts/agent/lab-gate-check.sh` **only** when the diff touches `src/core/systems/**` or `src/labs/**`. Cached.     |
| Forbidden paths  | Hard-deny on `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.copilot/`, `session-state/`, `generated/`, `*.log`, `node_modules/`. |
| Cross-system ADR | Soft warning (additionalContext, not deny) when the diff spans 2+ of `src/core`, `src/engine`, `src/game` without an ADR. |

### `edit-repo-md-junk` allowlist

- Root: `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `LICENSE.md`, `LICENSE`, `SECURITY.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`
- `docs/**`
- `.github/**` (any markdown)
- `.specify/**`
- `src/labs/**/{README,SPEC}.md`
- `public/assets/**/README.md`

Everything else is denied. Use the session artifacts folder (`~/.copilot/session-state/<id>/files/`) for planning notes.

---

## Bypass mechanisms

These exist for legitimate edge cases (hotfixes, intentional maintenance). Every bypass is logged via `session.log({level:'warning'})` so it's visible.

| Mechanism                                    | Effect                                               |
| -------------------------------------------- | ---------------------------------------------------- |
| `COPILOT_GUARDS_DISABLE=guard-id,other-id`   | Disables specific guards for the session.            |
| `COPILOT_GUARDS_DISABLE=*`                   | Disables all guards (escape hatch).                  |
| `COPILOT_GUARDS_EDIT=1`                      | Allows edits to this extension without `ask` prompt. |
| `config.json` → `"disabled": true` per guard | Repo-wide opt-out (committed).                       |

**Recommendation:** never set `COPILOT_GUARDS_DISABLE=*` in CI. Set it in a single shell when you intentionally need to bypass.

---

## NOT enforced (and why)

- **TypeScript / ESLint correctness.** Already covered by `npm run typecheck` and `npm run lint`. Pre-tool hooks would be redundant and slow.
- **Test coverage.** Too subjective at the pre-tool level. CI enforces coverage thresholds.
- **"Read your persona."** Can't be deterministically verified.
- **Conventional commit on every commit subject.** The project's CI uses `amannn/action-semantic-pull-request`, which checks PR title only. We match that policy in `pr-preflight`; we don't fail individual WIP commits inside a feature branch.
- **`gh pr merge --delete-branch`.** This deletes the PR head branch (cleanup), not `main`. Blocking it would block normal post-merge cleanup. We do block deletion of `main`/`master` itself.
- **Co-authored-by trailer on commits.** Considered but deferred (modify-vs-warn ambiguity). Add a new `shell-commit-trailer` guard if you want this.

---

## How a guard works

Each guard module exports:

```js
export default {
    id: "shell-force-push-main",           // stable id used in config & bypass env
    category: "shell" | "edit" | "pr",     // dispatcher behavior; pr-category guards aggregate
    failClosed: true,                      // on exception, deny (safety) vs allow (advisory)
    matches(toolName, toolArgs) { ... },   // cheap predicate: should I look at this?
    async check(toolArgs, ctx) {           // returns { decision, reason?, additionalContext? }
        return { decision: "deny", reason: "..." };
    },
};
```

`ctx` provides `cwd` and `log(msg, opts)`. Decisions are `"allow"`, `"deny"`, `"ask"`, or `"skip"`.

### Dispatcher semantics

- Shell/edit guards: first `deny` wins (fail fast on danger).
- PR guards (`category: "pr"`): collected into a single combined report so the agent sees every issue in one round trip.
- `additionalContext` from any guard is concatenated and returned even when the overall decision is `allow`.
- A guard that throws is logged and treated per its `failClosed` flag (safety guards fail-closed; advisory guards fail-open).

---

## Adding a new guard

1. Create `guards/<id>.mjs` exporting the shape above. Use `lib/` helpers.
2. Add an entry in `config.json`.
3. Import and register it in `extension.mjs`.
4. Write a `tests/<id>.test.mjs` using `node --test` and `node:assert/strict`.
5. Run `node --test ".github/extensions/copilot-guards/tests/*.test.mjs"`.
6. `extensions_reload` activates it without a restart.

---

## Running the tests

```sh
node --test ".github/extensions/copilot-guards/tests/*.test.mjs"
```

Pure-function guards, no harness needed. 88 tests cover normalization, individual guards, and dispatcher behavior.

---

## Files

```
.github/extensions/copilot-guards/
├── extension.mjs              # joinSession + onPreToolUse dispatch
├── config.json                # per-guard enable + severity
├── README.md                  # this file
├── lib/
│   ├── config.mjs             # config loader + COPILOT_GUARDS_DISABLE handling
│   ├── dispatcher.mjs         # guard dispatch loop, pr aggregation, fail-closed/open
│   ├── git.mjs                # cached merge-base / branch-files / branch-subjects
│   ├── shell.mjs              # command normalization, tokenization, program detection
│   └── strip-comments.mjs     # comment-only and comment+string strippers
├── guards/
│   ├── shell-force-push-main.mjs
│   ├── shell-main-branch-delete.mjs
│   ├── shell-gh-pr-create.mjs
│   ├── shell-rm-rf-repo.mjs
│   ├── edit-determinism.mjs
│   ├── edit-phaser-in-core.mjs
│   ├── edit-repo-md-junk.mjs
│   ├── edit-guard-self-protection.mjs
│   └── pr-preflight.mjs
└── tests/
    └── *.test.mjs             # 88 tests, node --test
```
