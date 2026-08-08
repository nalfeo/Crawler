# Session Handoff: Welcome-room art-wiring (custom→catalog) + engine-backed set-piece lab

## Date

2026-07-08

## Persona

Producer → Sprite/Rendering + Labs

## Systems touched

mapgen, devtools, sprite-pipeline

## Apples

3🍎 estimated (rescored from 4🍎 — parent feature merged in #853), 3🍎 actual. 📈 `over` at the session level: the 4🍎 was the whole set-piece feature; this follow-up PR is only a render-only ref swap + dev-only lab + tests.

## What Was Done

Follow-up to the merged welcome-room set piece (PR #853). Two deliverables:

1. **Art-wiring (render-only data).** In `src/shared/data/set-pieces.json`, swapped all 5 welcome-room base-layer props from `custom` placeholder refs → `catalog` refs pinning the exact shipped generated variant keys, so they render REAL generated art in-engine instead of labeled placeholder boxes: `welcome-rug`→`welcome-room-rug-var-0`, `welcome-desk`→`welcome-room-desk-var-0`, `shop-table`→`welcome-room-shop-table-var-0`, `broker-bookcase`→`welcome-room-bookcase-var-0`, `velvet-rope`→`welcome-room-velvet-rope-var-2` (velvet rope shipped as var-**2**; the rest var-0). Also **dropped the rug's `tintHex: "#7f1d1d"`** — the generated rug is already a worn red velvet runner, so multiplying the tint double-darkened it. This chose "option (a)" (ref-swap) over adding a `custom→generated` resolver branch, per the art session's recommendation, since all 5 assets are already approved+shipped on `main`.

2. **Engine-backed set-piece lab + UX (dev-only).** Rewrote `src/labs/set-piece-lab/index.ts` to render authored set pieces THROUGH the real engine (Phaser + `PhaserBridge` + baked terrain + generated-art resolution + depth layering) so the preview matches in-game exactly, instead of a bespoke 2D canvas. Then moved the info box from a floating overlay into a full-width scrollable **pane underneath** the rendered room, and added **hover tooltips**: hovering any prop layer or NPC shows its source asset (with a truthful "✔ real art / ▢ placeholder box" badge whose logic mirrors `resolveSetPieceSprite`) plus applied transforms (kind/z/layer, depth+band, size, scale, tint, offset; NPCs show frame#, objective anchor, tile, size).

**Observed in the real engine** (rule #10) at `http://localhost:10621/lab.html?lab=set-piece-lab` via Playwright — before: props drew as labeled placeholder boxes and the rug read as an over-dark maroon block; after: all 5 props resolve to real generated art with **zero placeholder rects**, the rug reads correct worn-red (not double-darkened), the info renders in the bottom pane, and hover tooltips report the correct asset key + transforms for every prop and NPC (grid-swept 17 hover points). The catalog resolution is the SAME path the game uses (`scene.textures.exists(spriteId)` on the bare manifest key), so this is not lab-only validation.

## Key Decisions Made

- **Option (a) ref-swap over a new resolver branch.** All 5 assets are shipped+approved, so pinning `catalog` refs to the bare variant keys is the minimal change. Trade-off: drops the `custom→placeholder` graceful-degradation fallback. Accepted intentionally — a louder failure (placeholder rect) surfaces asset regressions rather than masking them.
- **Rug tint dropped, not neutralized in the renderer.** The tint lived on the same `set-pieces.json` layer being swapped, so dropping it is atomic with the ref swap; the other 4 props were always untinted.
- **Manifest-side guard added (from plan review).** `tests/integration/generated-manifest-engine.test.ts` now asserts the 5 generated keys resolve to real (non-placeholder) entries in the checked-in manifest AND cross-checks that `set-pieces.json` still pins exactly those keys — a rename on either side now fails loudly.
- **Honest re-score 4🍎→3🍎.** Recorded in the review ledger with reason; the parent feature's engine/stamp/scenario/ADR work already merged, leaving this PR at medium tier.

## What's Next / Blockers

- **No blockers.** PR ready; art fully on `main`, so this PR alone lights up the room.
- **Follow-up (non-blocking):** the 3 welcome-room NPC sprites (`npc-welcome-goon`, `npc-sweaty-merchant`, `npc-spell-broker`, 1×1, POLISH) are generating in the F1 asset burndown session. They resolve via numeric `textureId` (all three currently share `textureId: 10`), so `generate-wiring` (enemies-only) will NOT auto-wire them. Once the 3 keys land on `main`, do a separate `textureId → generated key` swap so each NPC gets its distinct sprite. Coordinated with burndown session `cdb2b3a5-1fbd-4c33-afca-5232912acd7f`.
- **Deferred (plan-review concern #1, non-blocking):** `describeAsset` in the lab manually mirrors `resolveSetPieceSprite` and could drift. A future refactor could extract a shared resolver returning a structured resolution result consumed by both the engine and the lab.

## Retrospective

### Lessons Learned

- **`custom` → `catalog` is the whole wiring story for generated set-piece art.** Generated sprites preload as individual textures keyed by the **bare manifest key** (e.g. `welcome-room-rug-var-0`), and `PhaserBridge.resolveSetPieceSprite`'s catalog branch resolves via `scene.textures.exists(spriteId)`. So pointing a `catalog` ref's `spriteId` at the bare key needs zero new code. `generate-wiring` has no set-piece awareness (only `mobDefs` spriteId + enemy renderKind pins), so set-piece art wiring is always a manual `set-pieces.json` edit.
- **Watch for double-tint on generated art.** If a placeholder layer carried a `tintHex` to fake a color, drop it when swapping to already-colored generated art or the renderer multiplies it and darkens the sprite.
- **Lab-as-engine-diorama is high-signal.** Booting `PhaserBridge` + baked terrain in the lab made "observe before done" trivial and truthful — the preview IS the game render path, not an approximation. The hover-tooltip badge mirroring the resolver makes real-vs-placeholder visually auditable.

### Mistakes Made

- **lint-staged partial-staging conflict (repeat gotcha).** Staging some files while leaving others unstaged, then letting the prettier pre-commit hook reformat staged files, made the hook's stash-restore conflict and left `UU` test files + dangling `pre-commit-format-stash` entries. Early signal: the commit "succeeds" but `git status` shows unmerged paths. **Avoidance that worked:** run `npx prettier --write <changed files>` on the whole set FIRST so the hook finds nothing to reformat, then stage + commit. To recover: take the prettier-wrapped "Updated upstream" side, `git reset` to clear the index, re-format, re-commit with `git commit -q -F <msgfile>` (PowerShell has no heredoc — write the message to a temp file).
- **Initial instinct to re-observe only in the lab.** The lab force-renders the set piece, so a green lab can't prove the _game_ resolves the art. Corrected by confirming the lab uses the real `PhaserBridge` catalog path (same `scene.textures.exists` call the game uses) and pinning it with the manifest-side integration guard, rather than treating the lab screenshot as sufficient.

### Opportunities for Future Improvement

- **Extract a shared set-piece sprite resolver** (plan-review concern #1) so the lab tooltip badge and `PhaserBridge` cannot drift.
- **Teach `generate-wiring` about set pieces** — emit `set-pieces.json` `custom→catalog` patches when a matching generated key lands, so future set-piece art wiring is automatic like `mobDefs`.
- **Distinct NPC textureIds.** The 3 welcome NPCs sharing `textureId: 10` renders them as identical villagers; the pending NPC sprites + a `textureId→generated` swap will fix this once art lands.
