# RPG inventory UX lookbook

Source: session attachment `rpg_action_rpg_ux_lookbook.pdf`, provided 2026-08-20.

This is the repo-owned extracted reference for equipment and inventory UX. Do not
check in the original PDF or screenshots here: the lookbook contains third-party
game images used as visual references. Preserve the reusable design analysis,
rubric, and constraints in text/config form so the UX Designer persona and visual
review judge can use them without depending on a session-local attachment.

## Core test

Can the player understand their current build, inspect a candidate, predict the
result, and execute the action without holding hidden state in working memory?

## Ten principles

1. **Optimize for a decision.** Organize the screen around the player action:
   equip, compare, transfer, sell, salvage, or build.
2. **Preserve a stable spatial model.** Keep body slots, candidate inventory,
   details, and commands in predictable places across contexts.
3. **Show consequences, not just inputs.** Translate raw affixes into net gains,
   losses, thresholds crossed, skills enabled, and final build totals.
4. **Layer information by frequency.** Headline outcomes first, common stats
   second, deep mechanics on demand.
5. **Use typography before ornament.** Create hierarchy with size, weight,
   alignment, spacing, and grouping before adding borders or glows.
6. **Separate state, candidate, and delta.** Current equipment, hovered option,
   and proposed change must be visually and semantically distinct.
7. **Keep context and reversibility visible.** Preserve world, party, currency,
   capacity, and low-risk undo paths while inventory actions happen.
8. **Treat repeated actions as first-class.** Sorting, filtering, transfer-all,
   junk marking, favorites, compare, and salvage are core interactions.
9. **Represent builds as intentions.** Support loadouts, saved filters,
   quick-slot plans, and visible synergies instead of mere item collections.
10. **Expose constraints at the point of action.** Show capacity, slot fit,
    requirements, encumbrance, currency, mod budget, and conflicts before commit.

## Pixel PC playbook

- Use a hybrid UI: preserve pixel identity in world art, item icons, portraits,
  silhouettes, and ornamental accents; render body text, numeric tables, tooltips,
  filters, scrollbars, and command hints at native UI resolution.
- Use separate coordinate systems: integer-scale the pixel world, then composite a
  resolution-independent PC UI last.
- Treat typography as the first retro compromise. At 1920x1080, decisive text
  should be 15px or larger; body/tooltips should prefer 16-18px; never render
  body text below 14px at 100% UI scale.
- Start equipment/inventory screens from a three-column workspace:
  current build, candidates, and consequence/detail. At 1080p, the active
  workspace should occupy roughly 85-94% of width and 80-90% of height.
- Whitespace must have a job: grouping, target size, comparison placement, future
  state, world context, or deliberate dramatic focus. Reclaim unexplained empty
  rectangles larger than 64x64px at the 1080p reference scale.
- Use a spacing system: 4px micro, 8px tight, 12px standard, 16px comfortable,
  24px section, 32px zone. Active panels should be 70-85% content/controls.
- Keyboard and mouse contract: left click selects, right click performs safe
  primary action or opens context, wheel scrolls hovered pane, arrows/WASD move
  focus, Tab moves panes, Enter/E confirms, F favorite, J junk, Space multi-select
  or pin, Ctrl+F or `/` focuses search, Esc backs out without destroying state.
- Hover is reconnaissance; comparison is persistent. Highlight immediately,
  preview at 100-150ms, full tooltip at 350-500ms, click/Space pins.

## Screenshot judge bundle

The judge must evaluate the screenshot and supplied evidence only. A still can
score hierarchy, density, whitespace, legibility, alignment, visible comparison,
ownership, selection, capacity, command hints, target geometry, icon labeling,
color semantics, and occlusion. It must mark behavior as not observable unless a
trace/manifest supplies it.

Minimum case metadata:

- `case_id`
- task (`equip_upgrade`, `triage_loot`, `inspect_build`, `transfer`, `craft`)
- viewport, DPI class, UI scale
- input modality
- screenshot refs and state (`default`, `selected`, `hovered`, `compared`)
- target player question
- visible regions
- behavior evidence, or an explicit statement that it is absent

## Weighted 100-point screenshot rubric

| Dimension                | Weight | Visible question                                             |
| ------------------------ | -----: | ------------------------------------------------------------ |
| Task readiness           |     15 | Can the stated task be understood and started immediately?   |
| Decision delta           |     12 | Are consequences visible without memory or arithmetic?       |
| Visual hierarchy         |     12 | Do priority, selection, and scan order read clearly?         |
| Legibility               |     12 | Are text, numbers, contrast, and alignment readable?         |
| Semantic grammar         |     10 | Do color, icons, labels, and regions have stable meanings?   |
| Workspace use            |     10 | Is PC canvas devoted to useful state, action, or context?    |
| Whitespace quality       |      8 | Does empty area group or target rather than merely exist?    |
| Visible input affordance |      7 | Are mouse and keyboard actions discoverable on-screen?       |
| Ownership and context    |      7 | Are player, party, stash, vendor, and selection unambiguous? |
| Accessibility robustness |      7 | Does meaning survive color loss, scaling, and low vision?    |

Score every dimension 0-4, then normalize by weight. Every score must cite
visible evidence or be marked `not_observable`. Do not redistribute weight from
unknown fields; report coverage separately.

Verdict bands:

- 90-100: reference quality
- 75-89: ship or minor polish
- 60-74: revise
- 40-59: major redesign
- 0-39: task failure

Unreadable decisive text, hidden selection, tooltip occluding the decision
target, or ambiguous ownership caps the verdict at 59.

## Text safety contract

Every text container must declare minimum font size, max lines, wrap mode,
overflow behavior, max bounds, safe inset, full-text access, priority,
localization expectation, and numeric policy. A clip rectangle is not an overflow
policy.

Use this deterministic ladder:

1. Use available width.
2. Wrap at legal breaks.
3. Grow vertically within limits.
4. Move detail to a stable pane.
5. Scroll or paginate long rules text.
6. Ellipsize only supporting labels with a reliable full-text path.

Hard fail text safety if decisive content clips, escapes bounds, overlaps another
control, loses sign/unit, renders below 14px, shrinks between states, or
ellipsizes without full-text access.

## Positive patterns to steal

- Net-change summaries, direct before/after values, and explicit lost properties.
- Body-as-navigation: stable slot geography and slot silhouettes.
- One coherent workspace: current state, candidates, detail, commands, party
  context, visible capacity, and currency together.
- Stat layering: survival, damage, mobility, resource economy, then causes.
- Semantic grammar: one meaning per color, aligned stat families, repeated
  columns, labels beside unfamiliar icons.
- Menus that preserve place: translucent/bounded panes and obvious pause
  semantics.
- Job-oriented tools: transfer-all, search, sort, construction surfaces, and
  preserved filters for repeated work.
- Visible constraints: capacity, vitals, quick-slot limits, junk state, and clear
  ownership between carried/equipped.
- Expert throughput: compact rows, visible modifier keys, compare/favorite/drop
  shortcuts, stable selection after actions.
- Inspectable build identity: persistent totals, complete slot state,
  build-defining stats, and a consistent place for deeper inspection.

## Failure modes the judge should detect

- Wasted canvas or console-sized furniture on PC.
- Ornament over throughput.
- Repeated work without batch tools.
- State/candidate ambiguity.
- Hierarchy collapse from icon walls or equally weighted systems.
- Ownership fragmentation from nested bags, party grids, stash/vendor ambiguity,
  or overlapping containers.
- Low density without useful whitespace.
- Aesthetic constraints overwhelming information.
- One visual grammar for unlike things.
- Thematic chrome that harms arithmetic.
- Hover-only comprehension.
- Maximal density without onboarding/progressive disclosure.
- Overlays that destroy gameplay context.
- Inputs without decision delta.
- Controller-first density on PC.
- Paperdoll as spectacle rather than navigation.

## Product constraints

Do not:

- Make players mentally subtract two long tooltips.
- Use red and green as the only signal for gains and losses.
- Move paperdoll slots or command locations between contexts.
- Give every stat, currency, and ornament equal visual weight.
- Let a tooltip cover the item, target slot, or number it explains.
- Hide sort, filter, search, transfer-all, or compare in tutorial text.
- Reset selection, scroll position, filters, or category after an action.
- Require drag-and-drop for common equip, move, or consume actions.
- Auto-sort a spatial inventory without a predictable rule and undo.
- Mix player, vendor, stash, and party ownership without explicit labels.
- Conceal capacity or encumbrance until the player exceeds it.
- Use unlabeled icons as the only navigation for complex categories.
- Truncate decisive affixes without a reliable full-detail path.
- Compare against the wrong slot, weapon set, form, or saved loadout.
- Destroy manual organization when equipping, selling, or crafting.
- Open modal confirmations for reversible, low-risk actions.
- Treat controller as a slow mouse; design focus order and batch actions.
- Let rarity glows overpower item function, selection, or readability.
- Make flavor copy compete with requirements and consequences.
- Optimize only for first-use simplicity at the cost of long-term throughput.

## One-screen usability test

Within 5 seconds, a player should identify character/loadout and capacity, locate
the equipped slot and selected candidate, and see the headline equip consequence.

Within 30 seconds, a player should filter/sort to useful candidates, understand
requirements/conflicts/special effects, and execute, undo, favorite, or mark junk
without losing position.

Within 5 minutes, a player should process a loot haul without repetitive friction,
construct or restore a build/loadout, and explain why the build works from visible
totals and synergies.
