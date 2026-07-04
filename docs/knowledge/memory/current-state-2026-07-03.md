---
title: Current State 2026-07-03
type: note
permalink: current-state-2026-07-03
tags: [state, snapshot, memory]
---

# Current State (2026-07-03)

A dated snapshot of durable, slow-moving project state. Rename and refresh this
note as the project evolves; do not treat it as live status.

## Observations

- [state] Default branch is main; latest merged Floor 2 slice on main is the shared perfect-world travel-time API + phase-gated post-boss stairs panic slack (PR #735, commit 863442f3) #state
- [floor2] Floor 2 (Family Territories) has slices 1–8 landed on main: faction data + relationships, cave-system generator, family-aware AI + feuding, sealed boss dens, dynamic win evaluator, settlement + seeded shops, HUD family relationships, scenario wiring + Governor sweep #floor2
- [floor2] Main-scene bootstrap (src/bootstrap/floor-main-scene-options.ts) still targets Floor 1 only; Floor 2 is exercisable via labs and the headless runner, not from npm run dev yet #floor2
- [ai] src/game/ai now hosts both deterministic runtime AI (headless runner CLI, BT kernels, win-rate sweeps ai:hill-climb/ai:winrate-sweep/ai:weapon-sweep/ai:headless) and remains reserved for future LLM/Director content (floor-load only when implemented) #ai
- [gates] npm run verify is opt-in: coverage runs only with VERIFY_COVERAGE=1 and headless Floor 1 win-rate runs only with VERIFY_FULL=1; wiring guard (check:wired-systems) and PR prerequisites (verify:pr-prereqs) are always part of verify #gates
- [gates] The orphaned-system wiring guard (ADR 0039) enforces that every \*System exported from src/core/** or src/game/** is either wired into a real pipeline site or explicitly allowlisted; lab-only references do not count #gates
- [adr] ADR count is 71 files (66 numbered + 5 date-prefixed); highest number is 0043 (reused twice: behavior-tree build-vs-buy, CI asset-request worker bypass); next unused number is 0044 #adr
- [memory] Basic Memory KB under docs/knowledge/memory/ superseded 2026-06-26 snapshot with this note; agent-memory.jsonl Verification_Commands entity refreshed to match verify.sh / verify-fast.sh #memory

## Relations

- snapshot_of [[Crawler Project Overview]]
- updates [[Systems Map]]
- reflects [[Conventions and Invariants]]
- supersedes [[Current State 2026-06-26]]
