# Session Handoff: Welcome-room no-stretch rendering + art-defect judge + collision-golden re-pin

## Date

2026-07-08

## Persona

Producer → Sprite/Rendering + Labs + Agent-tooling

## Systems touched

mapgen, devtools, sprite-pipeline, sprite-workflow, ci-policy

## Apples

4🍎 estimated, 4🍎 actual (delta 0, verdict `exact`). Metric:
`docs/knowledge/metrics/apples/2026-07-08-welcome-room-art-defects-no-stretch.json`.

## What Was Done

Follow-up to the merged welcome-room set-piece arc (#853 → #905 → #907 → #916)
that fixes the visual defects the maintainer called out ("oddly stretched
sprites, welcome banner not on the wall, wall sconces on the ground / wrong
orientation, cut-off sprites") and hardens the art-review judge so those
classes are caught deterministically going forward. Five parts:

1. **No-stretch rendering (engine + shared + core).** A set-piece tile can no
   longer stretch to fill its slot. Added feet-based sizing, a placement anchor,
   and per-layer flip flags to the set-piece schema
   (`29b77eaf`, `src/shared/data/set-piece-types.ts` + friends); the core stamp
   now emits feet-sized, per-layer offset/flipped, placement-origin-anchored
   layers (`7677075e`, `src/core/map/stampSetPiece.ts`); the engine renders each
   sprite **contain-fit** (letterboxed to its native aspect, never stretched) and
   honors the flip flags (`14d49f60`, `PhaserBridge`). Result: every welcome-room
   prop keeps its native aspect ratio at its authored real-world footprint.

2. **Content retune + honest placeholders (data-only).** Retuned the
   welcome-room layout to the maintainer-approved spacing and re-anchored props
   to the wall/floor correctly; queued the Kenney-sourced decor as **custom
   placeholder** refs in the asset request queue rather than shipping borrowed art
   as if final (`4ce1027b`, `src/shared/data/set-pieces.json`).

3. **Art-review judge hardening + regen ledger + evidence corpus** (`3ed52cc0`,
   `2d234795`, `scripts/agent/review/*`, `src/game/**` judge helpers). The visual
   judge now critiques relative scale / oversized-vs-neighbors and stretch, keeps
   an **alias-aware regen ledger** so a piece flagged "needs regen" is NOT
   re-critiqued until it's replaced (or the ledger is cleared), and stores
   GOOD/BAD image evidence as a training corpus. Load path is **fail-closed**
   (a corrupt/unreadable ledger suppresses nothing silently → surfaces loudly)
   and suppression is **cross-array** (a key queued in either the regen list or
   the queued-asset list is suppressed once, not double-counted).

4. **Readiness gate accepts intentional placeholders** (`d268506d`,
   `src/labs/set-piece-lab/readiness.ts`). The lab's `__uiProbe.ready()` gate
   treats persistent **intentional** custom placeholders (e.g. the queued Kenney
   decor) as a ready state, while still holding FALSE for transient
   pre-preload placeholder rects — so cold-cache visual-review captures wait for
   real art instead of flaking on the ~199KB placeholder frame.

5. **Collision-parity golden re-pin (this segment, `7423e2a3`).** The NPC
   reposition in (2) shifts the 3 quest NPCs' Size-backed collision footprints,
   deterministically drifting the `collision-pair-parity` fingerprints for
   seeds 13/42/137 (seed 7 unchanged). Re-pinned with a documented provenance
   block; **maintainer-authorized** re-pin (not forbidden golden-bumping — see
   Key Decisions).

## Observed (rule #10 — real artifact, not lab-only)

- **Rendered welcome room, real pipeline:** `files/visual-review/welcome-room-r8-2026-07-08T20-58-51-044Z.png`
  (+ `.review.json`, score 2.0/5). Before→after across r1–r8 shows the fix:
  stretch is **gone** (contain-fit), props sit at native aspect, the queued
  decor renders as honest gray placeholder boxes (not borrowed art masquerading
  as final), wall sconces read as wall fixtures, and the 3 NPCs render as 3
  distinct generated sprites. The residual 2.0 score is prop **layout** polish
  (rug/table overlap, banner alignment, small potion icons) — the maintainer's
  set-piece sizing/layout domain, tracked as follow-up, independent of the
  no-stretch fix which is the shipped defect class.
- **Cold-cache capture reliability:** a sibling session proved `ready()` stays
  FALSE while placeholder rects are on screen and flips TRUE only when all 3
  pinned NPC keys are resident (3/3 cold captures = 450KB real-art, never the
  ~199KB placeholder). See `2026-07-08-set-piece-lab-honest-ready.md`.

## Verification run

- `npx vitest run --project headless tests/headless/collision-pair-parity.test.ts`
  → **5/5 green** after the re-pin; new fingerprints verified **stable across
  two back-to-back runs**.
- `npm run verify:fast` → **passed** (typecheck + lint + changed unit + Size/Weight
  coverage).
- `npm run verify:pr-prereqs` → review-ledger **valid 4-apple**; handoff (this
  file) satisfies pr-preflight; guard-telemetry capture staged.
- `VERIFY_FULL=1 npm run verify` was run earlier and surfaced the collision
  drift (now re-pinned) **and** a `floor1-completion` wall-time perf failure —
  see Blockers: that perf failure is a confirmed **environmental flake**, not a
  regression. All win-rate tests passed.

## Key Decisions Made

- **Contain-fit, never stretch.** "No tile ever stretches" is enforced at the
  renderer (letterbox to native aspect) so a mis-authored footprint degrades to
  padding, not distortion. Feet-based sizing gives props a real-world footprint
  independent of source-image pixel dimensions.
- **Queue borrowed art, don't ship it as final.** Kenney decor is queued as
  `custom` placeholders in the asset request queue; the room ships with honest
  gray boxes for those slots until bespoke art lands. A louder placeholder
  surfaces the gap rather than masking it.
- **Judge keeps a regen ledger and does NOT re-critique flagged pieces.** Per the
  maintainer: once a piece is marked needs-regen, stop re-critiquing it until
  it's replaced. Load is fail-closed and suppression is cross-array so a bad
  ledger can't silently hide real defects or double-suppress.
- **Collision-golden re-pin is authorized, not a shortcut (Rule #12/#13).** It is
  data-only (`4ce1027b` = `set-pieces.json` only), bisected (passes 5/5 at
  pre-retune `7677075e` with all structural stamp/feet/contain-fit changes
  present; drifts only once NPC **tiles** move → props are render-only /
  non-perturbing), deterministic + stable ×2, outcomes stay same-shape
  (`outcome:timeout` @ 1500 frames on a parity slice), and the win-rate sweep
  stays green. This is the documented re-pin protocol the test file already
  follows, and the maintainer explicitly approved it.

## What's Next / Blockers

- **No merge blockers.** Ready for PR + auto-merge.
- **Perf-guard flake (do NOT treat as blocking).** `floor1-completion`'s
  wall-time guard failed under local machine contention: a **different seed each
  run** (seed 2 bow @156s, then seed 6 baseball-bat @213s), absolute frame times
  ballooning to ~13ms/frame (normal headless is <1ms/frame) while every win-rate
  assertion passed. It's a coarse blowup guard, not an SLA, and CI enforces it on
  a clean runner where headless has ~5–10× budget headroom. My changes add ~10
  **static** render-only props to the START room (not combat rooms) + move 3
  existing NPCs, which cannot plausibly add 60–100% wall time.
- **Branch not rebased onto latest `origin/main`.** Merge-base is `2969daf9`;
  `origin/main` has advanced to `aabff536` (includes the asset-rename/normalize
  PR the maintainer flagged). No conflict expected in touched files (verified in
  a prior segment), but confirm at PR time if CI flags a merge conflict.
- **Follow-up (non-blocking): prop layout polish.** The residual 2.0 visual score
  is rug/table overlap + banner alignment + small potion-icon scale — set-piece
  sizing/layout tuning in `set-pieces.json`, independent of the no-stretch fix.
- **Deferred (P5, non-blocking): deterministic sconce-on-wall invariant test.**
  A headless assertion that every wall-sconce prop resolves to a wall-adjacent
  tile with correct orientation — larger than this session's scope; promote the
  recurring "fixture on the floor" defect class into a deterministic guard next.

## Retrospective

### Lessons Learned

- **Contain-fit is the honest failure mode for authored footprints.** Letterbox,
  don't stretch: a wrong size becomes visible padding (auditable) instead of a
  distorted sprite (which reads as "the art is bad").
- **A regen ledger must be fail-closed and alias-aware.** Silent suppression on a
  bad ledger is worse than no ledger — it hides real defects. Fail-closed +
  cross-array suppression keyed by canonical alias is the safe shape.
- **Data-only NPC repositions drift determinism goldens; props don't.** Only the
  Size-backed collision entities (the 3 NPCs) perturb the collision fingerprint;
  render-only set-piece props (`world.setPieceProps`) consume no entity ids.
  Bisecting to "structural changes present but goldens stable, drift appears only
  when NPC tiles move" is the clean proof that a re-pin is benign.

### Mistakes Made

- **Ran the full headless gate on a contended local box.** The wall-time perf
  guard flaked twice (different seeds), costing ~30 min of confusing signal
  before I confirmed it was environmental. Per repo policy the ~306s headless
  gate is CI's job — run it locally only when a change plausibly affects per-frame
  cost, which render-only START-room props do not.

### Opportunities for Future Improvement

- **Promote sconce-on-wall / fixture-orientation into a deterministic check**
  (P5) so the "fixture sitting on the floor" defect class is caught headlessly,
  not by eyeball.
- **Extract prop-layout constraints (overlap / min-spacing) into the stamp**
  so authored layouts self-validate at stamp time rather than being caught in
  visual review.
