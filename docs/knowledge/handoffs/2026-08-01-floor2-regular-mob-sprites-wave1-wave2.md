# Handoff: Floor 2 Regular Mob Sprites — Wave 1 & 2

**Date:** 2026-08-01  
**Agent:** Asset Forge (Graphics Designer persona)  
**Apple estimate:** 1–2 🍎 art (wave generation) + 1 🍎 pipeline infra (Bug #5 fix)

---

## Summary

Generated and shipped sprites for 27 missing Floor 2 regular mob enemy types via the
issue-wave pipeline. Work split into two waves of 14 (Wave 1) and 13 (Wave 2) issues.

**Status at handoff:**

- Wave 1 (14 sprites): ✅ generated, approved, published to `assets/queue`, PR #2558 opened
- Wave 2 (13 sprites): 🔄 issues opened (#2559–#2572), pipeline run #30686146471 queued
- Wiring: ⏳ pending Wave 2 art PR merge

---

## Systems touched

### Pipeline infrastructure (code PRs, all merged)

| PR    | Fix                                                                                | Status    |
| ----- | ---------------------------------------------------------------------------------- | --------- |
| #2532 | Bug #1: `--allow-unrelated-histories` for orphan `assets/queue` branch             | ✅ merged |
| #2535 | Bug #2: `reset+checkout` to avoid merge conflicts on non-art files                 | ✅ merged |
| #2543 | Bug #3: `--force-with-lease` for orphan-reset path + `(stale info)` detection      | ✅ merged |
| #2549 | Bug #5: `resetExhaustedTransientStage` to clear transient-exhausted publish stages | ✅ merged |

### Art PR

| PR    | Contents                                                  | Status         |
| ----- | --------------------------------------------------------- | -------------- |
| #2558 | Wave 1: 14 mobs × 3 variants (42 PNGs + manifest entries) | on merge-train |

### Issues

**Wave 1 (14 issues, all generated & published):**
#2503 batfolk-sonic-shooter, #2504 toadkin-bouncer, #2505 imp-chain-brawler,
#2506 llama-elite-backlot-capo, #2507 llama-curb-stomper, #2508 panda-elite-red-envelope,
#2509 panda-boba-sniper, #2510 faerie-elite-fae-driveby, #2511 faerie-spark-caster,
#2512 kobold-elite-dragon-capo, #2513 kobold-roman-candle, #2514 ratfolk-elite-underboss,
#2515 gnome-elite-pinstripe-artillerist, #2516 gnome-wheelman

**Wave 2 (13 issues, pipeline queued):**
#2559 ratfolk-sewer-sniper, #2560 crabfolk-elite-shell-capo, #2561 crabfolk-claw-gunner,
#2562 beetlefolk-elite-bugatti, #2563 beetlefolk-resin-gunner, #2564 molefolk-elite-pit-boss,
#2565 molefolk-gravel-slinger, #2566 raccoon-elite-heist-capo, #2567 raccoon-bottle-rocketeer,
#2569 geese-elite-goosefather, #2570 geese-gatling-gander, #2571 snailfolk-elite-slick-don,
#2572 snailfolk-sludge-artillery

---

## Pipeline bug forensics

The pipeline had a cascade of 5 bugs (numbered by discovery order):

**Bug #1 (PR #2532):** `assets/queue` is an orphan branch with no common ancestor with `main`.
`git merge --no-edit mainRef` refuses with "refusing to merge unrelated histories".
Fix: detect "unrelated histories" in stderr, retry with `--allow-unrelated-histories`.

**Bug #2 (PR #2535):** After #1: `--allow-unrelated-histories` with no merge base treats all
files touched in the orphan commit as "added on both sides" → auto-merge conflict on non-art
files (e.g. `.github/agents/set-piece-designer.agent.md`).
Fix: `git reset --hard mainRef` → `git checkout baseRef -- public/assets/generated` → set
`usedOrphanReset=true` flag.

**Bug #3 (PR #2543):** After #2: `usedOrphanReset` creates a commit whose parent is `mainRef`
(not the orphan tip) → plain fast-forward push fails permanently.
Fix: when `usedOrphanReset=true`, push with `--force-with-lease=refs/heads/assets/queue:<orphan-sha>`.
Also extended `isNonFastForwardRejection` to detect `(stale info)` from lease conflicts.

**Bug #5 (PR #2549):** After the 3 bugs above, all 13 Wave 1 publish stages had
`status=failed, attempts=3` with transient error kinds (`push-retries-exhausted`, `git-failed`).
`runCheckpointStage` refuses to retry once `attempts >= maxAttempts`, so every subsequent run
threw "Stage publish already exhausted its 3 attempts".
Fix: `resetExhaustedTransientStage()` — if a stage is exhausted with a strictly infra-resettable
error kind (`null` or `push-retries-exhausted`), remove the stage entry from the checkpoint so
the next run retries from scratch. `git-failed` is NOT auto-resettable (also covers auth/network).

Issue #2514 (ratfolk-elite-underboss) also had its **judge** stage exhausted due to Azure Vision
HTTP 400 "image_parse_error" on the original sprite. Fix: edited the brief sentence to change the
fingerprint → fresh checkpoint → fresh generation → PR #2558 includes the new sprites.

---

## Wave 2 next steps (for whoever picks this up)

1. **Watch pipeline run #30686146471** — expected ~25 min:

   ```
   gh run watch 30686146471
   ```

2. **If pipeline succeeds:** Wave 2 art is automatically published to `assets/queue` and a
   new/updated art PR is created. Add `merge-train` label to it.

3. **If pipeline has failures:** Check `gh run view <id> --log-failed`.
   - Transient git failure: re-edit any open Wave 2 issue to retrigger.
   - Judge exhausted (Azure Vision 400): edit the issue's `### Brief` to change the brief sentence
     (new fingerprint → fresh generation).

4. **After Wave 1 art PR #2558 merges + Wave 2 art PR merges:**
   Run wiring generation:

   ```
   npm run sprites:generate-wiring -- --since main
   ```

   Review the produced patches. If any mob IDs are wired (entry in `mobDefs` +
   `entity-sprite-mappings.json`), open a **separate code PR** for the wiring changes.
   If no patches are produced, record "art landed, no replaceable placeholders detected".

5. **Observe:** After wiring PR merges, launch `npm run dev` and verify the new mob sprites
   render in the real game (Floor 2 enemy encounters). Document before/after.

6. **Final placeholder audit:**
   ```
   npm run sprites:placeholder-audit -- --all
   ```
   Report remaining placeholder count.

---

## Key file paths

- Pipeline: `.github/workflows/asset-request.yml`
- Checkpoint logic: `scripts/sprites/issue-pipeline-checkpoint.ts` (new: `resetExhaustedTransientStage`, `INFRA_RESETTABLE_KINDS`)
- Publisher: `scripts/sprites/asset-request-publisher.ts` (new: call to `resetExhaustedTransientStage` before `runCheckpointStage`)
- Queue commit: `scripts/sprites/queue-commit.ts` (bugs #1–3 fixes)
- Tests: `tests/unit/sprites/issue-pipeline-checkpoint.test.ts` (19 tests), `tests/unit/sprites/queue-commit.test.ts` (31 tests)

---

## Art brief naming note

All Wave 1+2 briefs were named with the canonical mob ID as the issue's `### Name` field.
The pipeline appended a `-v1` suffix to many brief IDs during generation (indicating first-version
synthesis). The actual sprite paths are `<briefId>-var-<N>.png` where `briefId` is e.g.
`batfolk-sonic-shooter-v1`. Wiring must use the **manifest key** (from `entries/*.json`) not the
bare mob ID when binding to `entity-sprite-mappings.json`.
