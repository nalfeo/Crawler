# Session Handoff: Adopt drop-in agent-memory systems

## Date

2026-06-26

## Persona(s) adopted

**Producer** — the task spans docs, repo config (`.mcp.json`), tooling, and an
agent-workflow policy, so it is multi-layer and ambiguous by default.

## Routing verdict

✅ right persona — coordinating config + docs + tooling with no single-system
code change is squarely Producer work.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — N/A

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

Researched and then adopted persistent **agent memory** for the repo. Two layers
were wired/seeded and one was delivered ready-to-enable:

- **MCP memory graph (Option 1):** wired `.mcp.json` `memory` server with an
  absolute, per-user `MEMORY_FILE_PATH` (survives worktree rotation) and seeded
  it from a new committed snapshot `docs/knowledge/agent-memory.jsonl`
  (29 entities + 31 relations; facts verified against constants.ts and the ADR
  directory).
- **Basic Memory KB:** authored a curated Markdown knowledge base under
  `docs/knowledge/memory/` (README + 6 notes) using Basic Memory's
  observation/relation conventions.
- **Guide + onboarding:** wrote `docs/guides/agent-memory.md`, added a Quick
  Start bootstrap step and a Key Files row to `AGENTS.md`, and git-ignored
  `**/.basic-memory/`.
- Full research report saved to the session artifacts dir
  (`research/any-drop-in-memory-systems-i-could-adopt.md`).

## What's Next

- Enable Basic Memory's MCP server once on an x64/macOS/Linux/WSL host or after
  installing MSVC C++ Build Tools (see blocker below), then
  `basic-memory project add crawler ./docs/knowledge/memory && basic-memory sync`.
- Establish a habit of syncing the live memory graph back to
  `docs/knowledge/agent-memory.jsonl` and committing periodically.
- Consider whether the machine-specific `MEMORY_FILE_PATH` in `.mcp.json` should
  stay committed or move to a per-environment override.

## Blockers

- **Basic Memory cannot build on this arm64 Windows host:** `uv tool install
basic-memory` fails compiling native `httptools` (no cp312 win-arm64 wheel, no
  C/C++ toolchain). Delivered as ready-to-enable; workarounds documented in the
  guide.
- The official memory server resolves a **relative** `MEMORY_FILE_PATH` against
  its own npx-cache install dir, so an absolute path is mandatory; that path is
  environment-specific.

## Branch State

- Branch: `nalfeo-research-drop-in-memory-systems`
- All tests passing: yes (`npm run verify` — all 8 steps green)
- PR created: no

## Agent-OS Telemetry

N/A — `files/guard-telemetry.jsonl` not present this session.

## Test Results

`npm run verify` passed: typecheck, eslint, prettier, knip, unit+coverage,
integration (49 passed/1 skipped), headless Floor 1 gate (68 passed), and
`vite build` all green.

## Key Decisions Made

- Use a **stable per-user absolute path** for the live memory file plus a
  **committed repo snapshot** as the version-controlled source of truth, rather
  than a fragile relative or in-worktree absolute path.
- Keep file-based memory (handoffs/ADRs) primary; the MCP graph and Basic Memory
  KB are queryable companions, not replacements.
