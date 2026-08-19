# Session Handoff: Add spell-skill rows to combat skills HUD

## Date

2026-08-19

## Persona

Producer → HUD/UX implementation

## Systems touched

hud-ux

## Apples

3🍎 estimated, 3🍎 actual — new pure helper module + extension of an existing
HUD widget + a shared-constant hoist + tests, no new ECS system/lab required.
Full 3🍎 review harness ledger recorded:
`docs/knowledge/review-ledgers/2026-08-19-dev-build-view-skill-status.review-ledger.json`
(plan review: 5 concerns addressed, divergence=minor; code review: clean round
1; independent grade: pass, 5/5 on all criteria).

## What Was Done

Resolved issue #3143: the always-visible "combat skills" HUD widget
(`src/engine/HudSkillTracker.ts`) only showed the active weapon's class/type
skill — spell skills (e.g. `spell-fireball`) leveled up with **zero UI**
anywhere in the game. Extended the same widget (rather than building a new
overlay) with up to 2 additional rows for the player's currently-equipped
spells' skills, reusing all existing row-rendering/progress-bar logic:

- Hoisted `SPELL_SKILL_THRESHOLDS` (the one usage-threshold curve shared by
  all 10 Floor 1 spell skills) into `src/shared/spell-skills.ts` so the
  engine-layer HUD can compute progress without importing from
  `src/game/**` (disallowed by the layer rules). `src/game/skills/registry.ts`
  now consumes the same constant instead of a duplicated literal.
- New pure helper `src/engine/hud-spell-skill-rows.ts`:
  `selectSpellSkillRows` (capped row selection, in equip order) and
  `countMatchingSpellSkills` (uncapped count, for the overflow indicator).
  No Phaser dependency — directly unit-testable.
- `HudSkillTracker.ts`: added `SPELL_ROW_CAP = 2` extra rows to a
  **fixed-size** panel (unused rows hidden via `setRowVisible`), because the
  panel's parent HUD group measures its bounds once at scene-load
  (`bottomLeft.getBounds()` in `HudUI.ts`) before the first `applyScale()` — a
  per-frame-resized panel would break that one-time measurement. Renamed the
  panel title `WEAPON SKILLS` → `SKILLS` (now covers both), and added a `+N`
  overflow indicator in the title strip when more trackable spells are
  equipped than there are rows, so the cap is visible, never silent.

Observed in `npm run lab` (`?lab=hud-lab`) with a real Phaser `HudUI`/
`HudSkillTracker` instance: before the fix, no UI anywhere showed spell-skill
state; after, seeding `world.skillStatesByEntity` with a `spell-fireball`
entry and bumping its `usage` field grew the new row's progress-bar fill from
~2.5px (empty) to ~82px (full-width, correctly capped) — confirming the
reused progress-bar math works identically for spell skills as it does for
weapon skills, not just that the row renders.

## Key Decisions Made

- **Extended the existing combat HUD widget instead of building a new
  overlay.** A new full-screen "Skills" panel (like `AchievementsUI`) or
  extending the safe-room abilities modal were both rejected: the issue
  explicitly names the **combat** skills UX as the gap, and neither
  alternative is visible during combat.
- **Fixed-size panel with hidden rows, not dynamic resize.** Driven by how
  `HudUI.ts` measures the `bottomLeft` HUD group's bounds exactly once at
  scene-load, before scaling is applied.
- **Overflow indicator over expandable/pageable UI.** A separate-model plan
  review flagged that a silent 2-row cap could hide skills for a player with
  3+ equipped trackable spells (the slot limit is `ACTIVE_ABILITY_SLOT_LIMIT =
10`). Rejected an expandable/pageable tracker and per-slot indicators on
  `HudAbilityBar` as too much added complexity for what is an edge case in
  practice; added a `+N` overflow indicator instead so the cap is visible.
- **`getActiveWeaponDef(world)` is never `undefined` during real gameplay**
  (confirmed via `equipmentSystem.ts` always calling `setActiveWeaponDef` on
  spawn/equip), so the plan-review concern about spell rows disappearing in
  an "unarmed" state is not a reachable player state — no change needed.

## What's Next / Blockers

None — feature complete, tested, and reviewed. Possible future follow-up (not
blocking, not done here): if a future spell skill ever needs a threshold curve
that diverges from `SPELL_SKILL_THRESHOLDS`, both `HudSkillTracker.ts` and the
new `skill-registry.test.ts` invariant test must be updated together — the
test will fail loudly if this drifts, which is the intended guardrail.

## Retrospective

### Lessons Learned

- The Playwright MCP tools (`playwright-browser_*`) failed in this sandbox
  with `MCPOAuthBrowserRequiredError: Browser-based OAuth required for
http://localhost:3100/mcp`. Workaround: drive the repo's own
  `node_modules/playwright` directly via a small Node script run from the
  repo root (`cd` into the repo so `require`/import resolution finds it), and
  install the browser first with `npx playwright install chromium` if it's
  missing (~175MB, not preinstalled in this sandbox).
- `src/labs/hud-lab/index.ts`'s synthetic world does **not** seed
  `world.skillStatesByEntity` by default — every skill row (weapon or spell)
  renders via the "no state" fallback unless you patch the lab to seed real
  skill state. This is a pre-existing lab limitation, not something this
  session fixed (out of scope), but it means a plain visual screenshot of the
  lab only proves rows render with correct names/colors — not that the
  progress-bar math is correct. To prove the math, temporarily patch the lab
  to seed `world.skillStatesByEntity` and expose a debug mutator, verify via
  the `getLootSkillLayout()` probe's numeric region widths (extend its
  region-name allowlist temporarily too), then fully revert the lab patch
  before finishing — never leave lab-only debug scaffolding in the diff.
- The review-harness independent grader (a fresh `general-purpose` task agent)
  can itself create stray scratch files in the repo root (e.g. `extract.py`,
  `the_diff.diff`) while parsing the prompt packet, even though it produced no
  requested file output. Always `git status --porcelain` immediately after any
  task-tool agent call, not just after your own edits.

### Mistakes Made

- Initially ran `npm run review:grade -- prompt <ledger>` **before** committing
  the implementation, so the diff was empty (`Changed files (0)`) — the grader
  packet is built from the committed diff against the merge base, not the
  working tree. Always commit (via `report_progress`) before generating the
  independent-grade packet.
- The first independent-grade pass surfaced one legitimate (if minor) scope
  finding: a drive-by `test-results/` line I'd added to `.gitignore` during
  cleanup of a stray Playwright artifact directory was unrelated to the
  spell-skill-rows task. Reverted it in a follow-up commit and re-graded
  against the final HEAD to get a clean 5/5/5/5/5 pass — don't bundle
  incidental hygiene fixes into a feature diff even when they're one line.

### Opportunities for Future Improvement

- `src/labs/hud-lab/index.ts` could be improved to seed a small default
  `world.skillStatesByEntity` map (mirroring what `abilities-lab`/`skill-lab`
  already do), so future HUD-skill visual verification in this lab can
  exercise the real progress-bar math without a temporary patch-and-revert
  cycle.
