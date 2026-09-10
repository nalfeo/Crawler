# Skills UX Wave 2 — complete journey

## Systems touched

hud-ux, devtools

## Summary

Reviewed and revised the complete Skills journey in the real Phaser surfaces:
earning an ability, allocating level-up points, managing the learned loadout,
confirming selected/equipped state, reading the combat hotbar, and tracking
weapon/spell mastery. All changes are presentation or review instrumentation;
no skill numbers, effects, cooldowns, mana costs, XP curves, unlock thresholds,
skill-point costs, or registry behavior changed.

The inherited `AbilityLoadoutUI` scenarios were useful but incomplete. This
continuation added real journey coverage and revised `LevelUpUI`,
`ModalPickerUI`, `HudSkillTracker`, `AbilityLoadoutUI`, and, after a concrete
real-game readability defect justified widening scope, `HudAbilityBar`.

## Journey audit

| Journey stage     | Problem observed                                                                                                                                                        | Resolution                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Earn/discover     | The Floor-1 boss reward picker looked visually separate from the refreshed Skills surfaces and under-emphasized selection hierarchy.                                    | Applied the shared Blue Steel palette, accessible UI typography, stronger selected-row contrast, larger row spacing, and concise controls.                                                                                        |
| Allocate          | Level Up used a flat legacy hierarchy and dense stat-formula copy.                                                                                                      | Added a clear progression header, point counter, selected-row hierarchy, concise invested-point summaries, and contextual detail in the footer.                                                                                   |
| Manage            | Loadout detail and description copy was undersized at real-game scale.                                                                                                  | Increased decisive copy size and breathing room while retaining dynamic row measurement and three-row navigation.                                                                                                                 |
| Selected/equipped | The inherited toggled-state setup correctly exercised keyboard selection and equip/remove state but its capture path could silently run at reduced lab scale.           | Made both loadout scenarios self-contained full-canvas captures and retained exact state-change assertions.                                                                                                                       |
| Passive state     | The lab duplicated the production loadout builder, omitted passive abilities, and therefore could not prove the active/passive boundary or passive non-toggle behavior. | Routed the lab through `MainGameScene.openAbilitiesConfigModal()`, added a sticky passive heading, and added a passive-state scenario plus keyboard regression coverage.                                                          |
| Combat hotbar     | The keyboard mapping was too small to associate with abilities quickly during combat.                                                                                   | Increased key-label size/contrast, retained slot geometry, and added one measured key region per slot.                                                                                                                            |
| Mastery           | The tracker used an ambiguous `SKILLS` title, raw hyphenated IDs, omitted equipped spell rows from visual sensors, and hid overflow context behind `+N`.                | Renamed it `MASTERY`, title-cased weapon skill names, exposed both spell rows, and changed overflow to `+N SPELLS`. A regression test caught and fixed a reversed ID/display-name call that would have broken skill-state lookup. |

`HudAbilityBar.ts` was initially out of scope. It was changed only after the
complete journey capture produced the concrete key-mapping readability defect;
no casting, cooldown, equip, or slot behavior changed.

## Substantive review loops

1. **Level Up hierarchy**
   - Baseline observation: legacy flat styling and dense per-row formulas.
   - First revision: Blue Steel hierarchy and a 24-region deterministic scenario.
   - Review found one blocker at 66.6/100: stat formulas were too dense.
   - Second revision moved detail to the selected-stat footer and reduced each
     row to the invested-point summary.
   - Independent review then exposed a longest-copy footer overlap and reduced
     980x551 lab capture. The footer now reserves measured space for Dexterity's
     wrapped description, and the scenario asserts a full 1280x720 canvas with
     four additional footer child regions.
   - Final: 80.0/100, zero deterministic blockers, zero evidence-backed blockers.

2. **Ability reward discovery**
   - Baseline observation: readable but visually disconnected reward modal,
     80.0/100 with 14 regions and zero blockers.
   - Revision unified type, palette, row spacing, selected contrast, and control
     copy with the rest of the Skills hierarchy.
   - Final: 80.0/100, zero deterministic blockers, zero evidence-backed blockers.
     Remaining decoration notes were unsupported taste churn.

3. **Combat mastery tracking**
   - Baseline observation: the passing screenshot still omitted spell rows from
     sensors and rendered ambiguous/raw labels.
   - Revision added `MASTERY`, readable names, descriptive overflow, two spell
     rows, and expanded deterministic assertions at 1280x720 and 960x540.
   - A post-build test caught the reversed skill ID/display-name arguments; the
     correction preserved real skill-state lookup and readable labels.
   - Final accepted review: 80.0/100, zero deterministic blockers, zero
     evidence-backed blockers, 16 regions. A later byte-identical rerun produced
     noisy blocker variance and was discarded per visual-review policy.

4. **Loadout-to-hotbar readability and capture integrity**
   - Full-journey review exposed undersized loadout copy and hotbar key labels.
   - Revisions increased decisive copy and key-label readability.
   - The inherited setup then exposed a tooling gap: the review runner did not
     recognize `__abilitiesProbe`, and the lab shell reduced captures to
     980x552. The runner now waits for the probe and all three abilities
     scenarios hide the shell and render at the real 1280x720 scale.
   - An independent review then found that the lab bypassed the production
     builder and omitted passive abilities. The lab now invokes the real
     `MainGameScene.openAbilitiesConfigModal()` path, and a dedicated passive
     scenario proves the sticky section heading and non-toggle contract.
   - Final default loadout, selected/toggled loadout, passive loadout, and
     hotbar reviews all reached at least 80.0/100 with zero blockers.

5. **Production-path and cross-surface closure**
   - The final independent review found that separate passing screenshots did
     not prove reward confirmation reached the loadout, hotbar, and mastery
     projections. A connected deterministic test now confirms a real Floor-1
     boss reward through `MainGameScene`, verifies the learned/equipped row in
     the production loadout, removes and restores it through keyboard input,
     and observes both real HUD projections after each transition.
   - The same review found long authored modal titles could escape the title
     strip. Modal titles now wrap within the panel and grow the header from
     measured height; the Floor-3 Professor Thistle title is contained at both
     1280x720 and 960x540.
   - The review runner now closes Chromium in `finally`; a subprocess regression
     proves failing capture paths exit cleanly without the Windows libuv
     assertion.

## Final visual evidence

| Scenario                           | Regions | Score | Deterministic blockers | Evidence-backed blockers |
| ---------------------------------- | ------: | ----: | ---------------------: | -----------------------: |
| Ability loadout — default          |      18 |  80.0 |                      0 |                        0 |
| Ability loadout — selected/toggled |      18 |  80.0 |                      0 |                        0 |
| Ability loadout — passive          |      18 |  80.0 |                      0 |                        0 |
| Equipped ability hotbar            |      21 |  80.0 |                      0 |                        0 |
| Level Up allocation                |      28 |  80.0 |                      0 |                        0 |
| Floor-1 boss ability reward        |      14 |  80.0 |                      0 |                        0 |
| Combat mastery tracker             |      16 |  80.0 |                      0 |                        0 |

Final loadout/hotbar lineage:
`files/visual-review/after/v2.3.1/{ability-loadout-default,ability-loadout-selected-toggled}.{png,review.json}`,
`files/visual-review/after/v1.0.1/ability-loadout-passive.{png,review.json}`,
and
`files/visual-review/after/v2.3.2/abilities-hotbar.{png,review.json}`.

Level Up, reward, and mastery lineage:
`files/visual-review/after/v2.1.1/skills-level-up.{png,review.json}`,
`files/visual-review/after/v2.1.2/abilities-reward-picker.{png,review.json}`,
and
`files/visual-review/after/v3.0.0/skills-mastery-tracker.{png,review.json}`.

The Screenshot Viewer was refreshed with the complete lineage. Remaining notes
were classified as task-specific aesthetic suggestions. The reusable capture
failure was promoted into the review workflow itself by recognizing
`__abilitiesProbe` and making abilities scenarios deterministic full-canvas
captures. The Windows runner shutdown assertion was traced to immediate
`process.exit()` while libuv handles were closing; using `process.exitCode`
allows a clean natural shutdown.

## Deterministic coverage

- `skills-level-up.js`: full 1280x720 canvas, panel, header, five stat rows, ten
  actions, footer, description, hint, reset, and confirm (28 regions).
- `abilities-reward-picker.js`: real `main-scene-probe-lab` Floor-1 boss reward
  panel, title/subtitle/body, three rows with label/description, and footer
  (14 regions).
- Ability loadout default and selected/toggled: panel, list, footer, and three
  rows with tile/details/description/action (18 regions each). The toggled setup
  asserts exact keyboard selection and equipped-state mutation.
- Passive loadout: the same 18-region contract after crossing the active/passive
  boundary; the heading remains visible and Enter cannot toggle the passive row.
- Ability hotbar: panel, ten slots, and ten key-label regions (21 regions).
- Dungeon HUD: health/loot context, mastery panel/title, weapon bars, both spell
  bars, overflow context, timer, minimap, and hotbar context (16 regions).
- `hud-overlap-visual.test.ts` now verifies both spell rows, `MASTERY`,
  descriptive overflow, human-readable weapon labels, and containment at
  1280x720 and 960x540.
- `boss-reward-picker-ux.test.ts` drives the shipped `MainGameScene` bootstrap
  from reward confirmation through loadout removal/restoration and observes the
  mounted hotbar and mastery tracker, rather than arranging each state
  independently.
- `main-game-scene-floor3-party-ux.test.ts` contains the longest authored modal
  title at 1280x720 and 960x540.
- HUD projection probes return no ability or mastery rows while the enclosing
  HUD is hidden, so production-path checks cannot mistake cached child state
  for player-visible content.

## Why the journey is done

The work stopped after every meaningful transition state had a real-Phaser
scenario, including production-built passive rows; the revised surfaces shared
one hierarchy; all seven scenarios met the 80/100 and zero-blocker gate; and the
player can follow the same vocabulary from reward to allocation to loadout to
combat. Further judge suggestions were decoration, icon enlargement, or minor
spacing preferences with no deterministic defect or state-comprehension
failure. Applying them would over-build individual panels relative to the
refreshed HUD rather than improve the journey.

The final independent diff review confirmed the explicit Dexterity/full-canvas
Level Up coverage and modal title-divider separation. Its one remaining
actionable finding, hidden HUD probes exposing cached child content, was fixed
before closure.

## Verification

- Targeted reward journey, AbilityLoadout/HUD, Floor-3 modal, mobile-scale, and
  visual-review CLI unit suites pass.
- TypeScript typecheck passes.
- `npm run review:visual:deterministic` passes.
- `npm run verify:fast` passes.

## Apples

Estimated 3 apples, actual 3 apples.
