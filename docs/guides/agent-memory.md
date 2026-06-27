# Agent Memory Guide

Persistent, cross-session memory for the AI agents that build Crawler. This guide
covers the three memory layers, how to bootstrap them at session start, how they
were seeded, and the known caveats (including an arm64-Windows build blocker for
Basic Memory).

> TL;DR for agents: at the start of a session, call the memory MCP `read_graph`
> (or `search_nodes`) to load durable facts, skim `docs/knowledge/memory/`, and
> check recent `docs/knowledge/handoffs/`. Record durable facts back into the
> graph and, when structured, into `docs/knowledge/agent-memory.jsonl`.

## The three layers

| Layer              | Backing store                                                     | Best for                                                 | Search                  |
| ------------------ | ----------------------------------------------------------------- | -------------------------------------------------------- | ----------------------- |
| File memory policy | `docs/knowledge/handoffs/`, `docs/knowledge/adr/`, personas       | Narrative history, decisions                             | grep / human reading    |
| MCP memory graph   | `docs/knowledge/agent-memory.jsonl` (seed) + a per-user live file | Structured entities/relations, fast recall of invariants | keyword (MCP tools)     |
| Basic Memory KB    | `docs/knowledge/memory/*.md`                                      | Curated, human-readable, semantic notes                  | semantic (when enabled) |

The file policy (`docs/agent-os/policies/memory-policy.md`) remains primary. The
two MCP layers make the most important, slow-moving facts queryable so agents
don't have to re-derive them from ~299 handoffs every session.

## Layer 1 — File memory policy

Already in place. Nothing to install. See `docs/agent-os/policies/memory-policy.md`
for the hot / codified / on-demand tiers, the handoff protocol, and ADR rules.

## Layer 2 — MCP memory server (knowledge graph)

The repo's `.mcp.json` wires the official
[`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory).
It stores a graph of **entities**, **observations**, and **relations** as a JSONL
file and exposes tools like `read_graph`, `search_nodes`, `create_entities`, and
`create_relations`.

### Wiring

`.mcp.json` launches the server through a small committed wrapper so it carries
**no machine-specific path**:

```jsonc
"memory": {
  "command": "node",
  "args": ["scripts/agent/mcp-memory-server.mjs"]
}
```

The wrapper (`scripts/agent/mcp-memory-server.mjs`) resolves a stable per-user
live graph file, seeds it once from the committed snapshot, sets
`MEMORY_FILE_PATH`, then hands off to the real
`@modelcontextprotocol/server-memory` over stdio. The same config works for every
user and machine with nothing to edit.

### ⚠️ Why a wrapper (the MEMORY_FILE_PATH footgun)

The server resolves a **relative** `MEMORY_FILE_PATH` against _its own install
directory_ (the `npx` cache), **not** the repo root or your working directory. A
value like `./docs/knowledge/agent-memory.jsonl` would silently read/write inside
the npx cache and never touch the repo, so an **absolute** path is required.

A hard-coded absolute path is itself a problem: it is machine/user-specific, and
Copilot worktrees rotate per session
(`...\copilot-worktrees\Crawler\<random-name>`), so a path into the current
worktree breaks next session. The CLI also does **not** expand `${env:VAR}` or
`${workspaceFolder}` in `.mcp.json` (verified against the CLI binary), so the path
can't be templated in config either.

The wrapper sidesteps all of this by computing the path in code at launch:

```
<homedir>/.copilot/crawler-memory/agent-memory.jsonl
```

Override it with the `CRAWLER_MEMORY_FILE_PATH` environment variable for CI or a
shared location. (Basic Memory — Layer 3 — avoids the whole class of problem by
keeping its store as plain in-repo Markdown.)

> MCP servers load at CLI startup, so edits to `.mcp.json` (or the wrapper) take
> effect in the **next** session, not the current one.

### Seed vs. live file

- `docs/knowledge/agent-memory.jsonl` — the **version-controlled snapshot** (the
  reviewable source of truth). 29 entities + 31 relations covering the project,
  determinism rule, layer boundaries, conventions, key systems, and core ADRs.
- The per-user **live file** is what the running server reads and writes. The
  wrapper seeds it from the snapshot the first time it runs (and `bash
scripts/agent/preflight.sh` runs the same `--ensure` step at session start), so
  there is normally nothing to do by hand.

To **re-seed** the live file manually (e.g. to pull snapshot updates onto a
machine that already has a live file), overwrite it from the snapshot:

```powershell
$live = Join-Path $HOME ".copilot\crawler-memory\agent-memory.jsonl"
New-Item -ItemType Directory -Force -Path (Split-Path $live) | Out-Null
Copy-Item ".\docs\knowledge\agent-memory.jsonl" $live -Force
```

To **commit new memory** the agent has accumulated, copy the live file back over
the repo snapshot, eyeball the diff, and commit:

```powershell
Copy-Item (Join-Path $HOME ".copilot\crawler-memory\agent-memory.jsonl") `
  ".\docs\knowledge\agent-memory.jsonl" -Force
```

> The server rewrites the JSONL in its own compact, canonical form on first
> write, so don't hand-format it for aesthetics; just keep each line valid JSON.

### JSONL schema

One JSON object per line, either:

```jsonc
{"type":"entity","name":"SeededRandom","entityType":"utility","observations":["..."]}
{"type":"relation","from":"Determinism_Rule","to":"SeededRandom","relationType":"requires"}
```

Dedup is by entity `name` and by the `(from,to,relationType)` triple.

## Layer 3 — Basic Memory (curated Markdown KB)

[Basic Memory](https://memory.basicmachines.co) is an MCP server (AGPL-3.0) that
turns a folder of Markdown into a semantic knowledge graph and writes new notes
back as Markdown. Our content root is `docs/knowledge/memory/` (see its
`README.md`). Notes use `- [category] fact #tag` observations and
`- relation_type [[Wiki Link]]` relations.

Running Basic Memory as a separate MCP process does **not** impose AGPL terms on
the Crawler codebase — you are a user of the tool, not a distributor or linker of
its code.

### Install

```bash
uv tool install basic-memory      # preferred
# or: pipx install basic-memory
```

### ⚠️ Known blocker: arm64 Windows build failure

On this host (Windows arm64, Python 3.12 arm64) `uv tool install basic-memory`
**fails** building the native `httptools` dependency — there is no prebuilt
cp312 win-arm64 wheel, and no C/C++ build toolchain is installed. `httptools`
arrives transitively via `fastapi[standard]` → `uvicorn[standard]`.

Workarounds, roughly in order of preference:

1. **Run it where a wheel exists** — x64 Windows, macOS, Linux, WSL, or CI. The
   knowledge base is plain Markdown in the repo, so it syncs anywhere.
2. **Install the MSVC C++ Build Tools** so `httptools` compiles from source
   (large download; requires elevation — not done automatically here).
3. **Skip the native extra (experimental).** `uvicorn` runs without `httptools`
   (it falls back to the pure-Python `h11`). A `uv` dependency override that
   drops `httptools` _may_ let the install proceed; this was **not** verified on
   this host, so treat it as experimental.

Until one of these is done, Layer 3 ships as a **ready-to-enable** package: the
curated Markdown KB is committed and usable as docs today, and becomes a live
semantic store the moment Basic Memory can run.

### Wiring (once installed)

```jsonc
"basic-memory": {
  "command": "uvx",
  "args": ["basic-memory", "mcp"]
}
```

Then register the project and index it:

```bash
basic-memory project add crawler ./docs/knowledge/memory
basic-memory sync
```

Local SQLite index/artifacts live under `~/.basic-memory/` and are git-ignored.

## Session bootstrap protocol

1. Load structured memory: call the memory MCP `read_graph` (or `search_nodes`
   with a topic) to pull invariants and the systems map.
2. Skim `docs/knowledge/memory/` (start at `README.md` → `Current State`).
3. Check the latest few `docs/knowledge/handoffs/` for recent context.
4. As you work, write durable facts back: `create_entities` / `create_relations`
   in the graph, and/or add notes/observations under `docs/knowledge/memory/`.
5. Before ending: write your handoff, and if you added durable graph facts, sync
   the live JSONL back to `docs/knowledge/agent-memory.jsonl` and commit.

## Caveats summary

- The official memory server needs an **absolute** `MEMORY_FILE_PATH`; relative
  paths resolve into the npx cache. The wrapper sets this for you.
- The CLI does **not** expand `${env:VAR}`/`${workspaceFolder}` in `.mcp.json`, so
  the path is resolved in `scripts/agent/mcp-memory-server.mjs` instead. Override
  with `CRAWLER_MEMORY_FILE_PATH`.
- `.mcp.json` and wrapper changes apply **next session** (servers load at startup).
- Basic Memory's server **cannot build on arm64 Windows** here yet; the Markdown
  KB is still valuable and portable in the meantime.
