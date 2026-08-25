# Crawler

A crafting-focused vampire-survivors-like set inside a brutal intergalactic reality show dungeon.
An ancient AI showrunner (_The Director_) narrates your descent through procedurally generated floors
while alien audiences bet on your survival. Dark humor meets spectacle — Squid Game stakes,
American Gladiators showmanship, Dungeon Crawler Carl absurdity.

## Play

| Channel   | Link                                                  |
| --------- | ----------------------------------------------------- |
| Release   | [Play](https://nalfeo.github.io/Crawler/)             |
| Beta      | [Play](https://nalfeo.github.io/Crawler/beta/)        |
| Dev       | [Play](https://nalfeo.github.io/Crawler/dev/)         |
| Lab (Dev) | [Open](https://nalfeo.github.io/Crawler/dev/lab.html) |

## Architecture

**Tech stack:** TypeScript (strict) · Phaser 4 · bitecs 0.4 · Vite · Vitest · fast-check

The codebase is split into five layers with strict one-way import boundaries enforced by ESLint:

| Layer    | Path          | Role                                                                            |
| -------- | ------------- | ------------------------------------------------------------------------------- |
| `shared` | `src/shared/` | Constants, types, utilities, and data schemas shared across the codebase        |
| `core`   | `src/core/`   | Pure ECS game logic (bitecs). **No Phaser imports allowed.**                    |
| `game`   | `src/game/`   | Game-level systems: weapons, enemy AI, scenario scripts, crafting               |
| `engine` | `src/engine/` | Phaser 4 rendering bridge — scenes, sprites, HUD, VFX                           |
| `labs`   | `src/labs/`   | Dev sandboxes with unrestricted imports; every system needs one before shipping |

Legal import edges:

- `src/shared/` imports no higher layers
- `src/core/` may import `src/shared/`
- `src/game/` may import `src/core/` and `src/shared/`
- `src/engine/` may import `src/core/` and `src/shared/`
- `src/labs/` may import anything

The game loop runs as a deterministic ECS pipeline in `src/core/` and `src/game/`,
driven by Phaser 4's update tick in `src/engine/scenes/MainGameScene.ts`.
Simulation/runtime randomness uses `SeededRandom`; labs are exempt from that determinism rule.

For the full systems catalogue, ADRs, specs, and agent-OS policies see [`docs/`](docs/README.md).

## Developer docs

```bash
npm run dev            # Vite dev server
npm run lab            # Labs harness (per-system sandboxes)
npm run verify:fast    # typecheck + changed-file lint + changed unit tests (~30s)
npm run verify         # full pre-commit chain (add VERIFY_COVERAGE=1 / VERIFY_FULL=1 for coverage / headless)
```

## Goobers (agent orchestration)

Crawler uses [Goobers](https://github.com/Agent-Clubhouse/Goobers) to run its manual-only `crawler-feature-pr`
workflow (producer plan → implementer → independent reviewer → `npm run verify:fast` →
ready-for-review PR). The versioned desired-state source lives in [`.goobers/`](.goobers/README.md).

To set up a local Goobers instance:

1. Copy `.goobers/instance.yaml.example` to your external instance root (e.g. `C:\goobers\crawler\instance.yaml`)
   and set a `GOOBERS_GITHUB_TOKEN` env var with a token for the target repo.
2. Validate the versioned source before materializing it:
   ```powershell
   Q:\src\Goobers\bin\goobers.exe validate --source-tree .goobers
   ```
3. Materialize the `crawler` gaggle into your external instance root, then start the Goobers daemon.

Do **not** put tokens, journals, workcopies, scheduler state, or telemetry inside `.goobers/` —
that directory is source only; runtime state belongs in the external instance root.
See [`.goobers/README.md`](.goobers/README.md) for the full runtime-boundary and migration notes.

### Running Goobers in GitHub Actions

Two manual (`workflow_dispatch`-only) workflows run Goobers on a GitHub-hosted runner
without a Go build step — they download a pinned, checksum-verified release binary instead:

- [`.github/workflows/goobers-validate.yml`](.github/workflows/goobers-validate.yml) — validates `.goobers/` only.
- [`.github/workflows/goobers-run.yml`](.github/workflows/goobers-run.yml) — actually triggers `crawler-feature-pr` end to end.

`goobers-run.yml` needs two repository secrets configured (**Settings → Secrets and
variables → Actions**) before it can succeed:

| Secret                 | Required?    | What it's for                                                                                                                                                                                                                                                                                                                                                                     | Where to get it                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COPILOT_GITHUB_TOKEN` | **Required** | Authenticates the GitHub Copilot CLI's model backend for every agentic stage (producer, implementer, reviewer). This is a _separate_ concern from repo access — Copilot's model auth is account-level, not repo-level.                                                                                                                                                            | Create a **personal** fine-grained PAT (github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens) with **Account permissions → Copilot Requests: Read-only** and **no repository access at all**. If the token's owning account is outside `nalfeo`'s org, an org owner must approve it first (org Settings → Third-party access). |
| `GOOBERS_GITHUB_TOKEN` | **Required** | Repo credential Goobers uses for issue/PR/branch operations (claiming issues, pushing branches, opening PRs). `crawler-feature-pr` declares `repo:push`, which the built-in `GITHUB_TOKEN` cannot satisfy (it's read-only in this workflow, and a `GITHUB_TOKEN`-authored push wouldn't trigger the normal CI workflow anyway) — the workflow fails fast if this secret is unset. | A fine-grained PAT (or GitHub App installation token) with **Contents, Issues, and Pull requests: Read and write** on this repo.                                                                                                                                                                                                                                    |

The two tokens are deliberately different credentials with different scopes — never
reuse one PAT for both. See the Goobers repo's
[`docs/guides/github-token-scopes.md`](https://github.com/Agent-Clubhouse/Goobers/blob/main/docs/guides/github-token-scopes.md)
for the full capability-to-token mapping and the cross-org rationale for keeping
`agent:model` on its own personal token.

## Logging

Crawler uses [`loglevel`](https://github.com/pimterry/loglevel) with scoped loggers.

- Default level: `info`
- Configure via env: `VITE_LOG_LEVEL` (browser) or `LOG_LEVEL` (scripts)
- Override in browser query string: `?logLevel=debug`
- Toggle at runtime in the browser console:
  - `window.crawlerLogs.setLevel('debug')`
  - `window.crawlerLogs.getLevel()`

## Sprite assets

Player + enemy sprites come from [Kenney's CC0 asset packs](https://kenney.nl/).
The committed PNGs live under `public/assets/kenney/`.

To refresh them from the upstream Kenney CDN:

```bash
bash scripts/fetch-assets.sh
```

The script is idempotent and verifies the SHA-256 of each download
before writing into the repo. See `public/assets/kenney/README.md`
for the list of vendored packs.
