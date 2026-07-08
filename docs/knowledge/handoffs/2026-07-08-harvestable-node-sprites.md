# Session Handoff: Floor-1 harvestable world-node sprites

## Date

2026-07-08

## Persona

Graphics/Content Designer (producer-orchestrated slice)

## Systems touched

sprite-pipeline, quests

## Apples

3🍎 estimated, 3🍎 actual (✅ hit). Crosses `src/engine` (new render path —
behavior change, real-artifact observation required), `src/engine/phaser-bridge`
(resolver map), `src/core/spawners` (a determinism-safe cosmetic seed), a
5-sprite art batch, and new deterministic unit/integration/e2e tests. 3🍎 ⇒
review harness = separate-model **plan review** + **code-review loop** + a
**review ledger**; all recorded and validated
(`docs/knowledge/review-ledgers/2026-07-08-harvestable-node-sprites.review-ledger.json`).

## What Was Done

Replaced the Floor-1 harvestable nodes' flat procedural tinted circles with
real generated top-down pixel-art sprites, keeping the harvest progress ring.
All **6/6** harvestable def types resolve to a generated briefId and render
their sprite in the real scene.

- **Art (6 briefIds):** authored 5 node briefs (crimson-mushroom, sunpetal-flower,
  moonbloom-flower, frost-lichen, shadow-lichen) as `type: item`, generated +
  judged + approved on Azure, and **reused the already-approved
  `azure-mushroom-v1`** (2 variants) verbatim per the human's explicit direction
  ("the v1 mushroom is exactly what is supposed to be hooked up"). A throwaway
  warmup brief absorbed the cold-call Azure `fetch failed` flake. Manifest +
  catalog additions are **additions-only** (`manifest +170/0`,
  `sprite-catalog +65/0`), matching the blessed check-in convention.
- **Resolver** (`src/engine/phaser-bridge/sprite-kind.ts`): new explicit map
  `GENERATED_BRIEF_BY_HARVESTABLE` + `generatedBriefIdForHarvestable(defId)`,
  mirroring `generatedBriefIdForEnemy`. briefId convention is `<harvestable-id>-v1`
  (NOT the bare id — that resolves the separate inventory Materials icon surface,
  out of scope, and would collide with `azure-mushroom-v1`).
- **Render path** (`src/engine/PhaserBridge.ts`): the harvestable branch resolves
  the sprite via the map; if the texture exists it draws a scaled Image (new
  `harvestNodeImages` map with despawn/reset cleanup mirroring
  `harvestNodeGraphics`) and the progress ring on top; else it keeps the
  procedural circle. Progress ring is always drawn. Per-node fallback is
  independent, so a partially-wired floor renders correctly.
- **variantRoll determinism fix** (`src/core/spawners/world-objects.ts`):
  `spawnHarvestableNode` never seeded `variantRoll`, so the `Float32Array` 0
  default pinned every node to art variant index 0 and made azure-mushroom's
  second approved variant permanently unreachable. Now seeded from a **LOCAL**
  `SeededRandom(hashStringToSeed(...))` (mirrors `initializeEnemyAppearance`) —
  it never draws from the shared gameplay RNG stream, so it cannot perturb sim
  determinism or win-rate. `variantRoll` is render-only for harvestable nodes
  (the sole gameplay reader, `emitCorpseExplosion`, is `Enemy`+`DeathTimer`-gated
  and unreachable by nodes).

**Observe before done (real artifact, NOT the harvest-lab):** the 2D-`<canvas>`
harvest-lab does not exercise PhaserBridge, so per rule #10 / ADR 0039 validation
is a **deterministic real-scene e2e** —
`tests/e2e/harvestable-node-sprite.test.ts` boots the real MainGameScene via the
main-scene probe and asserts all live harvestable nodes render generated sprites
with **zero** circle fallbacks (**26/26 nodes → sprites, 0 fallbacks**), now with
a **per-def** breakdown so a single-type texture miss cannot be masked by an
aggregate count. This is the "observe before done" real-pipeline artifact.

## Key Decisions Made

- **One combined PR, not the art/wiring split.** The plan sketched PR A (art) +
  PR B (wiring); consolidated into a single PR since the branch already carried
  both. Because it touches code it gets the full 3🍎 review ledger (an art-only
  PR would have been ledger-exempt). Creator was informed.
- **Rebased a stale branch onto `origin/main`.** The branch was 4 behind / 1
  ahead and showed phantom churn from missing merged work (#906/#905/#842).
  Rebased and resolved 3 conflicts (manifest.json, sprite-catalog.json,
  integration test) **additions-only**.
- **briefId `<id>-v1`, not bare id** — mirrors the enemy precedent
  (`GENERATED_BRIEF_BY_ENEMY`) and keeps the inventory-Materials-icon surface
  (owned by the icon/normalization sessions) out of scope.
- **Never weakened a gate.** The variantRoll fix was confirmed determinism-safe
  by round-2 code review _before_ recording the loop clean; the headless Floor-1
  gate + CI enforce win-rate independently.

## What's Next / Blockers

- No follow-up wiring: harvestable node sprites auto-resolve by def id through
  the new map. Adding future harvestable types only needs a `GENERATED_BRIEF_BY_HARVESTABLE`
  entry + approved art under `<id>-v1`.
- The separate **inventory Materials-icon** surface for these same materials is
  still owned by the icon/normalization sessions — out of scope here.
- No blockers. Both review stages clean; ledger valid (exit 0).

## Retrospective

### Lessons Learned

- **A green lab proves nothing for a PhaserBridge render change.** The harvest-lab
  is a 2D canvas that never touches PhaserBridge; only a real-scene e2e (or the
  running game) can verify the sprite render path. Named the real artifact in the
  observe-before-done note per ADR 0039.
- **`spawnHarvestableNode` silently defaulted `variantRoll` to 0**, which quietly
  made every multi-variant node pick art index 0 — a whole approved variant was
  dead. When adding a new render path that reads a `Sprite` store field, verify
  the spawner actually seeds it (grep the spawner, don't assume).
- **Seed cosmetic rolls from a LOCAL `SeededRandom`, never `world.rng`** — that is
  the pattern (`initializeEnemyAppearance`) that keeps an appearance roll
  gameplay-neutral and safe under the win-rate gate.
- **`sprites:approve` sorts the manifest; `main` is append-order** → always
  re-verify `git diff --numstat origin/main -- <manifest> <catalog>` shows `N 0`
  (zero deletions) before checkin. (Independently rediscovered again this session;
  the fix pattern lives in `2026-07-08-welcome-room-npcs.md` +
  `files/build-merged.cjs`.)

### Mistakes Made

- Started on a stale branch and briefly chased phantom manifest churn before
  recognizing it as a rebase-needed ordering mismatch — the additions-only
  `numstat` signal is the tell; check it _first_.

### Opportunities for Future Improvement

- A `sprites:checkin` preflight that canonicalizes manifest/catalog to an
  additions-only diff vs base would remove the recurring approve-vs-main churn
  loop for good (raised again in welcome-room-npcs).
- Consider a tiny guard/test asserting every `Sprite`-store field a render path
  reads is seeded by its spawner, so a future "defaulted to 0" dead-variant bug
  is caught deterministically.

## Branch state

- Branch: `nalfeo-consumable-icon-art` (== `origin/main` + this work; the branch
  name predates the scope narrowing to harvestable nodes).
- Commits:
  - `feat(engine): render Floor-1 harvestable nodes as generated sprites` (`fe86e240`)
  - `fix(core): seed harvestable node variantRoll + harden render tests` (`7bab4dbf`)
- PR: pending create (combined; full 3🍎 review ledger recorded + validated).
- Rebased twice during the session as `origin/main` advanced: first onto
  `d7337301`, then onto `ff73b679` (picking up #903 "Floor 2 runtime parity" and
  #907 welcome-room NPC sprite wiring). The 5 rebase conflicts were all
  independent-addition collisions between #907's NPC render wiring and this
  work's harvestable wiring (imports, `sprite-kind.ts` functions, the probe-lab
  interface, and two test files where git collapsed adjacent NPC + harvestable
  `it`/`describe` blocks) — resolved by keeping BOTH sides. A pre-rebase local
  headless run showed `floor2-completion` timing out; that was a **stale-branch
  artifact** — the branch was running pre-#903 Floor-2 code. This change is
  gameplay-neutral (local RNG only, never `world.rng`) and cannot perturb Floor
  2; the authoritative re-confirmation is the CI headless Floor-1 gate on the PR
  (a local post-rebase headless re-run was also kicked off to sanity-check).
