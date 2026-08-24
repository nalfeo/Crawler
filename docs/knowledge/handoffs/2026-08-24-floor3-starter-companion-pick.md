# Session Handoff: Wire Floor 3 starter-Companion pick and enlarge cavern spawn room

## Date

2026-08-24

## Persona

Producer → (game/engine implementation)

## Systems touched

mapgen, enemies

## Apples

3🍎 exact. Full ledger: `docs/knowledge/metrics/apples/2026-08-24-floor3-starter-companion-pick.json`.
Review ledger: `docs/knowledge/review-ledgers/2026-08-24-floor3-starter-companion-pick.review-ledger.json`.

## What Was Done

Fixed nalfeo/Crawler#3496 ("Floor 3 has no pet selection at the start" + "entrance
room is way too small"). Floor 3's starter-Companion recruiting logic
(`_generateStarterOffer`/`_recruitCompanion` in `src/game/floor3Recruiting.ts`)
already existed and was fully unit-tested, but was never called from any real
pipeline — a classic orphaned-system bug (repo Rule #9/#14). Wired it in by
mirroring Floor 1's existing `selectFloor1StarterWeapon`/`world.state ===
'loadout'` pattern exactly:

- `initializeFloor3Scenario` now generates a seeded 4-species starter offer and
  pauses on `world.state = 'loadout'` instead of jumping straight to `'playing'`.
- New `selectFloor3StarterCompanion(world, optionIndex)` resolves the pick
  (falling back to `offer[0]` for an out-of-range index, and to the first
  resolvable offer entry + a `console.warn` degradation signal for the
  theoretically-unreachable unknown-species case), recruits it into the party
  using the same archetype/form stat-resolution helpers as every other roster
  Companion, and resumes `'playing'`.
- `floor3` `ScenarioDefinition` now exposes `selectLoadoutOption`, so
  `headless-runner.ts`'s already-generic loadout handling auto-picks option 0
  with zero headless-runner changes.
- `MainGameScene.openLoadoutModal()` branches on `floorId === 'floor3'` to show
  a new species-picker modal in the real game.
- Separately, enlarged the Floor 3 cavern's spawn/entrance room from a 6×6 max
  to up to 12×12 tiles (`tryGenerateFloor3BiomeOverworld`'s
  `spawnSizeCandidates`), leaving the similarly-shaped Floor 2 spawn-room block
  earlier in the same file untouched.

Observed in the real `main-scene-probe-lab` via a headless Playwright script
(the Playwright MCP browser tool itself was unavailable this session — hit an
`MCPOAuthBrowserRequiredError`, worked around it with a standalone Node script
using the same installed Chromium): before the fix, Floor 3 jumped straight to
gameplay with no pick; after the fix, Floor 3 boots into a "Choose your starter
Companion" modal (screenshot confirmed 4 species spanning distinct
affinities/fighting-styles), and confirming a pick visibly spawns the Companion
next to the player and resumes play. The e2e Floor 2→3 transition suite
(`tests/e2e/main-game-scene-boot.test.ts`) also passed unchanged, confirming no
existing characterization regression.

## Key Decisions Made

- Reused the exact Floor 1 starter-weapon loadout state machine
  (`world.state === 'loadout'`) rather than inventing a Floor-3-specific pause
  mechanism — this is already understood generically by the headless runner and
  `MainGameScene`'s input-blocking logic, so it was the smallest correct design.
- Reused `findFloor3ArchetypeForSpecies`/`formForLevel` (the same helpers
  `spawnFloor3RosterCompanion` already uses for Trainer/Studio rosters) to
  resolve the starter's hp/speed/aggro/attack-range, rather than inventing a
  bespoke, un-reviewed starter stat block.
- Deliberately did NOT refactor `MainGameScene`'s loadout presentation to be
  fully scenario-driven (a plan-review suggestion) — that is a legitimate
  architectural improvement but out of scope for this bug-fix PR; noted below
  as a future opportunity instead of scope-creeping this change.

## What's Next / Blockers

None blocking. Follow-up opportunity (not required): genericize
`MainGameScene`'s loadout modal presentation (title/options/description source)
into the `ScenarioDefinition` contract itself, so a third floor's loadout
doesn't need another `floorId` branch in the engine scene.

## Retrospective

### Lessons Learned

- The Playwright MCP browser tool (`playwright-browser_*`) can fail with
  `MCPOAuthBrowserRequiredError: Browser-based OAuth required for
http://localhost:3100/mcp` even when Playwright/Chromium itself is correctly
  installed. Workaround: spawn the Vite lab server manually
  (`node node_modules/vite/bin/vite.js --mode lab --port 5299 --strictPort`)
  and drive it with a standalone Node script using the `playwright` package
  directly (must run from inside the repo directory so `import { chromium }
from 'playwright'` resolves via `node_modules`) — this reused the exact same
  `main-scene-probe-lab` + `window.__mainSceneProbe` API the real e2e suite
  uses, so it's a faithful "observe before done" substitute.
- `npx playwright install chromium` works fine in this sandbox and is needed
  before the local e2e vitest project (`tests/e2e/*.test.ts`) can run at all —
  the sandbox doesn't ship a pre-installed browser.

### Mistakes Made

- Initially ran `npm run review:grade -- record ...` with a plain-text grader
  reply instead of JSON — the recorder requires a JSON object (`criteria`,
  `verdict`, `findings`, `notes` fields), not prose. Reformat the grader's
  response as JSON before calling `record`.
- The independent-grade `prompt` step must be re-run (and the ledger's
  `head_sha` must match) after any post-plan-review code fixes are committed —
  running it too early against a stale head produces a grade for the wrong
  diff. Commit all fixes first, then generate the final grading prompt.

### Opportunities for Future Improvement

- Consider adding a `companions`/`floor3-league` system slug to
  `docs/systems/README.md` if Floor 3's Companion League work continues to
  accumulate handoffs under the imprecise `enemies` bucket.
- The scenario-driven loadout-presentation refactor noted above under "Key
  Decisions Made" / "What's Next".
