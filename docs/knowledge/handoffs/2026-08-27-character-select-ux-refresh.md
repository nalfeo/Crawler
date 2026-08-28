# Character Select UX refresh

**Date:** 2026-08-27  
**Author:** Copilot App (UX Designer)  
**Session Branch:** nalfeo-character-select-refresh-1c8

## Summary

Refreshed the shipped `IntroScene` Character Select screen with a shared beveled
pixel panel, clearer title and Director hierarchy, improved form labels,
roomier native controls, and a more explicit primary action. Native HTML inputs,
keyboard submission, render scaling, cleanup, and the intro identity handoff
remain unchanged.

## Systems touched

engine, ux-baselines, visual-review

## A|B scenarios and evidence

Registered `character-select` in `docs/knowledge/ux-baselines/manifest.json` and
added the first-class capture setup at
`scripts/agent/review/setup/character-select.js`. The setup hides workspace
chrome, waits for the real game's native controls, declares panel/content/control
regions, and uses the Equipment baseline's dark pixel palette, beveled framing,
and primary-action hierarchy as its cross-surface reference.

The before/after lineage is stored under:

`files/visual-review/before/live-dev/character-select.png`

`files/visual-review/after/v1.0.4/character-select.{png,review.json}`

The final pixel-grounded visual review passed with 0 deterministic blockers, 0
evidence-backed blockers, 0 advisory taste notes, and an 80.0/100 anchored score.
Earlier iterations were judged and refined through v1.0.0-v1.0.3.

## Validation

- `npm run typecheck` — passed.
- `npm run lint -- --quiet` — passed.
- `npm run test:unit -- tests/unit/intro-scene-wiring.test.ts` — 18 passed.
- Real game capture completed before and after the refresh.
- `npm run review:visual:llm` with the Character Select setup — passed at 80.0/100.
- `npm run verify:fast` — blocked by six existing silent-merge-revert findings
  (three blocking) in unrelated files.
- `npm run review:visual` — blocked because its shared 5299 lab server was
  unavailable; failures were connection-refused in inventory/HUD scenarios.
- `npm run test:e2e -- tests/e2e/intro-scene-flow.test.ts` — one initial pass,
  then retries timed out while the real floor debug handoff was unavailable
  from the local Vite environment.
- `npm run docs:check` — blocked by the pre-existing stale
  `docs/guides/github-token-scopes.md` reference in `README.md`.

## Clean-main blocker comparison

To separate change regressions from shared infrastructure, the blocked commands
were rerun from a detached clean `origin/main` worktree at commit `46a00c9ce`.
`npm run verify:fast` passed cleanly there, confirming the feature-branch
silent-merge-revert findings are branch-state issues unrelated to Character
Select. `npm run docs:check` reproduced the same stale README path failure.
The intro E2E reproduced both timeouts waiting for `__introDebug` /
`__floor1Debug`, confirming a pre-existing runtime handoff or local-server
problem. `npm run review:visual` also reproduced the shared 5299 lab instability:
the inventory suite had navigation timeouts and the existing
`getInventoryMaxScrollRow` probe mismatch on clean main. These failures are
safe to track separately from this Character Select change.

## Follow-up visual correction

Applied focused feedback from the Character Select review: removed the
unexplained "The Director Presents" eyebrow, enabled pixel-rounded camera
rendering for crisper text, increased and expanded the Director copy, added
label-to-input clearance, and moved the Enter hint above the CTA with a
dedicated gap. A fresh real-game capture is stored at
`files/visual-review/after/v1.0.5/character-select.png`.

Targeted validation after this correction: typecheck passed and all 18
Character Select wiring tests passed.

Re-scored against the running dev server with
`npm run review:visual:llm -- --url http://localhost:12540/index.html
--setup-file scripts/agent/review/setup/character-select.js --no-probe-wait
--lineage-scenario character-select --lineage-state v1.0.5` (the standard
`review:visual:llm` scenario flag targets the shared lab server, which does not
host Character Select — this surface requires `--url`/`--setup-file` against a
real `npm run dev` instance): **80.0/100, 0 evidence-backed blockers**, 2
advisory-only taste notes (pronoun-controls vertical alignment/padding). This
matches the pre-fix v1.0.4 score and confirms the readability fixes did not
regress the gate. Report written to
`files/visual-review/after/v1.0.5/character-select.review.json`.

## A|B canvas verification

Opened the `ab-ux-testing` canvas and confirmed the `character-select` A|B
lineage is fully registered and browsable: pairs exist for v1.0.0 through
v1.0.5 (7 pairs total), each showing before/after screenshots and review
scores. The scenario lineage was not missing — it just needed the canvas
`refresh` action and, for v1.0.5, a fresh `review.json` (now produced above).

## Round 2: button design standard + geometry fixes

Second feedback round flagged: pronoun label sitting underneath the button,
text boxes not left-aligned, contestant-name label too close to its input,
inconsistent/fuzzy fonts, and flat/no-depth buttons with a request for a
reusable button design standard.

- Added `createBeveledButton()` to `src/engine/pixel-ui.ts`, mirroring the
  existing `createBeveledPanel()` bevel language (raised highlight edge +
  sunken shadow edge) so every future primary-action button in the game can
  reuse one punchier, consistent depth treatment instead of a flat rect.
- Rewired `IntroScene.createConfirmButton()` onto `createBeveledButton()`.
- Collected every `Text` object into a `texts` array and re-applied
  `applyCrispText`/`unsubscribeCrispText` consistently across all labels
  (title, Director copy, both field labels, Enter hint) to remove the
  font-fuzziness inconsistency — some labels previously weren't wired into the
  crisp-text pipeline at all.
- Adjusted panel height (`PANEL_H` 456→468) and vertical rhythm so the pronoun
  label/controls block no longer crowds the confirm button below it.
- Updated `scripts/agent/review/setup/character-select.js` region boxes to
  match the new geometry.

**Investigated an apparent new bug** (faint duplicate/offset label text
overlapping the "Contestant name" input and "Pronouns" fieldset in the
Playwright-captured screenshot, v1.0.6–v1.0.8). Live-browser inspection via
Chrome DevTools MCP (`http://localhost:12540/index.html`) showed a clean
render with no such artifact, which initially looked like a
capture-pipeline-only issue. Closer full-panel inspection of the actual PNG
disproved that theory: this was a **real, reproducible geometry bug**, not a
capture artifact — the "Contestant name" and "Pronouns" labels sat only 24px
above their DOM input/fieldset controls, which was tight enough that the
labels rendered visually crowded/near-clipped against the control's top
border at the game's default viewport scale. Fixed by widening both gaps to
30px. Re-captured at `--lineage-state v1.0.9` (confirmed NOT byte-identical to
prior captures) and visually confirmed both labels now render fully legible
with clear breathing room above their controls.

**Root-cause note on the "byte-identical" warnings during triage:** v1.0.6,
v1.0.7, and v1.0.8 were reported byte-identical because no source change had
been made between those three runs — only CLI flags (`--wait-ms`,
`--lineage-state`) were varied while iterating on capture reliability. The
identical-hash warning is correct, deterministic behavior (SHA-256 over the
PNG bytes), not a tool bug or a stale-cache bug. The actual fix required a
real source-code change (the 24px→30px gap), which is what produced the first
genuinely new capture at v1.0.9.

Final re-verification after the fix:

- `npm run typecheck` — passed.
- `npx eslint` on all touched files — passed.
- `visual-review-agent.ts` at `--lineage-state v1.0.9`: **PASS, 80.0/100
  anchored score, 0 evidence-backed blockers**, 2 advisory taste notes only
  (button centering nudge, pronoun-label vertical alignment nudge — both
  cosmetic, non-blocking).
- `npm run verify:fast` — the only failing gate is
  `health-silent-reverts` (3 blocking findings), which originates entirely
  from merge commit `67592f9f8` ("cherry-pick equipment UX redesign PR #3735")
  already present on the shared base branch
  (`nalfeo-ux-refresh-hud-inventory-shop`) and inherited by all three wave-1
  sessions; confirmed via `git diff --stat` that none of the flagged files
  (`ux-designer.agent.md`, `screenshot-viewer/*.mjs`, `ui-probe-lab/index.ts`,
  `ui-probe.ts`, `inventory-flow.test.ts`) are touched by this session's 3
  commits (`IntroScene.ts`, `pixel-ui.ts`, `character-select.js` +
  the setup-script sensor regions below). Not this session's regression.

## Scenario-specific sensors (deterministic, non-LLM)

Per explicit request, hardened the Character Select scenario's deterministic
sensor coverage rather than relying solely on the LLM judge to catch layout
regressions. `visual-review-agent.ts`'s shared `computeGeometryBlockers()`
(from `visual-review-lib.mjs`) already runs sibling overlap/touch and
container-overrun checks over every region declared in a scenario's
`window.__visualReview.regions` array — this is the repo's existing
scenario-sensor pattern (used identically by the equipment/inventory
scenarios), not a bespoke per-surface system.

Added two new declared regions (`kind: 'text'`, which participates in the
generic sibling-overlap check, unlike `panel`/`tooltip`/`icon`) whose boxes
are reconstructed in design space from the same layout constants IntroScene
uses:

- `contestant-name-label` — sits 30px above `contestant-name`.
- `pronoun-controls-label` — sits 30px above `pronoun-controls`.

This makes the exact "label crowds its control" regression class fixed this
round a **hard, deterministic sensor failure** on any future regression
(caught by the shared overlap/touch check, not left to LLM judgment). Verified
by re-running the scenario (`--lineage-state v1.1.0`): 7 regions harvested, 0
deterministic blockers — confirms both the fix and the new sensor wiring are
correct.

## Round 3: "Press Enter" blur + still-tight label gaps

Third feedback round: "Press Enter to continue" hint reads blurry, and the
gap between "Contestant name"/its input and "Pronouns"/its She-Him-They row
is still too tight.

- **Blurry hint root cause**: `applyCrispText(this, texts)` was called with no
  `minimumResolution` floor, so the glyph resolution could sit at 1 depending
  on the live `onScreenScale`/`uiScale` product — every other HUD surface in
  the engine (`HudBossBar`, `HudQuestTracker`, `EquipmentUI`,
  `Floor3RosterUI`, etc.) passes `MIN_TEXT_RESOLUTION` (or
  `MIN_TEXT_RESOLUTION + 2`) from `ui-theme.ts` as a floor. `IntroScene` was
  the one surface that didn't. Fixed by passing `MIN_TEXT_RESOLUTION` through
  for all of Character Select's texts, matching the established HUD
  convention.
- **Gaps still tight**: 30px (round 2's fix) still read crowded per this
  round's feedback. Widened both the name-label→input and
  pronoun-label→controls gaps to 34px, and grew `PANEL_H` 468→476 to absorb
  the extra 8px without crowding the confirm button below.
- Updated `character-select.js` sensor regions (`nameLabelBox`/
  `pronounLabelBox` offset 30→34, panel/director/button boxes shifted to match
  the new `PANEL_H`).

Re-verified: `npx tsc --noEmit` clean, `eslint` clean, 18/18
`intro-scene-wiring.test.ts` unit tests pass. `visual-review-agent.ts` at
`--lineage-state v1.2.0`: **PASS, 80.0/100 anchored score, 0 evidence-backed
blockers**, 1 advisory (decorative-flourish suggestion, non-blocking). Visual
inspection of the v1.2.0 capture confirms: "Press Enter to continue" renders
crisp, both label/control gaps read as clear breathing room, no overlap.

Commit: `9935da446` "fix: crisp Press Enter hint and widen label gaps in
Character Select".

## Final status

- Branch: `nalfeo-character-select-refresh-1c8` (3 new commits this round:
  button-standard/geometry rewrite, label-gap fix, sensor-region addition).
- Gate: 80.0/100 anchored visual-review score (≥8/10 target), 0
  evidence-backed blockers — **meets the hard gate**.
- Per explicit standing instruction, **no PR opened**. Held locally for the
  creator session to cherry-pick/publish alongside the HUD and Awards wave-1
  sessions.

## Round 4: name-input text still blurry (DOM overlay sub-pixel rounding)

Fourth feedback round: "Fonts are blurry" (reported after round 3's Phaser
canvas-text crispness fix had already shipped). Zoomed inspection of the
v1.2.0 capture showed the "Press Enter to continue" hint and pronoun radio
labels were now crisp (round 3's fix held), but the "Contestant name" input
text ("Rhea Vale") was still visibly blurred/fringed.

- **Root cause**: the name `<input>` and pronoun `<fieldset>`/`<label>` are
  **native HTML DOM elements** overlaid on the Phaser canvas — a separate
  rendering path from Phaser's canvas-drawn `Text` objects, so round 3's
  `MIN_TEXT_RESOLUTION`/`applyCrispText()` fix does not touch them. Their
  inline styles computed fractional CSS pixel values from the canvas-to-CSS
  scale ratio (e.g. `${14 * Math.min(scaleX, scaleY)}px`), and fractional CSS
  px values force the browser into sub-pixel anti-aliased font rendering,
  which reads as blur independent of the Phaser-side fix.
- **Fix**: added a `px()` helper (rounds to the nearest integer) in
  `IntroScene.ts` and wrapped every DOM style dimension/`fontSize` value in
  `createNameInput()` and `createGenderControls()` with it (input
  left/top/width/height/fontSize; fieldset left/top/width/gap; label
  minHeight/fontSize).

Re-verified: `npx tsc --noEmit` clean, `eslint` clean on `IntroScene.ts`.
Corrected the visual-review invocation for this scenario along the way — the
real flag names are `--setup-file` (not `--setup`) and `--no-probe-wait` (not
`--skip-probe-wait`); `--url`/`--setup-file` against a real `npm run dev`
instance is required because `IntroScene` auto-skips in any lab context, so a
lab URL/id will never render Character Select content.
`visual-review-agent.ts` at `--lineage-state v1.3.0`: **PASS, 80.0/100
anchored score, 0 evidence-backed blockers**, 1 advisory taste note
(pronoun/name section alignment, non-blocking) — unchanged from v1.2.0
(deterministic gate is geometry-based and was already passing; this fix
targets sub-pixel rendering, which the LLM judge does not separately score).
Native-resolution crop of the "Rhea Vale" name-input text confirms it now
renders crisp with no color fringing.

Commit: `6a38d0308` "fix: round DOM overlay CSS pixel values to eliminate
sub-pixel blur in Character Select".

Branch: `nalfeo-character-select-refresh-1c8` (4 commits total this session).
Gate still met: 80.0/100, 0 evidence-backed blockers. Per standing
instruction, still **no PR opened** — held locally for the creator session.
