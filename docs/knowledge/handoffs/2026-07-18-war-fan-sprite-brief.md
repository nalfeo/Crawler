# 2026-07-18 — War Fan Sprite Brief (Issue #1457)

## What I did

Authored the `briefs/weapons/war-fan.yaml` brief for the war-fan Floor 2 weapon
icon (asset-request issue #1457). The brief covers:

- A tessen (Japanese iron battle fan) displayed open in thrown-weapon stance
- Diagonal orientation (matching compact-disk thrown-weapon convention)
- Floor 2 palette: gunmetal slats, crimson lacquer panel, brass pivot rivet
- Worn dungeon-quality with cracked lacquer and edge dings
- Anchor at pivot rivet `{ x: 32, y: 48 }`, diagonal tolerance ±10°
- `minVariations: 6` with six explicit variation seeds to guide generation diversity

## Apple estimate

🍎 **1 apple** — pure art scope. Brief YAML only; no item-catalog or engine
changes in this PR. Review-ledger-exempt (art-only fast lane).

## Why diagonal orientation

A war fan (tessen) is a ranged/thrown weapon — the same category as
`compact-disk`. Diagonal reads immediately as "something in flight or being
thrown" versus vertical (held grip-down like `skull-mace`). The silhouette
at 64×64 is most readable with the fan arc sweeping upper-right.

## Systems touched

- `briefs/weapons/war-fan.yaml` — new brief, no other files changed

## Generation step (pending)

Sprite generation requires `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY`
which are only available in the `asset-request.yml` CI workflow. To complete
the pipeline:

1. Trigger `asset-request.yml` via `workflow_dispatch` or re-label issue #1457
2. Worker generates 16 variants → sensor-scored → VLM-judged
3. Approve winner: `npm run sprites:approve -- <runDir> --variant N`
4. Check in: `npm run sprites:checkin`
5. Batch art-only PR: `npm run sprites:asset-pr`

The asset-request.yml workflow accepts Copilot bot issues (allowed author list
includes `app/copilot-swe-agent`), so issue #1457 is eligible.

## Lessons

- `epic-status.test.ts` has 1 pre-existing failing test ("rejects merge facts
  that point at a non-commit git object") that exists on the base branch
  (`84489aa`) and is unrelated to this PR's changes. Confirmed pre-existing by
  checking out the parent commit and reproducing the failure identically. This
  PR does not introduce or fix that failure.
- In the copilot coding-agent environment, the firewall blocks external
  `openai.azure.com` endpoints — sprite generation MUST go through the
  dedicated `asset-request.yml` workflow that has the Azure credentials.
- A war-fan brief should NOT be added to `plans/item-icons/weapons.art.yaml`
  until `war-fan` is added to `ITEM_CATALOG` in `src/shared/items.ts`; the
  art-plan-catalog test enforces one-to-one coverage.
