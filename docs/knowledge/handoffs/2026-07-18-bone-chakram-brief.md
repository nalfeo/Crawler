# 2026-07-18 — bone-chakram Floor 2 equipment icon

## Summary

Added the `bone-chakram` Floor 2 thrown-weapon equipment icon end-to-end (issue #1359). The sprite brief, ITEM_CATALOG entry, art plan entry, and placeholder art (16×16 PNG + manifest entry) are all committed. Real art generation requires the `asset-request.yml` CI workflow to complete with Azure OpenAI credentials.

## Systems touched

`sprites`, `briefs`, `items`, `plans/item-icons`, `tests/unit/items.test.ts`

## What was done

1. **Brief authored** — `briefs/weapons/bone-chakram.yaml`
   - Type: `weapon` (inherits from `data/sprite-types/weapon.json`)
   - Orientation: `diagonal` (same as `compact-disk`, the other thrown ring weapon)
   - Anchor: `{x: 32, y: 40}` (center of ring body; x:32 = horizontal center in 64px space; y:40 = slightly above center [62%] to account for throw-tilt; default grip anchor y:56 is too low for a chakram)
   - `diagonalToleranceDeg: 10` — ring has no strong principal axis, needs wider window
   - VLM judge enabled (inherited from weapon type defaults)
   - Variations seeded with bone-texture cues: cracked ring with bone-splint repair, engraved spiral grooves

2. **ITEM_CATALOG entry added** — `src/shared/items.ts`
   - `wpn('bone-chakram', 'Bone Chakram', 'A razor ring carved from dungeon bone. Comes back. Usually.', R)`
   - Rare rarity (matching echo-bell and other Floor 2 weapons of similar character)

3. **Test snapshots updated** — `tests/unit/items.test.ts`
   - Catalog size: 126 → 127
   - Weapons count: 23 → 24

4. **Art plan entry added** — `plans/item-icons/weapons.art.yaml`
   - `id: bone-chakram`, `placeholderInUse: true`, `kind: sprite-registry`

5. **Placeholder generated** — `public/assets/generated/bone-chakram-placeholder.png`
   - 16×16 RGBA PNG via `npm run sprites:gen-placeholders`
   - Manifest entry added: `bone-chakram-placeholder` → `sourceRun: placeholder`
   - Wiring: `resolveItemSprite('bone-chakram')` auto-resolves via ADR-0051 manifest-only path (no explicit code wiring required)

6. **Branch rebased on main** — merged `84489aa6` (latest main) into `copilot/add-bone-chakram-icon`

7. **verify:fast passed** — 1260 tests, 87 suites, all green

8. **Review ledger created** — `docs/knowledge/review-ledgers/2026-07-18-bone-chakram-item-wiring.review-ledger.json` (2🍎 task)

## What remains

- **Image generation**: The `asset-request.yml` CI workflow needs to run to completion for issue #1359. Both prior runs (01:27:50 and 02:17:10 UTC 2026-07-18) showed `conclusion: cancelled`. The first run was part of a large batch of ~30 floor-2 equipment requests all cancelled; the second completed synthesize/brief-promote stages but was cancelled before image generation. A fresh `workflow_dispatch` or issue edit will trigger a new run.
- **Approve/check-in/batch PR**: After a successful CI run produces generated variants, use `npm run sprites:approve` + `npm run sprites:checkin` + `npm run sprites:asset-pr`.
- **No further wiring needed**: ADR-0051 manifest-only path handles `equipment/weapon/bone-chakram` — once real art is approved and the manifest entry updated (replacing `sourceRun: placeholder`), the game renders it automatically.

## Apple estimate

- Brief + item wiring + placeholder: **2🍎** (touched TypeScript + tests; review ledger required)
- Real art approval + asset PR: **1🍎** art lane (review-ledger exempt)

## CI cancellation context

- Run 29625235962 (01:27:50): Part of ~30-item batch Floor 2 equipment requests; all cancelled, likely concurrency group serializing then external cancellation
- Run 29625410663 (02:17:10–02:22:33): Completed synthesize/brief-promote (see issue comments: brief promoted to `briefs/draft/weapons/bone-chakram.yaml`) but cancelled before image generation — likely maintainer intentional cancellation or timeout

## Lessons learned

- The coding agent environment has no `AZURE_OPENAI_*` credentials — generation must go through the `asset-request.yml` CI workflow
- GitHub API (`api.github.com`) is blocked by DNS monitoring proxy in this environment; only the local git proxy at `localhost:26831` is accessible for push/pull
- GitHub MCP server tools (read-only) work and can be used to inspect issues and workflow runs
- Complete item wiring (ITEM_CATALOG + art plan + placeholder PNG + manifest) can all be done in the agent session; only the Azure image generation step requires CI

## PR

PR #1429: https://github.com/nalfeo/Crawler/pull/1429
