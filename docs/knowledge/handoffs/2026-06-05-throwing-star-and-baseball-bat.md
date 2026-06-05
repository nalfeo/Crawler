# Throwing star + baseball bat — minimal-brief end-to-end run

**Date:** 2026-06-05
**Branch:** `nalfeo/throwing-star-and-baseball-bat`
**Persona:** graphics-designer

## What I did

Generated two new weapon sprites end-to-end via the Azure sprite pipeline as
the first real exercise of the merged minimal-brief + LLM-variations-expander
flow (PR #28, now on `main`):

- `briefs/weapons/throwing-star.yaml` — truly minimal (`type` / `name` /
  one-word `description`). LLM expander filled in 4 embellishment variations.
- `briefs/weapons/baseball-bat.yaml` — started minimal, ended up needing a
  prose-heavy description plus a per-brief sensor tweak (see below).

Also added a new rule to `docs/agent-os/sprite-style.md`'s prompt preamble:
**no effects that would normally need animation** (fire, dripping, glows,
sparks, motion lines, etc.). These are render-time concerns owned by future
VFX systems, not properties of the base sprite, and the model loves to add
them unprompted.

## Results

| brief         | variants | passed | chosen        | score       | derived anchor |
| ------------- | -------- | ------ | ------------- | ----------- | -------------- |
| throwing-star | 16       | 5      | variant 5     | 7/7 (100%)  | (8, 13)        |
| baseball-bat  | 16       | 16     | variant 0     | 7/7 (100%)  | (9, 15)        |

- throwing-star: `generated/runs/throwing-star/2026-06-05T18-37-12-1f66db31/`
- baseball-bat:  `generated/runs/baseball-bat/2026-06-05T18-34-57-29b7d3e2/`

Both runs land under `generated/` (gitignored). Chosen PNGs are
`processed/<idx>.png` inside each run dir.

## What I had to tweak (and why)

### baseball-bat went from 0/16 → 16/16

First attempt with the minimal `description: baseball bat` produced 16
diagonal "swing pose" bats at ~−46° (model has a very strong "athlete
swinging the bat" prior on the word "bat"). Every variant failed both
`silhouette-orientation-axis` (vertical-bias is the weapon default) and
`anchor-derivable` (grip ends off-center because the bat is angled). A
slightly-clarified one-line description was not enough.

Per the cross-session conversation with the calling chat session, we opted
**against** accepting the swing pose: the vertical-bias contract for
weapons is what lets the in-game equip pipeline rotate every weapon around
a shared grip anchor. A swing-pose sprite would render wrong when the
rotation system applied a swing animation on top of it.

Final brief uses:

1. A verbose item-icon-framed description (`"static item icon, oriented
   strictly vertical, grip at the bottom, barrel at the top, no motion
   blur, no swing arc, no hands, no athlete, ..."`) to bury the
   baseball-content prior.
2. A small per-brief override: `sensors.weapon.diagonalToleranceDeg: 10`
   (up from the default 5°), because club silhouettes are slightly less
   geometrically crisp than sword blades and were landing at 80–85°
   instead of dead 90° even when no longer obviously swung. **The default
   was not widened.**

Defaults like palette, references, sheet layout, and anchor.derive are all
inherited from `data/sprite-types/weapon.json`.

### throwing-star needed nothing

The minimal one-word description passed on the first attempt with no
overrides. Throwing stars apparently don't carry a strong "in motion" or
"being thrown" prior — they read as static item icons by default.

## Pipeline gaps observed

These are NOT blocking — both sprites generate today — but they came up
during this run and should be filed:

1. **`_comment` typo in `data/sprite-types/weapon.json` blocked all weapon
   briefs on the pre-PR-#28 branch.** The loader's `stripMetaKeys` only
   drops `$`-prefixed keys (JSON-Schema convention), but PR #44 wrote
   `_comment` at the top of weapon.json. PR #28's merge already fixed
   this on `main` (commit `c05e455` per the chat). Fix is shipped — no
   action needed. Worth pinning as a "we have one obvious foot-gun
   eliminated" data point.

2. **`AZURE_OPENAI_CHAT_DEPLOYMENT` env var has no fallback.** The chat
   provider is gated on this env var, but the shared
   `azure-sprite-pipeline.env` only defines `AZURE_OPENAI_VISION_DEPLOYMENT`
   (because the same deployment serves both). I aliased it inline in
   PowerShell every run. A one-line fallback in
   `scripts/sprites/provider/factory.ts` (`env.AZURE_OPENAI_CHAT_DEPLOYMENT
   ?? env.AZURE_OPENAI_VISION_DEPLOYMENT`) would remove the ergonomic
   wart. Small DX improvement.

3. **No `--variants N` CLI knob for quick iteration.** Each full attempt
   is a 16-variant 1024² generation + post-process + score, ~55s end to
   end. When you're tuning a description string and don't need diversity,
   a `--variants 4` (or even `1`) flag would cut the feedback loop ~4×.
   Especially valuable for the upcoming batch / cloud-judge flows.

4. **Strong content priors are exactly what `judge.ts` will catch.** The
   baseball-bat case (where every variant satisfies hard sensors but is
   the wrong "kind" of bat — i.e. mid-swing rather than static item icon)
   is the canonical example for why a VLM judging step needs to exist
   alongside deterministic sensors. Worth pinning in the lab as a
   real-world test case once the judge lands.

## Style-guide change rationale

Added rule #9 to the preamble:

> No effects that would normally need animation — no fire, flames, sparks,
> embers, smoke, dripping blood or liquid, glow halos, magic auras,
> lightning, motion lines, swing arcs, speed trails, or any other dynamic
> FX.

Two reasons:

- Animated FX are a render-time layer, owned by separate VFX systems. A
  sprite that bakes a "permanent" glow halo into its silhouette breaks
  hard the moment we want to toggle that glow on/off based on game state
  (e.g. an enchanted weapon only glows while a buff is active).
- It also rules out swing arcs / motion lines specifically, which is the
  same content-prior that broke baseball-bat. With this rule in the
  preamble, future briefs for percussive / club / chain / flail weapons
  should not need to re-litigate "static item icon, no swing" in
  per-brief prose.

The rule lands in both the visual-conventions list (§ "Hard constraints")
and the literal prompt preamble that `build-prompt.ts` concatenates. All
126 sprite unit tests still pass; the prompt tests use a `FAKE_STYLE_GUIDE`
fixture so they are decoupled from the real preamble text.

## How to reproduce

```powershell
# In the same PowerShell invocation as the run:
Get-Content C:\Users\nalfeo\.copilot\session-state\f7220956-761b-43c9-86f5-7698a3e3cf46\files\azure-sprite-pipeline.env |
  ForEach-Object { if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } }
$env:AZURE_OPENAI_CHAT_DEPLOYMENT = $env:AZURE_OPENAI_VISION_DEPLOYMENT  # see gap #2
npm run sprites:run -- briefs/weapons/throwing-star.yaml
npm run sprites:run -- briefs/weapons/baseball-bat.yaml
```

## Files changed on this branch

- `docs/agent-os/sprite-style.md` — new preamble rule #9 (no animated FX).
- `briefs/weapons/throwing-star.yaml` — new minimal brief.
- `briefs/weapons/baseball-bat.yaml` — new brief, verbose anti-swing
  description + `sensors.weapon.diagonalToleranceDeg: 10` per-brief
  override.
- `docs/knowledge/handoffs/2026-06-05-throwing-star-and-baseball-bat.md` —
  this file.
