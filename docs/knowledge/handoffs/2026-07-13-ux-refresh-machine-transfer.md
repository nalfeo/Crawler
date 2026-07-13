# UX refresh machine transfer

## Systems touched

hud-ux

## Transfer state

All local UX Copilot sessions and their descendant processes were forcibly
stopped. The only live session at transfer time was the master orchestrator.
Three Vite/lab servers were also terminated. Do not rely on local worktrees or
session-state paths from the old machine.

Primary acceptance viewport is **1280x720**. Secondary acceptance viewport is
**960x540**. The earlier 844x390 target was explicitly dropped and must not be
used as an acceptance gate or cited as final evidence.

Known screenshots, geometry probes, and judge reports are committed in
`docs/knowledge/handoffs/2026-07-13-ux-refresh-artifacts.zip` (277 files).

## Remote branches and pull requests

| Workstream                      | Durable ref                                                                                  | State                            | Resume notes                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Abilities loadout/hotbar        | PR #1095, `nalfeo-polish-abilities-ux`, head `7bfbf195bda1de635d9b79a6e3e6c141347066c1`      | Open; squash auto-merge armed    | Original direct request was truthfully 4 apples. Leave remote merge automation running.                                                                                                                 |
| Ability reward picker prototype | `handoff/ux-abilities-reward-prototype-20260713`, `3d11ae9f8dae008701f64bc917486016804a586c` | WIP snapshot                     | Seven-file real `MainGameScene` reward-picker prototype. Rebase/cherry-pick only after #1095 lands. The separate reward-picker session had no changes.                                                  |
| Core vitals                     | PR #1116, `nalfeo-polish-vitals-hud`, head `1446458cc44bbdb987d17002bd13cc394de49d37`        | Open; auto-merge disabled        | Exact 10-file, 3-apple slice. All checks were green. After #1095 merges, rebase onto current `main` and preserve abilities `HudUI`, merged family gating, and measured vitals scaling before re-arming. |
| Loot/skill                      | `handoff/ux-loot-skill-20260713`, `03bb4b36e7a7282f62a3ef058394a60b951a3bcc`                 | WIP snapshot                     | Seven files. Deterministic 1280/960 containment passed. Finish bounded judge/review, handoff/apple record, rebase, and PR.                                                                              |
| Encounter HUD                   | `handoff/ux-encounter-20260713`, `083e61382b6d521b7326789fb8d64f328de3de34`                  | WIP snapshot                     | Twelve files and therefore not a valid <=3-apple PR as-is. Split/reduce before landing. Preserve the measured zero-overlap result and judge deadlock evidence.                                          |
| Relationships HUD               | `handoff/ux-relationships-20260713`, `50776d36985401078b1cf9fc5b316e7d9a49859b`              | WIP snapshot                     | Eight files. Rebase carefully over merged family fullscreen gate (#1118). Retarget tests to 1280/960 only. Minimap edits are allowed only for the external `MAP (M)` bounds contract.                   |
| Navigation base                 | `handoff/ux-navigation-base-20260713`, `96bdf4dd344bba2fb3eff2229fba2349722f724b`            | Preserved accepted tree; no PR   | PR #1113 was closed because CI recovery repeatedly combined separate slices. Rebase/reland on a fresh branch after vitals. Do not reopen #1113 or use its polluted final head.                          |
| Navigation arrows               | `handoff/ux-navigation-arrows-20260713`, `dd242e0616abbf68d23ab6cd4856709d0f60bc37`          | Seven-file clean source snapshot | Closed PR #1114 contained later pollution. Stack this exact commit after the fresh navigation-base PR.                                                                                                  |
| Visual-review viewport support  | PR #1115, merge `2802bdb7cd390fde3cc567133a3216b411e1b9b3`                                   | Merged                           | `--viewport WxH` is available on `main`.                                                                                                                                                                |
| Family HUD fullscreen gate      | PR #1118, merge `1bec980c17ebfe0453be6502737c5630a62a0fff`                                   | Merged                           | Actual Phaser display-object visibility is probed at 1280/960. Preserve this behavior in every `HudUI` rebase.                                                                                          |
| Map/dialogue exclusivity        | No branch or PR                                                                              | No reproducible defect           | Real `MainGameScene` physical-`m` checks passed at 1280/960 because `masterHidden` blocks the map during dialogue. Do not implement unless a distinct event ordering is reproduced.                     |

The manifest branch itself is `nalfeo-ux-refresh-machine-handoff`.

## Important navigation history

Do not resume closed PRs #1113 or #1114. CI recovery owned #1113 while review
threads were unresolved and repeatedly pushed broad Copilot repair commits,
growing the PR from the accepted 10 files to 12-14 files. The durable refs above
pin the intended source trees.

Valid findings that still need to be incorporated when relanding navigation:

- preserve merged family-panel fullscreen suppression from #1118;
- hard-split overlong quest tokens and keep the actual 32-character budget;
- keep quest title-strip layering below icon/text;
- keep pinch zoom discoverable in minimap guidance;
- scale top-center/bottom-left critical reservations like `HudUI`;
- place and cap the Floor 2 tracker so it clears every critical region at
  scale 1 and 4/3;
- keep responsive arrow labels/collision geometry in the separate arrow slice.

## Recommended landing order

1. Allow #1095 to merge remotely.
2. Rebase/audit/merge #1116.
3. Finish and merge loot/skill.
4. Reland navigation base from its pinned ref, incorporating the valid findings.
5. Stack/reland navigation arrows from its pinned ref.
6. Rebase and finish relationships.
7. Split and finish encounter.
8. Rebase and finish the reward-picker prototype.

Do not work on multiple `HudUI` branches concurrently. Keep every new slice at
or below 3 apples and 10 changed files, including governance.

## New-machine kickoff prompt

```text
Resume the Crawler HUD UX refresh from branch
`nalfeo-ux-refresh-machine-handoff`.

First read:
- `docs/knowledge/handoffs/2026-07-13-ux-refresh-machine-transfer.md`
- `docs/knowledge/handoffs/2026-07-13-ux-refresh-artifacts.zip`

Rules:
- 1280x720 is primary and 960x540 is secondary; 844x390 is obsolete.
- Keep each landing PR <=3 apples and <=10 files including governance.
- One session/branch/PR per slice; do not combine navigation base, arrows,
  relationships, encounter, vitals, or reward-picker work.
- Preserve merged PR #1118 family fullscreen gating through every HudUI rebase.
- Do not reopen closed PRs #1113 or #1114; use the pinned handoff refs.
- Use deterministic geometry as authority for clipping/overlap and use the LLM
  judge only as a bounded secondary review with evidence-backed rebuttals.

Start by checking PR #1095. If it merged, rebase PR #1116 onto current main,
preserving both abilities/family HudUI behavior and vitals scaling, run
verify:fast and prereqs, audit its exact 10-file scope, then arm squash
auto-merge. Follow the landing order in the handoff and report before/after
screenshots plus exact 1280/960 geometry for each completed slice.
```
