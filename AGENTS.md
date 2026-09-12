# Crawler Agent Contract

Crawler is a crafting-focused vampire-survivors-like game. It uses Phaser 4 for
rendering and bitecs 0.4 for deterministic ECS logic. This is the canonical,
short session contract; detailed procedures live in the linked docs.

Prerequisites: Node.js and Python versions from `.node-version` and
`.python-version`, Bash, and [GitHub CLI](https://cli.github.com/) authenticated
with `gh auth login`. On Windows, install GitHub CLI with
`winget install --id GitHub.cli --exact`.

## Start and scope

1. Run `npm run preflight`. This bootstraps Git Bash on Windows and installs
   dependencies in a fresh worktree before running the canonical preflight.
2. Choose a persona from [the routing matrix](docs/agent-os/personas/README.md)
   (use **Producer** for multi-layer or ambiguous work) and read that persona.
3. Before planning a system change, use
   [the handoff index](docs/knowledge/handoffs/INDEX.md) to read the relevant
   recent handoffs. Load durable facts from the memory MCP when available; else
   skim [memory](docs/knowledge/memory/README.md). Do not bulk-read either.
4. Before implementation, read
   [complexity policy](docs/agent-os/policies/complexity-policy.md), declare an
   🍎–🍎🍎🍎🍎🍎 estimate, and state a recommendation verdict. For ≥3🍎, record
   estimated and actual apples at handoff with `npm run apples:record`.
5. For an underspecified request, ask one decisive question at a time until it
   has one measurable success gate and ranked tiebreakers. Restate the bounded
   ask and get confirmation before coding. Explicit, bounded requests may proceed.

- **Kickoff verdict is mandatory:** At session kickoff, explicitly say whether the ask is **recommended**, **risky**, or **not recommended**, with a short reason.
- **Plans stay in session chat and PR context:** When giving a plan, write the full plan in session chat and preserve it in the progress summary / PR description via the progress-report tool. Do **not** hide plans in repo files unless the human explicitly asks for a file artifact.
- **Published PRs detach by default:** Unless the human explicitly states before PR publication that the session should remain local, an implementation session must publish a ready-for-review PR, leave complete handoff context, then end/release its ownership immediately. Do **not** wait locally for CI, reviews, or cloud confirmation; CI Recovery assigns cloud Copilot for blockers, with the 10-minute scheduled sweep as the takeover backstop.
- **Broad sweeps default to GitHub:** For sweeps or batch evals with **more than 10 runs**, default to GitHub-backed `workflow_dispatch`/CI execution (for example `.github/workflows/weapon-sweep.yml` or `.github/workflows/ai-sweep.yml`) instead of local/session compute unless a human explicitly asks for local.
- **Investigation sessions are process-light:** Investigation/repro/debug sessions with no merge-intent fix may stay lightweight. If a fix should land, spin a separate implementation child session/PR and run the normal full process there.
- **Tooling-only ceremony is capped at 3🍎:** Work confined to developer/agent tooling, canvases, automation, or asset-pipeline tooling is estimated at no more than 3🍎 regardless of file count; the cap does not apply when runtime gameplay behavior or shipped game data changes.
- **Continuation before oversized history:** When `npm run telemetry:token-budget` reports an exceeded context, cumulative-input, or response threshold, create a concise handoff with `npm run handoff:continue` and continue in a fresh thread. This repository workflow does not control platform compaction; include `--rollout` when available to report first-request and cumulative input telemetry.
- Group coherent edits into a validation phase. Run focused unit/type/lint/docs checks after each phase (or before a risky refactor), and use `npm run scope` to select any additional heavy checks. `npm run verify:fast` remains required before handoff/PR, and `npm run verify:pr-prereqs` remains required before publication.

## Build safely

- Preserve explicit human requirements; never loosen a requirement, gate, or
  test merely to go green. Diagnose and fix the cause, or ask the human if the
  requirement itself must change.
- Keep gameplay deterministic: use `SeededRandom`, never `Math.random()`;
  never use `Date.now()` in game logic. See
  [conventions](docs/knowledge/memory/conventions-and-invariants.md).
- Respect layers: `src/core/` is pure (no Phaser, engine, game, or labs);
  `src/engine/` cannot import game/labs; `src/game/` cannot import engine/labs;
  labs are unrestricted. See [architecture](docs/knowledge/memory/architecture-and-layers.md).
- New ECS systems require a lab and sim-side wiring or a documented, justified
  allowlist entry. Visual/runtime work must be observed in the real artifact,
  not only a lab. Follow the relevant persona and the project policies.
- Use apple-scaled independent review and reply only in existing PR review
  threads; do not use issue/PR comments to satisfy status or planning rules.
- Use existing, standard tooling before creating infrastructure. Keep changes
  focused; preserve unrelated working-tree changes.

## Validate and publish

- Group coherent edits into a validation phase. Run focused unit/type/lint/docs
  checks after each phase (or before a risky refactor), and use `npm run scope`
  to select any additional heavy checks. `npm run verify:fast` remains required
  before handoff/PR, and `npm run verify:pr-prereqs` remains required before
  publication.
  Do not run the full suite by default; CI owns it unless a human asks or
  diagnosis requires it.
- Before publishing, run `npm run sync:main -- --reason pre-publish`; rerun
  affected checks if it changes HEAD. Preflight supplies session-start sync.
- Implementation sessions require a dated handoff with `## Systems touched`.
  Capture guard telemetry when `files/guard-telemetry.jsonl` exists. Do not
  rebuild the handoff index locally.
- Create ready-for-review PRs, never drafts. The merge train is the only merge
  path; do not arm auto-merge. Use
  [merge-train guide](docs/guides/merge-train.md) and the relevant
  persona/PR-shepherd instructions for detailed recovery and review handling.

## Lookup map

| Need                                     | Read / run                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| Persona, review tier, memory, PR process | `docs/agent-os/`, `.github/skills/`, relevant persona                   |
| Commands and scoped validation           | `package.json`, `npm run scope`, `npm run verify:fast`                  |
| Game design or architecture              | `docs/knowledge/memory/`, relevant handoffs, ADRs                       |
| Sprites or Azure sidecars                | `docs/knowledge/game-design/art-style-guide.md`, `scripts/sprites/`     |
| Server launch problem                    | `files/worktree-server-launch.log`, `files/worktree-server-status.json` |

For the full project command inventory, use `npm run` or `package.json`; do not
keep an exhaustive catalog here.
