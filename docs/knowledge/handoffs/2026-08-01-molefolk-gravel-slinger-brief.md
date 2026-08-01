# Session Handoff: molefolk-gravel-slinger brief authored

## Date

2026-08-01

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

1🍎 estimated (art-only, brief authoring phase only — generation pending CI)

## What Was Done

Authored `briefs/enemies/molefolk-gravel-slinger.yaml` for issue nalfeo/Crawler#2565
(Floor 2 ranged molefolk soldier with a gravel-sling centrifugal rock launcher).

**Brief design decisions:**

- `type: enemy`, `floor: 2` — matches the issue's request for a Floor 2 enemy.
- No `mobRole` set — defaults to `normal` (non-boss skirmisher/soldier role).
- Description centers on the gravel-sling as the dominant feature: oversized
  centrifugal launcher that hurls rock chunks, with a wound-up or aimed ranged
  attack posture.
- Earthy molefolk palette maintained: velvety brown-gray fur, deep khaki/olive
  canvas overalls, iron-grey hard hat and hardware, muted stone-brown rocks —
  consistent with `molefolk-boss` and `molefolk-burrower` family palette.
- Digging-crew work aesthetic: overalls, iron hard hat (battered), thick heavy
  gloves, tool bandolier of rock chunks — communicates faction identity and
  gameplay role at a glance.
- Three concrete variation seeds covering: wound-up over-shoulder stance, leveled
  aim stance, and wide-stance power pose with rock bandolier visible.
- `minVariations: 6` — standard for non-boss enemies.
- `sensors.enemy.facing: front, toleranceDeg: 20` — matches other Floor 2 non-boss
  enemies (`imp-chain-brawler`, `llama-curb-stomper`).

**Validation:**

`npm run verify:fast` passed (exit code 0) in CI environment after brief creation.

## Key Decisions Made

- **Did not set `mobRole`**: the issue describes a line soldier/skirmisher, not a boss.
  Omitting `mobRole` lets the pipeline default to `normal`.
- **Did not add a palette id**: no molefolk-specific palette JSON exists in
  `data/palettes/`. The brief description carries the palette intent in prose, which
  is the established pattern for enemy briefs (see `molefolk-boss.yaml`).
- **No wiring changes needed**: this is a sprite brief only. Runtime enemy data
  wiring (if needed) is a separate follow-up once the approved sprite ships.

## What's Next / Blockers

The brief is ready as the canonical authored reference. Current
`asset-request.yml` issue jobs do **not** consume `briefs/enemies/**` directly;
they synthesize and promote a `briefs/draft/**` candidate from the issue body
inside `runIssuePipeline`.

### Next session checklist (requires Azure credentials):

1. **Use this brief as canonical reference** for future revisions/check-ins.
   Existing issue-run generation for #2565 came from the synthesized draft path.
2. **Judge candidates** with the `sprite-judge` skill if needed.
3. **Approve the best variant**:
   `npm run sprites:approve -- generated/runs/molefolk-gravel-slinger/<runId> --variant <N>`
4. **Wire the enemy runtime**: add `molefolk-gravel-slinger` to the Floor 2 enemy
   roster once the approved sprite asset is checked in.
