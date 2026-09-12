# Agent Environment

Crawler keeps GitHub Copilot (GHCP), GitHub Actions, and Codex worktrees on one
environment contract.

## Sources of truth

- `.node-version` pins Node.js.
- `.python-version` pins Python.
- `package-lock.json` pins npm dependencies.
- `scripts/sprites/proper-pixel-art-requirements.txt` pins the Python packages.
- `scripts/agent/setup-environment.mjs` installs and verifies those dependency
  inputs on every agent surface.

Do not copy version or install commands into a workflow. Change the source file,
then run `npm run environment:check`. The drift check verifies that the shared
GitHub Action, GHCP setup workflow, normal CI sprite runner, and Codex local
environment still consume the same contract.

## Surfaces

- GHCP: `.github/workflows/copilot-setup-steps.yml`
- GitHub Actions: `.github/actions/setup-node/action.yml` and the `test-sprites`
  job in `.github/workflows/ci.yml`
- Codex: `.codex/environments/environment.toml`

The GitHub runners install the pinned runtimes first, then call the bootstrap
with `--skip-npm` because the shared Node action already ran `npm ci`. Codex
calls the bootstrap without that flag in a new worktree.

Codex local environments use host runtimes. If the host does not match the
pinned versions, setup stops with the required version and the version found;
install or activate the pinned runtime and retry setup.

## Verification

```text
npm run environment:check
npm run verify:fast
```

The first command is the focused parity gate. The second is the repository's
required post-change validation.
