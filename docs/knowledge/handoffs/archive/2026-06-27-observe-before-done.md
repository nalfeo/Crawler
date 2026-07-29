# Session Handoff: Observe-before-done discipline (personas + AGENTS.md)

## Date

2026-06-27

## Persona(s) adopted

**Producer** — this was a docs/governance change touching three specialist
personas plus the root `AGENTS.md` rule list, so the coordinating persona owned
the through-line rather than any single specialist.

## Routing verdict

✅ right persona — cross-cutting docs edit spanning multiple persona files is
squarely Producer territory.

## Apples

Estimated: 🍎 x 1 <!-- declared before work began -->
Actual: 🍎 x 1
Verdict: 🎯 Exact — single-purpose docs edit across four files, no code or tests.

Hello kitties: 1/5 = 0.20 🎀

## What Was Done

Fix #1 of the 4-part "still broken loop" retrospective initiative. The retro found
the dominant cause of human intervention was agents patching a **visual/runtime**
bug by reading the code/diff instead of reproducing it in the running game/lab and
re-observing after the fix (ghost-sword trails, movement-lab crashes, "still
blurry", "still text squares"). Pure-logic PRs rarely bounced because deterministic
gates already catch those — the gap is visual/runtime observation.

Added a concise, mandatory **Observe Before Done** discipline:

- `docs/agent-os/personas/game-designer.md` — new `## Observe Before Done` section
  (mechanic-voice).
- `docs/agent-os/personas/ux-designer.md` — new `## Observe Before Done` section
  (HUD/menu/control-voice).
- `docs/agent-os/personas/graphics-designer.md` — new `## Observe Before Done`
  section (sprite/effect-voice; explicitly distinct from the sprite-pipeline
  sensors, covers live in-game rendering).
- `AGENTS.md` — new rule **#10** in the `## Rules` numbered list.

Each instance states the same two-part rule: (1) reproduce the old/broken behavior
in the running artifact (lab via `npm run lab` `?lab=<name>` or game via
`npm run dev`), capture it (screenshot / `tests/e2e/helpers/ui-probe.ts` probe /
headless `RunStats`), then re-observe after the fix and record before/after in the
PR/handoff; (2) prefer promoting a recurring visual-bug class into a
**deterministic** check (`tests/e2e/helpers/pixels.ts` / `ui-probe.ts`, see
`tests/e2e/hud-overlap-visual.test.ts`; or a headless assertion, see
`tests/headless/floor1-completion.test.ts`) — deterministic only, never
LLM-as-judge in CI.

## What's Next

Remaining fixes from the same retrospective (owned by sibling sub-sessions): the
reviewer persona, the policy doc, and the test-helper/probe work. This PR
intentionally does **not** touch `reviewer.md`, any policy doc, or any test file.

## Blockers

None.

## Branch State

- Branch: `nalfeo-observe-before-done-discipline`
- All tests passing: yes
- PR created: yes (see PR link in session)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — no telemetry section.

## Test Results

`npm run verify:fast` → ✅ passed (typecheck + lint + unit).

`npm run verify` → ✅ Full verification passed:

- Step 1-2/8 Typecheck + Lint: pass
- Step 3/8 Format check: pass
- Step 4/8 Dead code detection: pass (pre-existing unused-file warnings only)
- Step 5/8 Unit tests w/ coverage: **197 files, 2253 tests passed**
- Step 6/8 Integration tests: **49 passed, 1 skipped**
- Step 7/8 Headless Floor 1 gate: **68 passed**
- Step 8/8 Build: pass

## Key Decisions Made

- Documented the discipline per-persona in each file's own voice (rather than a
  single shared link) so the mandate is unmissable wherever an agent lands.
- Kept the AGENTS.md addition to exactly one numbered rule (#10) per the task
  scope, with both the reproduce/re-observe mandate and the
  deterministic-check preference folded into it.
