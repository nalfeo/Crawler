# Handoff: Floor 3 Slice 13 — party HUD, roster, level-up, and combat command UX

## Systems touched

hud-ux

## Persona

UX Designer

## Apples

3🍎 estimated — five UX surfaces, each with a pure state resolver, a Phaser widget or overlay,
real-artifact wiring, a lab, and deterministic coverage.

## Summary

Implements game-design §15 surfaces 4–8 for Floor 3 (issue #3538):

- **Surface 4 — party HUD** (`src/engine/floor3-party-state.ts`, `src/engine/HudFloor3Party.ts`):
  one row per `PartySlot` Companion with name, level, HP bar, KO tag, affinity swatch, fighting
  style glyph, matchup chevron, and command-readiness pip, plus a party capacity readout.
- **Surface 5 — roster/detail** (`src/engine/floor3-companion-detail-state.ts`,
  `src/engine/Floor3RosterUI.ts`): a blocking centered overlay listing the party with a detail
  column (form, affinity relations, persona profile, ability milestones). `detailLines()` lives
  in the state module so line composition is unit-tested without Phaser.
- **Surface 6 — level-up / evolve / learn notice**
  (`src/engine/floor3-level-up-notice-state.ts`): diffs the previous party snapshot against the
  current one and emits transient notices rendered in the HUD notice strip.
- **Surface 7 — ability command** (`src/engine/floor3-ability-command-state.ts`): capacity
  charges (one per `commandLevelsPerCapacityCharge` player levels), per-member cooldown
  (`commandCooldownFrames`), and deterministic rejection copy.
- **Surface 8 — matchup indicator** (`src/engine/floor3-matchup-state.ts`): resolves the nearest
  rival Companion inside engagement range and reports strong/weak/neutral per party member.

Wiring: `HudUI` creates/syncs/destroys/hides the party HUD and exposes `getFloor3PartyState` /
`issueFloor3Command`; `MainGameScene` owns the roster overlay, binds `R` (roster) and `C`
(command), handles roster keyboard nav ahead of the blocking-surface early return, and registers
the roster in `isBlockingSurfaceOpen()`.

Labs: five sandboxes under `src/labs/floor3-ux-lab/` sharing one fixture that builds a real
recruited party via `recruitPartyCompanion` plus a rival Companion.

## Verification

- `tests/unit/floor3-party-hud-state.test.ts` (12), `floor3-matchup-state.test.ts` (8),
  `floor3-companion-detail-state.test.ts` (12), `floor3-level-up-notice-state.test.ts` (8),
  `floor3-ability-command-state.test.ts` (11), `floor3-ux-wiring.test.ts` (12) — 63 passing.
- `tests/e2e/floor3-party-hud.deterministic.test.ts` — 7 passing (per-surface lab).
- `tests/e2e/main-game-scene-floor3-party-ux.test.ts` — 1 passing (real `MainGameScene`).
- `bash scripts/agent/verify-fast.sh` — passed.

### Observe before done (rule #9)

The e2e test drives the real `HudUI` + `Floor3RosterUI` instances mounted by the lab harness and
captures pixel state before and after each interaction: the HP bar region repaints after a
Companion takes damage; the roster overlay appears and the cursor moves between companions; the
matchup chevron flips when the rival's affinity is swapped from a strong to a weak matchup.

Because a lab can never prove the shipped scene mounts a widget, a second suite
(`tests/e2e/main-game-scene-floor3-party-ux.test.ts`) boots the **real `MainGameScene`** on
Floor 3 via `main-scene-probe-lab`: before the starter Companion is chosen the party HUD is
hidden with zero rows; after the real loadout modal resolves it shows the recruited starter;
`[R]` opens the roster overlay with a live detail column, `[Escape]` closes it, and `[C]` spends
a command charge (`commandsInUse` 0 → 1).

## Key decisions

- **UI-owned command state.** Command capacity/cooldown state lives engine-side, outside
  `world`, so mounting the HUD cannot perturb headless simulation fingerprints.
- **`PartyMemberKey` (`slot:speciesToken`) instead of eids** for notices, cooldowns, and matchup
  maps, because entity ids recycle.
- **Pure state modules per surface.** Every surface's logic is a Phaser-free resolver so the
  behavior is unit-testable and the widget stays a thin renderer.
- **Frame-count-only timing.** Notices and cooldowns key off `world.frameCount` and tolerate a
  rewound counter so a reset run cannot strand a cooldown or a notice.
- **Ability display names degrade gracefully.** Floor 3 `f3.*` ability ids have no catalog
  entries yet, so the detail/command surfaces fall back to `<Form name> · L<level>`; tests assert
  a raw `f3.` id never reaches the player.

## Next steps

- Slice 14 (versus intros, win/lose, overworld markers, keep-companion picker) reuses the same
  lab fixture and probe harness.
- Sprites for Floor 3 Companions still do not exist; the HUD uses affinity swatches and style
  glyphs as placeholders.
- Do not rebuild `docs/knowledge/handoffs/INDEX.md`; CI owns that generated index.

## Retrospective

### Lessons learned

Lab boot failures surface as an in-page "Lab crashed" card rather than a page error, so a lab
that never mounts a canvas should be diagnosed by dumping `#lab-canvas` innerHTML — the crash
message named the real cause (an invented `speciesId` that is not in
`src/shared/data/floor3/species.json`) immediately.

### Mistakes made

The lab fixture used made-up species ids (`bramble-tender`, `storm-pip`, `dust-mote`). Floor 3
species ids are strictly `<affinity>-<style>` combinations from the authored data file.

### Opportunities for future improvement

The lab runner could log the crash message to the console as well as rendering it, so headless
probes and e2e failures point at the cause without a DOM dump.
