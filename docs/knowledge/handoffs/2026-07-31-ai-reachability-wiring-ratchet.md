# Session Handoff: AI/headless system reachability wiring ratchet

## Date

2026-07-31

## Persona

DevOps Engineer

## Systems touched

ai-behavior-tree

## Apples

3🍎 exact

## What Was Done

- Tightened ADR 0039's deterministic orphaned-system guard so
  `src/engine/scenes/MainGameScene.ts` can no longer independently satisfy
  `npm run check:wired-systems`. The trusted witnesses are now the canonical
  floor bootstrap options, shared core simulation step, both sim wrappers, and
  the AI headless runner.
- Confirmed `src/bootstrap/floor-main-scene-options.ts` is shared rather than
  visual-only: `headless-runner.ts` consumes `createFloorMainSceneOptions()` and
  passes its canonical `preSystems`/`postSystems` to the headless step.
- Extended AST extraction for the existing invoked nullish-fallback form
  `(options.runFovSystem ?? fovSystem)(world)`. The matcher remains narrow:
  nullish expressions used as object values or arguments do not count.
- Added deterministic tests for visual-scene-only failure, bootstrap success,
  each sim-step success, allowlisted success, exact witness membership, the
  nullish-callee positive case, and dangerous false-positive shapes.
- Updated ADR 0039, AGENTS.md, Copilot instructions, the Systems Engineer agent,
  and CLI diagnostics to describe the sim-side/shared contract. A stronger
  player/UI-observability witness was explicitly declined by the maintainer.
- Reverted the existing postcss override from unavailable `8.5.25` to
  feed-available `8.5.22`. The committed lock entry uses the canonical npmjs
  tarball URL and SHA-512 integrity; a clean `npm ci --prefer-offline` passed
  through the configured feed.
- Observed in the real guard artifact: before the extractor correction, removing
  the scene witness produced one false orphan (`fovSystem`); after the change,
  `npm run check:wired-systems` reports 49 systems checked, with all 46
  sim-side-reachable systems plus 3 documented allowlist entries accounted for.
  `npm run verify:fast` passed with 40 focused guard tests.

## Key Decisions Made

- This is a sim-side/shared witness gate, not whole-program call-graph analysis
  and not a player-observability gate. Both sim wrappers remain valid witnesses
  by explicit maintainer requirement.
- `MainGameScene.ts`-only references fail, but shared bootstrap references pass
  because the headless runner consumes the same options.
- The allowlist remains unchanged. Audit results:
  - `enemySpawnerSystem`: reason still accurate. It is an intentional lab/test
    helper requiring `SpawnerConfig`, with no production caller.
  - `floor2EnemyDirectorSystem`: reason still accurate and the system is live,
    not inert. Floor 2 initialization installs `floor2ObjectiveTick` on the
    world; wired `floorObjectiveSystem` invokes it every frame; that tick calls
    `floor2EnemyDirectorSystem`.
  - `weaponEntitySystem`: shipped inert. Neither the system nor its sole producer
    `spawnWeapon` has a production caller; the live player path uses singleton
    `weaponSystem`. Issue #666 was closed while the condition persisted; the
    replacement tracking issue is #2442. It was deliberately not wired in this
    PR.
- The allowlist is the guard's weak edge: each entry is a promise to revisit an
  intentionally unwired system, but a closed tracking issue can silently void
  that promise while the inert system continues to pass the guard.
- The guard still covers only exported names matching `*System`. Plain functions
  remain structurally invisible, including known producer/consumer defect
  examples `listInventoryEntries` and `passiveAbilityIds`; this is an accepted
  consequence of the scoped decision, not coverage provided by this ratchet.

## What's Next / Blockers

- Follow up separately on shipped-inert `weaponEntitySystem` / #2442; do not fold
  that runtime/product decision into this tooling PR.
- A future guard may target plain-function producer/consumer contracts, but it
  should be designed separately rather than broadening this naming-convention
  check.
- No blocker remains for this PR.

## Retrospective

### Lessons Learned

- Counting identifiers from a curated file set is still sensitive to legitimate
  call syntax. Direct execution of the existing pure AST APIs exposed the
  nullish-callee blind spot that a text/reference inventory missed.
- The configured package feed may publish fewer versions than npmjs metadata;
  dependency overrides must be checked against the actual installation source.

### Mistakes Made

- The first delegated measurement reported 51 total / 48 reachable because it
  treated imports as wiring. The early signal was disagreement with the guard's
  documented two-form AST contract. Running the guard's own pure APIs corrected
  the measurement to 49 total / 46 genuinely reachable / 3 allowlisted.
- Initial npm lock generation through the configured proxy emitted a private
  feed URL and SHA-1 integrity. Code review caught the portability and integrity
  regression; the entry was replaced with canonical public URL + SHA-512
  metadata and verified by a clean install.

### Opportunities for Future Improvement

- Add a small repository command that prints exported, wired, allowlisted, and
  orphaned system names separately so blast-radius investigations do not need an
  ad hoc Node expression.
- Consider moving lab-only `enemySpawnerSystem` outside `src/game` so its
  exemption is unnecessary.
