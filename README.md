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

Crawler uses [Goobers](https://github.com/Agent-Clubhouse/Goobers) to run its
`crawler-feature-pr` workflow automatically for approved issues (and by manual
dispatch): producer plan → implementer → independent reviewer →
`npm run verify:fast` → ready-for-review PR. The versioned desired-state source
lives in [`.goobers/`](.goobers/README.md).

To set up a local Goobers instance:

1. Copy `.goobers/instance.yaml.example` to your external instance root (e.g. `C:\goobers\crawler\instance.yaml`)
   and set `GOOBERS_GITHUB_TOKEN` (a dedicated target-repo token) and
   `COPILOT_GITHUB_TOKEN` (the Copilot model token) before starting the daemon.
2. Validate the versioned source before materializing it:
   ```powershell
   Q:\src\Goobers\bin\goobers.exe validate --source-tree .goobers
   ```
3. Materialize the `crawler` gaggle into your external instance root, then start the Goobers daemon.

Do **not** put tokens, journals, workcopies, scheduler state, or telemetry inside `.goobers/` —
that directory is source only; runtime state belongs in the external instance root.
See [`.goobers/README.md`](.goobers/README.md) for the full runtime-boundary and migration notes.

### Running Goobers in GitHub Actions

Two workflows run Goobers on a GitHub-hosted runner without a Go build step — they
download a pinned, checksum-verified release binary instead:

- [`.github/workflows/goobers-validate.yml`](.github/workflows/goobers-validate.yml) — validates `.goobers/` only.
- [`.github/workflows/goobers-run.yml`](.github/workflows/goobers-run.yml) — runs
  `crawler-feature-pr` immediately when an issue in the Goobers intake cohort is
  opened, reopened, or labeled `goobers:approved`; hourly at minute 37 to recover
  missed events, backlog, or failed eligible work; or by manual dispatch. The
  cohort is the union of approved issues and the legacy issue-intake eligibility
  cohort — see [`.goobers/README.md`](.goobers/README.md). Goobers bounds
  plan/implementation/review retries to two attempts and bounds gate repasses to
  two.

  Each dispatch runs two matrix lanes on separate GitHub-hosted runners, and
  each lane runs **two concurrent slots** — a hard maximum of four active issue
  workflows per dispatch. Every slot is its own isolated Goobers instance root
  running its own blocking `goobers run`; a single instance holds a scheduler
  lock for the whole of one run, so separate roots (not a daemon) are what make
  two runs on one runner safe. Instance roots also own the git working copies,
  so no two slots ever write the same checkout. Exactly one slot (lane 1,
  slot 1) may carry recovery/resume metadata, while the other slots claim fresh
  backlog items through Goobers' provider-side claim protocol, which settles
  concurrent claims deterministically. Every slot's runs are individually
  journalled, claim-released and label-reconciled when the lane finishes.

  A single `reserve` job — which both lanes declare in `needs:` — resolves that
  one recovery target, labels it `goobers/status:in-review`, and confirms the
  label through the same provider read a fresh claim performs before either
  lane starts. The recovery path bypasses Goobers' claim protocol, so that
  label is the only barrier between the resuming slot and the fresh ones;
  making it a job dependency is what turns "reserved first" into an ordering
  guarantee instead of a race between two simultaneously starting lanes. Only
  one _dispatch_ at a time may own a recovery reservation: `reserve` asks the
  Actions API whether another run of this workflow is still live, and defers
  recovery designation (fresh claims continue) when one is. The per-lane
  concurrency groups are static, so lane _n_ of a second dispatch queues behind
  lane _n_ of this one and the four-slot ceiling holds across dispatches too.

  Reservation ownership is evidenced, not inferred, and the evidence is a
  **durable lease** that outlives its Actions run. The recovery lane posts an
  adoption receipt on the reserved issue _before_ it exports any recovery
  metadata, and appends a disposal receipt only once it has proved both that
  its stage tree was reaped and that its run disposition was applied. Both
  receipts are scoped to the Actions run **and attempt**, so re-running a
  failed run opens a new lease rather than inheriting the previous attempt's
  disposal. The `release-unstarted-reservation` job reads those receipts
  instead of the aggregate matrix result — which cannot tell "never adopted"
  apart from "adopted, reap failed, a descendant may still be pushing" — and
  removes the reservation label only on proof of one of those two safe states.
  Crucially, a _later_ dispatch reads them too: an Actions run reports
  `completed` while a session-detached stage keeps pushing, so an issue whose
  latest lease is adopted-but-undisposed is skipped by the scheduled recovery
  scan (with the manual reconciliation command named) and fails an explicit
  `issue_number` request outright.

  Receipts are only believed when they are written by the GitHub Actions
  identity, when the marker owns a whole line of the comment, and — for a
  disposal — when it lives in the adoption's **own comment body**
  (`scripts/agent/goobers-reservation-lease.sh`). Issue comments are public and
  the marker text is predictable, so a substring match over every comment would
  let anyone who can comment forge a disposal and hand a live issue to a second
  agent. Trusted authorship alone is not enough either: the run-result comment
  embeds Goobers journal text written by the agent under test, so a disposal
  accepted from any Actions-authored comment could be injected through a stage
  error message. That text also has its newlines collapsed before it is
  rendered, so it can never own a line in the first place.

  When a slot overruns its deadline, the lane tears down that slot's whole
  stage process tree with `scripts/agent/goobers-stage-teardown.sh` and refuses
  to release any provider claim or issue label until every descendant is
  provably gone. Goobers detaches each stage into its own session, so
  signalling the `goobers run` process alone would leave Copilot and
  verification children running against a claim the job had already released.
  Each root is handed to the teardown as `<pid>:<start-time>`, never a bare
  pid: a slot's deadline lands up to ~55 minutes after its launch, and seeding
  the sweep from a pid Linux had since recycled would kill an unrelated
  process, its children and its whole session. A teardown that cannot prove the
  tree is gone fails the step **immediately** rather than blocking on the
  surviving root — waiting on a process that will never exit is the one path
  that runs out the job timeout and skips every cleanup step.
  That deadline is derived from the _absolute_ job budget: the job records its
  start time in its first step, and the run window is
  `timeout-minutes − (elapsed setup + GOOBERS_JOB_START_SLACK_SECONDS) −
GOOBERS_CLEANUP_RESERVE_SECONDS`, capped by `GOOBERS_SLOT_DEADLINE_SECONDS`,
  so a slow setup shortens the run instead of eating the time teardown,
  journal upload and claim cleanup need. The startup allowance is there because
  the first step is not job start — scheduling and runner bootstrap precede it
  — and the reserve is not an estimate: every cleanup step declares its own
  `timeout-minutes`, and a structural test asserts the reserve covers the sum
  of those enforced ceilings plus the teardown worst case, so the job timeout
  cannot interrupt cleanup. A run left without a terminal journal phase is
  marked aborted with `goobers run abort`; if that repair does not take, or the
  provider claim cannot be retired, the lane releases nothing and mutates no
  label — a preserved label is recoverable by hand, duplicated agent work is
  not. A second journal artifact captures the post-repair journal, and both
  artifacts carry a per-slot `diagnostics/slot-diagnostics.txt` written
  unconditionally, so the artifact every error message and result comment
  points at always exists even when a slot produced no journal at all. Both
  uploads set `include-hidden-files: true` (the lane root is a dot directory,
  and the uploader will not descend into one otherwise) and carry the run
  **attempt** in their name, so re-running a failed run does not collide with
  its own first attempt's artifact. The reserved recovery issue is
  dispositioned and commented on whenever **its own slot** produced no journal
  — a healthy sibling slot's journal never stands in for it, because the
  disposal receipt is written on that step's exit status.

  A slot that finds the backlog already drained by a sibling slot is a normal
  outcome, not a failure: preflight only proves that at least one eligible
  issue exists, and a no-work at the claim stage with no issue id is
  deterministic proof that the slot claimed nothing. A backlog scan that cannot
  be _read_, however, is never treated as an empty backlog: both the recovery
  sweep and the fresh-eligibility scan check the API call's exit status and
  fail the dispatch with the rate-limit diagnosis command.

`goobers-run.yml` needs two repository secrets configured (**Settings → Secrets and
variables → Actions**) before it can succeed:

| Secret                 | Required?    | What it's for                                                                                                                                                                                                                                                                                                     | Where to get it                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COPILOT_GITHUB_TOKEN` | **Required** | Authenticates the GitHub Copilot CLI's model backend for every agentic stage (producer, implementer, reviewer). This is a _separate_ concern from repo access — Copilot's model auth is account-level, not repo-level.                                                                                            | Create a **personal** fine-grained PAT (github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens) with **Account permissions → Copilot Requests: Read-only** and **no repository access at all**. If the token's owning account is outside `nalfeo`'s org, an org owner must approve it first (org Settings → Third-party access). |
| `GOOBERS_GITHUB_TOKEN` | **Required** | Dedicated repository credential Goobers uses for issue/PR/branch operations (claiming issues, pushing branches, opening PRs). `crawler-feature-pr` declares `repo:push`, which the built-in `GITHUB_TOKEN` cannot safely satisfy because a `GITHUB_TOKEN`-authored push would not trigger the normal CI workflow. | Create a dedicated fine-grained PAT or GitHub App installation token with **Contents, Issues, and Pull requests: Read and write** on this repo only. Do not reuse `CRAWLER_CI_PAT`, which is reserved for CI recovery automation.                                                                                                                                   |

The two tokens are deliberately different credentials with different scopes — never
reuse one PAT for both. See the Goobers repo's
[GitHub token-scope guide](https://github.com/Agent-Clubhouse/Goobers/blob/main/docs/guides/github-token-scopes.md)
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
