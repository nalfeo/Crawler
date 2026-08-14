# Session Handoff: Honest set-piece-lab readiness gate for reliable cold-cache visual-review capture

## Date

2026-07-08

## Persona

Producer → Tooling/Infra (visual-review harness reliability)

## Systems touched

devtools, ci-policy

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact — self-contained lab + review-tooling reliability fix; the cold-cache timing reasoning and a Windows harness-invocation gotcha kept it firmly at 3).

## What Was Done

Fixed a flaky, cold-cache-only bug in the headless visual-review harness: it sometimes
screenshotted the set-piece lab's welcome-room **before** its generated art finished
loading, capturing villager-fallback NPCs + grey placeholder Rectangles (~199KB PNG)
instead of the real room (~376–460KB PNG). This is a **harness/capture-timing** bug only —
the game and lab render correctly; **no gameplay changed**.

Root cause: the lab flipped `window.__uiProbe.ready()` true on mere completion of the
sprite-warm promise, even when that first `PhaserBridge.sync()` had drawn placeholders
(textures not yet resident on a cold cache). The review agent already gates screenshots on
`waitForFunction(() => __uiProbe.ready() === true)`, but the gate was defeated because
`ready()` lied.

The fix makes the readiness signal **honest** so the agent's existing gate works — without
touching the agent or any shared renderer file:

- New pure helper `src/labs/set-piece-lab/readiness.ts` → `isSetPieceRenderReady(counts)`:
  ready iff `imageCount > 0` **and** `placeholderRectCount === 0` **and**
  `resolvedNpcKeyCount >= requiredNpcKeyCount`.
- `src/labs/set-piece-lab/index.ts` recomputes those counts by walking
  `this.children.list` **after every `bridge.sync()`** (first sync in `create()` + every
  `update()` frame), so a later sync that upgrades a placeholder Rectangle → real Image (and
  villager sprite → pinned generated NPC key) flips `ready` true honestly. `labReady` /
  `__setPieceScene` reset in all three lifecycle sites (create defensive reset, shutdown
  handler, teardown closure). Added `resolveInitialSetPieceId` so `?piece=welcome-room`
  deep-links the piece (single scene, single warm, no dropdown restart).
- New review setup `scripts/agent/review/setup/set-piece-welcome-room.js`: hides lab chrome,
  expands the canvas, and polls `__uiProbe.ready()` + a type-based display-list re-check
  (0 Rectangles + ≥1 Image) with a 45s deadline + 1s settle.
- `tests/unit/set-piece-lab-readiness.test.ts`: 7-case truth table for the pure helper.

**Observed in the real visual-review harness (rule #10), before → after:**

- **Before (broken):** cold-cache Playwright probe timeline —
  `t=2.3s` 14 placeholder Rectangles (ready honestly false), `t=3.4s` 5 rects,
  `t≈5.15s` **0 rects, 20 Images, all 3 pinned NPC keys resident → ready flips TRUE**.
  The old promise-completion gate could flip true at ~4.5s while rects were still on screen
  → agent wrote a ~199KB placeholder capture.
- **After (fixed):** ran the review agent **3× with a cold browser cache** (fresh
  `chromium.launch` + `newContext` each run) → **all three produced 450KB REAL-ART-PASS**
  captures (≥376KB, 0 placeholder rects), never a 199KB placeholder. The harmless native
  crash (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) fires **after** artifacts
  are written — exit code ignored per task; artifact + size are the check.

`npm run verify:fast` clean (7 tests, typecheck, lint).

## Key Decisions Made

- **Honest gate over a fixed warm delay.** Recompute readiness from the live display list
  after each sync rather than trusting a timer/promise — the only trustworthy signal is
  "what is actually on screen right now". The bridge self-heals placeholders on later syncs,
  so re-evaluation naturally converges to true.
- **Three-condition gate.** `imageCount>0` guards the pre-sync empty scene; `0 Rectangles`
  catches unresolved props generically; `resolvedNpcKeyCount>=required` catches villager
  fallbacks per-key (welcome-room pins 3 NPC keys; the gate matches exactly because
  `requiredNpcKeys` is built with the same `pickGeneratedNpcTextureKey` the bridge uses).
- **Kept the full-registry warm** (measured ~5s cold, acceptable) rather than subset-warming
  the current piece — deferred as a future optimization to avoid touching shared paths.
- **Strict file ownership honored:** did NOT touch `visual-review-agent.ts`, `PhaserBridge.ts`,
  `set-piece-types.ts`, `set-pieces.json`, or `stampSetPiece.ts` (parent concurrently owns
  set-piece rendering/sizing). The fix works purely through the existing `__uiProbe.ready()`
  contract.

## What's Next / Blockers

- No blockers. PR opened and armed with `gh pr merge --auto --squash`.
- **Future optimization (optional):** subset-warm only the current piece's ~9–15 textures for
  a sub-second cold load and zero partial-residency window.
- **Generality caveat (documented in `readiness.ts`):** the Rectangle-count gate assumes the
  standard set-piece placeholder path (unresolved prop → grey Rectangle). A future piece built
  from custom placeholder **Images** (`ref.placeholder`) would need the gate strengthened to
  track expected per-prop final textures. Welcome-room (the only reviewed surface) uses the
  Rectangle path, verified by the 14→0 cold-cache capture.

## Retrospective

### Lessons Learned

- **Windows `npm run … -- --url "…&…"` mangles `&`.** Passing a URL with `&` through the
  npm → cmd.exe hop splits the arg at `&`, silently dropping every subsequent flag
  (`--setup-file`, `--screenshot-name`, …). Fix: invoke the tsx/tool entry directly via
  `& node <script> @argsArray` with a splatted PowerShell array — native arg passing
  preserves `&`. Baked into the session's `run-review.ps1`.
- **A green lab ≠ a fixed harness.** The real proof was running the actual review agent 3×
  cold, not the lab in isolation — the lab always rendered correctly; only the harness's
  capture timing was wrong.
- **`npm run review:ledger` maps to `scripts/agent/review/cli.mjs`, not `ledger.mjs`.**
  `ledger.mjs` is the library module; invoking it directly with `stage`/`validate` args
  no-ops with **exit 0** (no write), which looks like success. Always drive the ledger through
  the `cli.mjs` entry (or `npm run review:ledger --`). Verify the on-disk `completed`/`clean`
  flags after staging — a 0 exit from the wrong entry is a false positive.

### Mistakes Made

- Filled the ledger against `scripts/agent/review/ledger.mjs` first; it exited 0 without
  writing, and a follow-up `validate` (same wrong entry) also exited 0 — a false green. Caught
  it only by re-reading the file from disk (`completed:false`). **Early signal:** if a ledger
  `stage` prints no `Updated <path>` line, it did not persist — check the npm-script → entry
  mapping in `package.json` before trusting the exit code.

### Opportunities for Future Improvement

- Consider a tiny `scripts/agent/review/ledger.mjs` guard that errors if invoked as a CLI
  ("use cli.mjs"), so the no-op-exit-0 trap can't bite the next agent.
- Promote the honest-ready pattern (recompute readiness from the post-sync display list) into
  a reusable lab helper if other engine-backed labs need cold-cache-safe review capture.
