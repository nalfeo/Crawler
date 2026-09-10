# Session Handoff: Floor 5 assets blocked before generation

## Date

2026-09-03

## Persona

Graphics Designer / Asset Forge

## Systems touched

sprite-pipeline, mapgen

## Apples

5🍎 estimated, 1🍎 actual (miss; discovery and pipeline preflight only)

## Outcome

This is a blocker handoff only; it references #3917 but must not close it. No
assets, briefs, manifests, set-piece data, wiring, or tests were changed.
Generation stopped before authoring because the required Azure configuration is
unavailable in this cloud worktree:

- `.env.local` is absent.
- No `AZURE_OPENAI_*` or Azure Storage credential variables are present.
- `npm run setup:azure:env -- --help` reports that cloud/CI setup is skipped.
- The durable `assets/queue` branch contains no Floor 5 Ratings Ram, Hero,
  Crown Auditor, Regent Emeritus, or throne-room assets to reuse.

The Azure-required sidecar policy forbids a noop/local-only fallback, and the
requested hard gate forbids wiring placeholders. Resume only after valid Azure
OpenAI and Storage credentials are available to `npm run sprites:run`.

## Scope prepared

Local mode was selected for one bounded wave. Canon was traced through
`docs/knowledge/game-design/lore-bible.md` and
`docs/knowledge/game-design/floor5-hostile-takeover.md`; no contradiction was
found. The planned art surface was:

- Ratings Ram.
- Eight field Heroes.
- Crown Auditor and Regent Emeritus.
- Regent throne, Crown Auditor ledger desk, hostile-transfer seal press, and
  captured-castle banner stand.
- Deterministic throne-room dressing using those four commissioned props plus
  existing rubble, crate-stack, wall-sconce, and carved-terrain assets.

## Validation evidence

- `bash scripts/agent/preflight.sh` — passed.
- `npm run sprites:placeholder-audit -- --all` — completed; 88 placeholder-only
  concepts, 0 replaceable, 0 new real assets.
- Azure environment inspection — blocked as described above.

## Resume point

Run the required throwaway warmup brief, then generate and judge the 15 planned
briefs locally. Approve only sensor/VLM/eyeball-passing variants before adding
the Floor 5 set-piece data and entity wiring. Do not use placeholder art to
satisfy the hard gate.
