# Session Handoff: Inventory + Mobile e2e / Visual-Regression Coverage (PR Group D · Item 18)

## Date

2026-06-24

## Persona(s) adopted

**QA / Test Engineer.** PR Group D is explicitly scoped test & coverage
hardening — adding automated regression coverage with zero human-QA in the
loop. No multi-layer design work, so Producer routing was unnecessary.

## Routing verdict

✅ right persona — QA owns automated e2e/visual-regression coverage and the
"make pre-existing failures honest" mandate (AGENTS rule #8).

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 📈 Over — the inventory/mobile harness uncovered a **real production
mobile bug** (minimap overlay close button untappable) plus **three e2e
infra defects** (Windows Vite spawn, parallel-worker render flakes, Vite
optimize-deps reload race) that had to be fixed to get an honestly-green
suite. Pure test authoring would have been ~2.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

enemies, inventory, mobile-ux

## What Was Done

This is the third and final PR of **PR Group D — Test & coverage hardening**.
All three items shipped as independent PRs:

| Item | Scope                                                                                                                                                                                                                 | PR      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 7    | `enemyAISystem.ts` coverage (handoff figure was stale; already ~91% lines / 72% branches). Added `tests/game/enemy-ai-coverage.test.ts` for thin branches and raised the per-file vitest thresholds to lock in gains. | #284    |
| 9    | Confirmed the 3 sprite/judge integration tests are honestly green (deterministic mocks, no external VLM/image providers) and promoted the integration project from `ci-advisory` to a **blocking** CI gate.           | #285    |
| 18   | Automated inventory + mobile e2e/visual-regression coverage (this branch).                                                                                                                                            | this PR |

### Item 18 details

**(a) Inventory flow** — `tests/e2e/inventory-flow.test.ts` (5 tests):

- generated item sprite actually renders (magenta `0xff2fd0` pixel probe
  inside the inventory cell region),
- tooltip shows on hover and clears on hover-out,
- tooltip pins on click and unpins on second click,
- the Gear button opens the paper-doll equipment screen,
- the merchant's charm grants **+1 Charisma** when equipped.

**(b) Mobile tap-targets** — `tests/e2e/mobile-hit-targets.test.ts`
(`describe.each` over **portrait 390×844** and **landscape 844×390**):

- fullscreen-minimap close button ≥ 44px (design space) **and** a functional
  tap actually closes the overlay,
- level-up +/- controls ≥ 30px **and** tapping +/− changes the draft
  allocation.

**Harness / infra:**

- New lab `src/labs/ui-probe-lab/` mounts the four real engine UIs
  (Inventory, Equipment, HudMinimap overlay, LevelUp) over a synthetic
  `safe_room` world and exposes a typed `window.__uiProbe`. These UIs render
  to Phaser WebGL (no DOM nodes), so the probe is how Playwright drives them.
- Read-only test affordances added to `InventoryUI` / `HudMinimap` /
  `LevelUpUI` / `ui-scale` (shared `ScreenBounds` type) returning canvas
  hit-target bounds and tooltip/draft state. No behavioural change.
- `tests/e2e/helpers/ui-probe.ts`: typed probe wrappers, FIT-aware
  design→screen geometry, and a robust lab loader (`goto(commit)` + bounded
  `waitForFunction(__uiProbe.ready())` retry) that tolerates Vite's one-off
  optimize-deps page reload.
- `tests/game/merchant-charm-charisma.test.ts`: unit + fast-check property
  for the charm +1 Charisma logic (built with `createTestWorld()`).

### Real bug fixed (bundled, called out for reviewers)

**Mobile minimap overlay close button was untappable.** On small screens the
responsive `uiScale` (up to 2.5×) inflates the close button so its centre
dips below the viewport line into the map pan/drag zone
(`viewportHitArea`, depth `HUD_DEPTH+3`). The close button bg sat at `+2` and
the label at `+3`, so with Phaser's default `topOnly` input the pan-zone
swallowed the tap — the overlay could not be closed on mobile. Desktop
(`uiScale` 1) kept the button above the zone, so it only repro'd on phones.
Fix: raise close bg → `+7`, label → `+8`. Both are hidden unless the overlay
is open, so docked-radar ordering is unchanged. Committed separately as a
`fix(minimap):` commit.

### e2e infra defects fixed

1. **Windows Vite spawn** — `global-setup.ts` spawned `node_modules/.bin/vite`
   (a shell shim) → ENOENT under `spawn`. Now spawns
   `process.execPath node_modules/vite/bin/vite.js`.
2. **Parallel-worker flakes** — multiple Chromium workers against one shared
   lab server broke `networkidle`/render-under-load. Set
   `fileParallelism: false` on the vitest e2e project.
3. **Loader robustness** — replaced brittle `networkidle`/`load` waits with
   the bounded `__uiProbe.ready()` poll described above.

## What's Next

PR Group D is complete pending merge of the three PRs. Follow-ups (optional):

- Once #284/#285/#this all merge, re-run `npm run verify` on `main` to confirm
  the combined state stays green.
- The `ui-probe-lab` could host additional inventory/equipment regression
  cases (drag-drop, tab switching) cheaply now that the harness exists.

## Blockers

None. All gates green locally.

## Branch State

- Branch: `test/inventory-mobile-e2e` (forked from `origin/main`)
- All tests passing: **yes** — full `npm run verify` green (unit+coverage,
  integration 24✓/1 skip, headless Floor-1 4✓, build) + full e2e suite 14/14
  on a cold Vite cache.
- PR created: yes (this branch) — see PR link in the session report.

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 2,
  "guards": {
    "pr-preflight": {
      "deny": 1,
      "allow": 1
    }
  },
  "tools": {
    "create_pull_request": 2
  }
}
```

The single `pr-preflight` deny was the expected handoff-gate firing before
this handoff existed; the subsequent allow followed once it was written.

## Test Results

- `npm run verify` → **✅ Full verification passed** (typecheck, lint, format,
  knip, unit+coverage, integration, headless Floor-1 gate, build).
- `npm run test:e2e` → **14/14 pass on a cold `.vite` cache** (5 existing
  minimap-overlay + 5 inventory-flow + 4 mobile-hit-targets).
- `scripts/agent/lab-gate-check.sh` → pass (every `src/core/systems` system has
  a lab; the new `ui-probe-lab` adds no core system).

## Key Decisions Made

- **Probe lab over DOM hooks.** The four target UIs are canvas/WebGL with no
  DOM, so a `window.__uiProbe` mounted by a dedicated lab is the only honest
  way to drive them from Playwright without shipping test hooks into the game
  scene. Affordances on the engine UIs are read-only and documented as
  test-only.
- **Design-space size assertions, screen-space taps.** Tap-target _size_
  checks use stable FIT design-space dims; functional taps convert
  centre→CSS px and use `page.mouse.click`, so assertions survive viewport
  changes.
- **Split commits.** The production mobile fix is a separate `fix(minimap):`
  commit ahead of the `test:` commit so it stays visible to reviewers and in
  the squashed changelog body.

## Update — e2e teardown hardening + rebase (blocking-gate readiness)

After Group E (#278) made the e2e job a **blocking** merge-gate check, this
branch was rebased onto the advancing `main` and hardened so it cannot fail its
own gate:

- **Teardown timeout fix.** The vitest e2e project set `testTimeout: 120_000`
  but inherited the global `hookTimeout: 30_000`, so an `afterAll`
  `browser/context.close()` could exceed 30s on a heavily loaded machine and
  fail an otherwise-green suite (non-zero exit → red blocking check). Fix:
  - `vitest.config.ts` e2e project now sets `hookTimeout: 120_000`.
  - New `closeQuietly()` helper in `tests/e2e/helpers/ui-probe.ts` races
    `close()` against a bounded 15s timer and swallows teardown errors —
    best-effort cleanup must never fail a suite.
  - Applied to the `afterAll` hooks in `inventory-flow`, `mobile-hit-targets`,
    and the pre-existing `minimap-overlay` suite (rule #8: harden the whole
    blocking gate, not just the new files). Committed as `test(e2e):`.
- **Rebased onto `origin/main`** past #290/#279. One conflict in
  `src/lab-main.ts` (both #279's `tile-blend-lab`/`sprite-tint-lab` and this
  branch's `ui-probe-lab` registration) — resolved by keeping all three.
- **Re-verified on the rebased tree:** `npm run verify:fast` green; full e2e
  suite **14/14, 3 files, 0 failed suites, exit 0** (run twice). `main` is a
  fast-moving target (#290→#279→#281 within ~15min); the `auto-rebase-prs`
  workflow keeps the branch up-to-date for strict-mode merge.
- **Auto-merge:** `gh pr merge --auto --squash` enabled on #284, #285, #291.
  All three MERGEABLE; they land automatically once their blocking checks pass.
