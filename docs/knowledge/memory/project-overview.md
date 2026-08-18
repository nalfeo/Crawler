---
title: Crawler Project Overview
type: note
permalink: project-overview
tags: [overview, project]
---

# Crawler Project Overview

Crawler is a crafting-focused, vampire-survivors-like game set in a brutal
intergalactic reality-show dungeon narrated by an AI showrunner ("The Director").
The project is entirely agent-driven, and all gameplay logic is deterministic so
it can be tested and replayed.

## Observations

- [stack] TypeScript (strict), Phaser 4, bitecs 0.4, Vite, Vitest, fast-check #tech
- [repo] GitHub repo is nalfeo/Crawler; default branch is main #repo
- [principle] All gameplay logic must be deterministic; CI gates are scripts with exit codes, never LLM-as-judge #determinism
- [process] Work is organized by personas and an "apple" complexity estimate declared before coding #agent-os
- [entrypoint] Game runs via npm run dev; sandboxes via npm run lab; devtools via npm run devtools #workflow

## Relations

- has_architecture [[Architecture and Layers]]
- follows [[Conventions and Invariants]]
- contains [[Systems Map]]
- records_decisions_in [[Decisions Index]]
