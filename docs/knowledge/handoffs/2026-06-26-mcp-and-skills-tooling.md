# Session Handoff: MCP servers + awesome-copilot skills (agent tooling)

## Date

2026-06-26

## Persona(s) adopted

**DevOps Engineer** — the work is agent/dev tooling configuration (`.mcp.json`,
`.github/skills/`), no game-layer code. Started as a research request ("which MCP
servers / skills / OSS frameworks should we adopt?") that the user then asked to
action.

## Routing verdict

✅ right persona — tooling/config + automation surface is the DevOps Engineer's
lane; no `src/` code was touched so no specialist routing was needed.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — config edit + vendoring 7 skill folders; the only unplanned
step was `npm ci` (this worktree had no `node_modules`, so the pre-push
`format:check` hook failed until deps were installed). Low logic risk, no code.

Hello kitties: 2/5 = 0.40 🎀

## What Was Done

Actioned a research finding into concrete agent tooling.

- **MCP servers** added to `.mcp.json` (was filesystem/memory/context7; now 6):
  - `playwright` — `npx -y @playwright/mcp@latest`. Drives the real canvas for
    the blocking e2e/visual-regression gate via accessibility snapshots.
  - `github` — hosted remote `https://api.githubcopilot.com/mcp/` (`type: http`).
    Structured PR/Actions/issue tools for the heavy PR-automation workflow.
  - `azure` — `npx -y @azure/mcp@latest server start`. Inspect the
    storage-blob/queue sprite pipeline (ADR 0017) during debugging.
- **Skills** vendored into `.github/skills/` from `github/awesome-copilot@main`
  (copy install, same `SKILL.md` format as the existing `pr-shepherd`):
  `playwright-generate-test`, `playwright-explore-website`,
  `create-architectural-decision-record`, `chrome-devtools`,
  `conventional-commit`, `security-review`,
  `suggest-awesome-github-copilot-skills`. Each maps to a practice the repo
  already has (e2e gate, ADR culture, conventional PR titles, security loop).
- **Research report** (not committed; lives in session artifacts) captures the
  full rationale plus deferred items (audio, RNG).

## What's Next

- **Audio decision (deferred by user):** Sound Designer persona exists but there
  is zero audio code/deps. Pick Phaser-4 built-in sound vs Howler.js via a short
  ADR.
- **RNG hardening (optional):** `src/shared/random.ts` is xorshift32 with modulo
  bias; `pure-rand` (already transitive via fast-check) is better but switching
  re-baselines every deterministic seed — bundle into a future balance pass.
- **BT-vs-library rationale:** keep the hand-rolled behavior tree (determinism),
  but a one-line "why not a library" note in an ADR would satisfy the
  build-vs-buy "record the fit-gap" rule.
- Verify the `github` HTTP MCP entry loads in a fresh Copilot CLI session; fall
  back to the local Docker (`ghcr.io/github/github-mcp-server`) stdio form if not.

## Blockers

None. (`npm ci --ignore-scripts` resolved the missing-deps push blocker.)

## Branch State

- Branch: `nalfeo-research-mcp-tooling`
- All tests passing: n/a — config/docs-only change, no `src/`, `tests/`, or
  `scripts/` files touched; pre-push `format:check` gate passed.
- PR created: yes (this session)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` not present this session — no guard telemetry to
report.

## Test Results

No TypeScript/test files changed, so `verify` was not re-run. The pre-push hook
ran `npm run format:check` and reported "All matched files use Prettier code
style!". Lab gate is not applicable (no `src/core/systems/**` or `src/labs/**`
changes).

## Key Decisions Made

- Used the **hosted remote** GitHub MCP server (`type: http`) rather than the
  local Docker image, to avoid a Docker/PAT dependency for local CLI use.
- Installed deps with `--ignore-scripts` to skip the slow Playwright/Chromium
  postinstall, which is not needed to push (git hooks are already wired via
  `core.hooksPath`).
- Curated 7 directly-relevant skills out of the ~300 in the catalog; deferred
  the niche/blueprint/eval families until the audio/Ollama phases.
