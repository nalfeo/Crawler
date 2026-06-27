---
title: Decisions Index
type: note
permalink: decisions-index
tags: [adr, decisions]
---

# Decisions Index

Architecture Decision Records live in `docs/knowledge/adr/`. Any decision
affecting two or more systems needs an ADR. Note that parallel agents have
occasionally produced duplicate ADR numbers (e.g. several `0023-*` files), so
match on the full filename, not just the number.

## Observations

- [adr] 0001-ecs-architecture — establishes the bitecs ECS architecture #ecs
- [adr] 0002-lab-gated-development — every system needs a lab before shipping; CI-enforced #lab-gating
- [adr] 0003-sprite-generation-pipeline — multi-stage sprite generation and judging #sprites
- [adr] 0006-drops-system-architecture — loot drops and pickups #loot
- [adr] 0022-bt-exploration-pure-kernels — pure deterministic behavior-tree kernels for AI #ai
- [adr] 0023-feet-as-single-internal-spatial-unit — feet as the one internal spatial unit; bridge converts to pixels #units
- [caveat] The adr/ directory holds ~44 markdown files including TEMPLATE.md; duplicate 0023 numbers exist #housekeeping

## Relations

- documents [[Architecture and Layers]]
- documents [[Systems Map]]
- referenced_by [[Crawler Project Overview]]
