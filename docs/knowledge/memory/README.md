---
title: Crawler Agent Memory (Basic Memory Project Root)
type: note
permalink: readme
tags: [memory, meta, agent-os]
---

# Crawler Agent Memory

This directory is a curated, human- and agent-readable knowledge base about the
**Crawler** project. It is the content root for [Basic Memory](https://memory.basicmachines.co)
(an MCP server that turns plain Markdown into a queryable knowledge graph) and
doubles as normal documentation you can read directly in the repo.

It complements two other memory layers:

- The **MCP memory server** knowledge graph, seeded from
  `docs/knowledge/agent-memory.jsonl` (structured entities/relations, keyword
  search). See `docs/guides/agent-memory.md`.
- The **three-tier file memory policy** in
  `docs/agent-os/policies/memory-policy.md` (handoffs, ADRs, personas).

## How notes are written

Each note uses Basic Memory's conventions so it can be parsed into a graph:

- **Observations** are bullets shaped as `- [category] fact text #tag`.
- **Relations** are bullets shaped as `- relation_type [[Other Note Title]]`.

## Notes in this KB

- [[Crawler Project Overview]]
- [[Architecture and Layers]]
- [[Conventions and Invariants]]
- [[Systems Map]]
- [[Decisions Index]]

## Enabling Basic Memory

See `docs/guides/agent-memory.md` for setup, including the known arm64-Windows
`httptools` build blocker and workarounds. Once installed:

```bash
basic-memory project add crawler ./docs/knowledge/memory
basic-memory sync
```

## Maintenance

When a durable fact changes, update the relevant note here AND, if it is a
structured entity/relation, update `docs/knowledge/agent-memory.jsonl`.

Notes in this KB record **durable** facts only. Do not add dated point-in-time
status snapshots: they drift within days and then read as live status. Live
status lives in the handoffs (`docs/knowledge/handoffs/`, indexed by
`INDEX.md`), which are dated by construction.
