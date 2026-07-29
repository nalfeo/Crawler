# 2026-07-27 — Welcome-room NPCs v2 (goon + merchant): UNBLOCKED and shipped

**Status: COMPLETE. 11 assets approved and checked in.**
**Apples: 2🍎** (pure art wave — brief prose + generated PNGs + catalog/manifest;
review-ledger exempt, no engine or wiring code touched).

## Scope

Re-run of the wave that was BLOCKED on `anchor-derivable` after nine rounds
(`2026-07-27-welcome-room-npcs-v2-blocked.md`). The blocker was fixed in
`bf2ce5f05` by switching both character briefs from `sensors.anchor.mode: grip`
to `center-of-mass`. No sensor code was touched, then or now.

## The fix is confirmed by measurement

`grip` picks ONE contiguous opaque run from the bottom row, so a two-boot biped
resolves to a single foot. Measured on the shipped merchant (`07.png`), bottom
rows y=58 and y=59:

    runs: [21-30], [36-42]   → full span midpoint = 31.5 ≈ 32 (frame centre)
    grip would have picked run [36-42] → x=39 → offset +7 → FAIL
    center-of-mass derived anchor = (32,32) → PASS

**`anchor-derivable` passed on 24 of 24 variants across both briefs this wave.**
Previously it failed on essentially every character variant for nine rounds.

## Results

| brief                | variants | sensor-pass | full-pipeline-pass | shipped primary                |
| -------------------- | -------- | ----------- | ------------------ | ------------------------------ |
| `sweaty-merchant-v2` | 12       | 12/12       | 4 (5, 7, 9, 10)    | **`sweaty-merchant-v2-var-7`** |
| `welcome-goon-v2`    | 12       | 11/12       | 7 (3,4,5,6,7,9,10) | **`welcome-goon-v2-var-7`**    |

Judge scores (design_language / reference_style_match / brief_match / readability):

- merchant **07**: 4/4/4/5 PASS, confidence 0.92 — chosen. 09 also 4/4/4/5;
  05 and 10 were 4/4/3/4.
- goon **07**: 4/4/**5**/4 PASS, confidence 0.92 — chosen (highest brief_match).
  09 also 4/4/5/4; 03/05/06 were 4/4/4/5.

Rejected: 8 merchant variants and 4 goon variants at judge 2/3/1–2/2
(`design_language`, `brief_match`, `readability` all below the `<3` bar). One goon
variant (11) passed the judge but failed `interior-transparency-holes` and was
therefore not `combinedPassed` — not approved.

**All 11 `combinedPassed` variants were approved and checked in**, per the
maintainer's "all art is useful art (until rejected allup)" rule — not just the
two primaries. Branch `assets/checkin-20260727-163843-5f2250`, issue #2111.
Verified with `git ls-tree`: every PNG is tracked, none left loose on disk.

## The goon needed one brief round (round 10 → 11)

Round 10 generated cleanly and all 12 variants passed `anchor`, but the run
aborted: the VLM judge hard-blocked the first candidate and its
`hard_block.rationale` exceeded the 500-char cap in `judge.ts`'s zod schema, which
threw and failed the brief. The hard-block finding was substantively CORRECT —

    measured round 10: drawn box 38x58, aspect 0.655, head block ~13px of 58

i.e. ~4.5 heads, against a brief demanding 7. **I did not raise the schema cap or
otherwise touch judge/sensor code.** I fixed the _brief_, porting the merchant
brief's measured-share language (explicit legs ≥100/256 source px, head ≤34/256,
"clearly taller than wide") and replacing "big, heavy-set" — which was fighting
the seven-heads requirement — with "tall, rangy … lean, long-limbed".

    measured round 11: drawn box 31x58, aspect 0.534 — and 7 full-pipeline passes

## Honest caveats (shipped art vs brief)

1. **Proportions still fall short of the briefed 7 heads.** Measured head block
   (crown to shoulder flare) is ~12–13 px of a 57–58 px figure on both shipped
   sprites — roughly **4.6–5.1 heads**, not 7. The judge scored proportions 4–5/5
   and called them "correct"; that is generous. The wave is a large, measurable
   improvement (goon aspect 0.655 → 0.534, legs now the bottom half) but literal
   seven-heads has never been achieved on this pipeline. Flagging rather than
   burning another nine rounds chasing it.
2. **Merchant boots are not fused.** The brief calls the single unbroken bottom
   run "the single hardest requirement"; the shipped sprite has two runs
   ([21-30], [36-42]). It is harmless now that the anchor is centre-of-mass, and
   the silhouette is symmetric about x=32, but the brief text overstates the
   requirement and should be relaxed _in the brief_ next time this is touched.
3. **Low variant diversity** (pHash mean 0.018 merchant / 0.023 goon) — the 12
   cells of a sheet are near-duplicates, yet judge scores split 4/4/4/5 vs
   2/3/1/2 across them. Worth a look; not blocking.
4. **`judge.ts` schema fragility is a real latent bug.** A hard-block with a long
   rationale kills an entire brief run after all image spend. Fixing it is a code
   change and belongs in a code PR, not this art lane. Not filed here.

## Verification (observe-before-done)

Composited both shipped sprites at 1x and 4x over the ACTUAL welcome-room floor
plate (`welcome-room-floor-plate-clean-var-2.png`, mean RGB 75/78/83) alongside
the accepted reference `spell-broker-v2-var-3` — `files/room-floor-check.cjs`.
Both read cleanly at game scale: light polo / dark trousers / amber badge for the
goon, pale head / olive apron / teal bottles for the merchant. Neither is a dark
blob. Note the earlier `files/dark-floor-check.cjs` uses RGB 26/24/30, which is
much darker than the room actually is and over-rejects.

## Systems touched

- `briefs/characters/welcome-goon-v2.yaml` — proportion budget strengthened
  (prose only; `sensors.anchor.mode` untouched).
- `public/assets/generated/` + `manifest.json` + `src/shared/data/sprite-catalog.json`
  — 11 new assets, via `sprites:approve` / `sprites:checkin`.
- `files/room-floor-check.cjs` — throwaway measurement tooling (new file).
- **No engine, no `sprite-kind.ts`, no sensors, no judge, no wiring.**

## Wiring status — OUTSTANDING

`src/engine/phaser-bridge/sprite-kind.ts:346-347` still points at
`npc-welcome-goon-var-0` and `npc-sweaty-merchant-var-0`. Wiring to
`welcome-goon-v2-var-7` / `sweaty-merchant-v2-var-7` is a **code PR** (full gate +
review harness) and is owned by the parent session, not this art lane.

Unchanged pre-existing trap: `sweaty-merchant-v1-var-1` and
`sweaty-merchant-v1-var-11` remain orphaned in the catalog.
