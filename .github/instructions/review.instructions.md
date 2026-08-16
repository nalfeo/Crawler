---
applyTo: '**'
---

# Pull Request Review Instructions

When reviewing a pull request or diff, adopt the **Reviewer** persona defined in
`docs/agent-os/personas/reviewer.md`. The goal is one comprehensive, high-signal pass,
not an incremental stream of discoveries.

This is a game-development review. Crawler is a deterministic Phaser/bitecs
game, so the review should prioritize changed gameplay behavior, simulation
wiring, runtime correctness, and player-visible regressions over broad
repository archaeology.

## Scope discipline

- Start from the files changed by the PR and the systems those files directly
  touch. Do **not** perform an unbounded whole-codebase scan.
- Expand beyond the diff only to inspect direct callers/callees, runtime wiring,
  data producers/consumers, tests, and prior review threads needed to validate a
  concrete concern.
- Prefer a precise changed-system trace over generic advice. If a concern cannot
  be tied to a changed line, changed data file, changed workflow, or changed
  contract, do not report it.
- Review generated or aggregate files by the semantic row/entry that changed
  (IDs, registry entries, quest rows, sprite manifest records), not by treating
  the whole file as newly authored.

## Review protocol

1. Read the complete diff before reporting any finding. Inventory each changed behavior
   and the repository instructions that apply to every touched path.
2. Read all prior review threads, including resolved threads and their replies, before
   reporting any finding. Treat a prior `✅ Addressed in <sha>` or `✅ Not applicable:`
   reply as resolved history: do not reopen or repost that finding unless a later
   follow-up comment contains concrete evidence that the resolution is invalid.
3. Trace changed symbols through their callers, state mutations, error paths, runtime
   wiring, and tests. Inspect relevant code outside the diff when needed to validate a
   concern.
4. Review every category below, even after finding a blocker:
   - correctness, edge cases, and failure handling;
   - data flow, state lifecycle, ordering, concurrency, and determinism;
   - API/contracts, compatibility, and cross-layer integration;
   - security, trust boundaries, secrets, and unsafe input/output handling;
   - runtime wiring, cleanup, resource ownership, and performance regressions;
   - regression coverage and compliance with Crawler's path-specific policies.
5. Group duplicate symptoms under one root-cause finding. Before finalizing, make a
   second pass over the complete diff specifically for related instances of every root
   cause already found.
6. Report all validated findings together in one response, ordered by severity. Include
   the file/line, concrete failure scenario, impact, and smallest correct remedy.
7. End with a compact coverage statement listing every category checked and either its
   finding count or `clean`.

## Crawler risk checklist

Apply these checks to the changed files and systems:

- **Gameplay correctness:** damage, XP, loot, quest progression, boss/room
  lifecycle, inventory state, cooldowns, ability behavior, and floor transition
  changes preserve their contracts across edge cases.
- **Determinism:** simulation code avoids `Math.random()`, `Date.now()`,
  wall-clock timing, iteration-order dependence, and LLM/runtime nondeterminism.
  Seeded behavior must remain reproducible across headless and real game paths.
- **Runtime wiring:** new or moved systems are called by a real sim-side/shared
  pipeline, not only by a lab, scene-only path, or test helper. Labs prove
  isolation; they do not prove shipped behavior.
- **Layer boundaries:** core ECS stays render-free, engine stays rendering/input
  focused, game logic avoids engine/lab imports, and shared data stays portable.
- **Performance:** hot loops, pathfinding, targeting, rendering sync, particle
  work, asset loading, and large data scans remain bounded. Flag avoidable
  per-frame allocation, repeated full-corpus scans, missing cache invalidation,
  and changes that can scale badly with entities, rooms, assets, or PR count.
- **Visual/runtime observation:** UX, rendering, sprite, camera, lab, and gameplay
  behavior changes include deterministic before/after evidence in the real
  artifact when required by repo policy.
- **Regression coverage:** confirmed bugs should gain deterministic unit,
  integration, e2e, headless, guard, or workflow coverage. Recurring review
  findings should be converted into a scripted gate when feasible.
- **Security and trust boundaries:** workflow/script changes must not expose
  secrets, execute untrusted content, weaken permissions, or make GitHub token
  behavior ambiguous.

## Recurring Crawler failure patterns to hunt

Use these as high-yield prompts while staying scoped to changed files:

- **Lab-only success:** a system works in a lab but is absent from the real
  simulation/headless pipeline.
- **Silent reverts and stale merges:** conflict resolution resurrects deleted
  assets/data, drops nearby lines, or uses blunt merge strategy outcomes.
- **Aggregate-file collisions:** JSON registry, manifest, quest, tuning, and
  workflow rows collide by ID or overwrite another PR's semantic row.
- **Defanged guards and allowlists:** new tolerances, suppressions, or allowlist
  entries lack reason, expiry, tracking reference, or removal condition.
- **Fixture drift:** schema changes update production data but not factories, or
  tests hard-code outdated fields instead of using canonical builders.
- **Automation deadlocks:** CI recovery, merge-train, docs, or issue-filing loops
  throw out of an item loop, skip remaining work, or hide novel failures.
- **Runtime/test split-brain:** headless, lab, and real game code paths disagree
  about budgets, player radius, route reachability, timers, or data loading.
- **Sprite/asset integrity gaps:** manifests reference missing PNGs, stale
  `contentHash` values, wrong transparent backgrounds, duplicate IDs, or assets
  that are approved but not wired.
- **Sweep and benchmark misuse:** broad sweeps run locally without explicit
  request, raw Actions links replace Sweep Results Viewer links, or cherry-picked
  seeds substitute for rate-based evidence.
- **Performance-neutrality leaks:** optimization changes alter RunStats,
  fingerprints, targeting, balance, or player-visible behavior without proving
  neutrality.

## Signal rules

- Report only actionable, high-confidence bugs, vulnerabilities, policy violations, or
  missing regression coverage. Do not report style, formatting, or speculative concerns.
- Do not stop after the first issue and do not intentionally defer findings to a later
  review.
- If no validated findings remain after the second pass, say so explicitly.
- Deterministic gates remain authoritative. A recurring review finding should become a
  deterministic test or check rather than relying on future model consistency.
