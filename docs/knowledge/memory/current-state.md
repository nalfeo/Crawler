---
title: Current State 2026-06-26
type: note
permalink: current-state-2026-06-26
tags: [state, snapshot, memory]
---

# Current State (2026-06-26)

A dated snapshot of durable, slow-moving project state. Rename and refresh this
note as the project evolves; do not treat it as live status.

## Observations

- [memory] Persistent agent memory was added via the MCP memory server seeded from docs/knowledge/agent-memory.jsonl #memory
- [memory] The live memory graph file is an absolute, per-user path set by MEMORY_FILE_PATH in .mcp.json (machine-specific) #memory
- [memory] This Basic Memory KB under docs/knowledge/memory/ is the curated, in-repo companion to that graph #memory
- [memory] Setup, caveats, and sync workflow are documented in docs/guides/agent-memory.md #docs
- [memory] File-based memory remains primary: ~299 handoffs in docs/knowledge/handoffs/ plus ADRs and personas #memory
- [blocker] Basic Memory's MCP server failed to build on arm64 Windows (httptools wheel missing); delivered as ready-to-enable #blocker
- [caveat] The official memory server resolves a relative MEMORY_FILE_PATH against its own install dir, so absolute paths are required #caveat

## Relations

- snapshot_of [[Crawler Project Overview]]
- updates [[Systems Map]]
- reflects [[Conventions and Invariants]]
