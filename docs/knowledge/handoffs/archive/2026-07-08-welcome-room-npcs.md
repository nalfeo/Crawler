# Session Handoff: Welcome-room NPC character sprites (3)

## Date

2026-07-08

## Persona

Graphics/Content Designer (producer-orchestrated slice)

## Systems touched

sprite-workflow, sprite-pipeline

## Apples

4🍎 estimated (declared for the full F1-burndown program), 2🍎 actual for the
shipped slice (💥 miss — `|delta| ≥ 2`; the session declared 4🍎 for the full
program but realized only the 3-NPC art slice + a non-trivial manifest/catalog
churn fix; the broad program was delegated/deferred).
Art-only PR → review-ledger-exempt (no review stages).

## What Was Done

Generated, judged, approved, and shipped **3 distinct Floor-1 welcome-room NPC
character sprites** so the three "lifer" NPCs stop sharing `textureId: 10` and
render distinctly. This was a peer request from the Wiring session; art-only /
polish / non-blocking (a placeholder villager already renders).

- Authored 3 character briefs (`briefs/characters/npc-{welcome-goon,sweaty-merchant,spell-broker}.yaml`)
  — `type: character`, `judge.enabled: true`, `sensors.enemy.toleranceDeg: 20` +
  `edge.allowMainTouch: true`, 6 variations each, modeled on the player-character
  brief `african-american-female.yaml`.
- Generated on Azure via `npm run sprites:run -- --brief <warmup> --brief <goon> --brief <merchant> --brief <broker>`
  (one warmed process; `--brief` is repeatable). A throwaway warmup brief absorbs
  the cold-call Azure flake. The merchant flaked mid-run once (`fetch failed`) and
  needed a quick re-run.
- Approved 3 picks (`sprites:approve -- <runDir> --variant N`, an unconditional
  human override): **goon var-0** (sensors 6/8, judge 5), **merchant var-0** (7/8,
  judge 5), **spell-broker var-1** (6/8, judge 4). Posted all sheets inline per
  standing directive; all read as strong, on-brief, and distinct.
- Keys now on the branch (what Wiring needs on `main`): `npc-welcome-goon-var-0`,
  `npc-sweaty-merchant-var-0`, `npc-spell-broker-var-1`.

**Observe before done (art):** No runtime wiring is on my plate — NPCs resolve
their sprite via a numeric `textureId`, so `sprites:generate-wiring` (enemies-only)
will not auto-wire these. Verification for this art slice = the 3 generated PNGs
are real (6–8 KB), visually reviewed inline, judge-scored (5/5/4), and distinct.
The Wiring session does the `textureId → generated-key` swap in a follow-up PR
once the 3 keys land on `main`; the in-engine render check is theirs.

## Key Decisions Made

- **Root-caused and fixed a manifest/catalog churn blocker.** `sprites:approve`
  re-serializes `manifest.json` with `Object.keys().sort()` + `JSON.stringify(,,2)`,
  but `main`'s manifest is **append-order** (not sorted), so approve produced a
  3600-line reorder churn even though the entry set was provably `main ∪ {3 NPCs}`.
  Fix: rebuild both shared files as **main's exact bytes + 3 entries appended**
  (manifest via parse-main+append+stringify since main is stringify-stable;
  catalog via textual splice of inline-array-formatted objects, since main's
  catalog uses inline arrays that `JSON.stringify(,,2)` does not reproduce). Result:
  clean **additions-only** diff (manifest `+102/0`, catalog `+39/0`), matching the
  repo's blessed check-in convention (#889–#900 are all additions-only).
- **Pushed character art to human review** per standing directive: every character
  variant "fails" the deterministic sensor gate (6/8–7/8) — this is expected; the
  VLM judge is the real quality signal, and the human rejects the occasional weird
  edge/half-sprite.

## What's Next / Blockers

- **Wiring session** (`b52bda39-1f1b-441f-9490-2b962d68f664`): once this PR merges,
  do the `textureId → generated-key` swap for the 3 welcome-room NPCs. Pinged.
- Broader **F1 art burndown** program (tiles engine-change, slime-rat wide mid-boss,
  item icons) remains delegated/deferred — see `plan.md`. Consumable icons and
  asset-name normalization were delegated to separate sessions.
- No blockers on this slice; art PR is additions-only and review-ledger-exempt.

## Retrospective

### Lessons Learned

- **`sprites:approve` sorts the manifest; `main` is append-order** → approve alone
  yields a churned diff vs `main`. `sprites:checkin` copies the art surface
  **verbatim** (`copyArtSurface`) and does NOT canonicalize, so the churn would
  ship. Produce an additions-only manifest/catalog BEFORE checkin.
- **The catalog is not `JSON.stringify(,,2)`** — it uses inline arrays
  (`"tags": ["generated", "pipeline-approved"]`) and is not even Prettier-clean on
  `main`, so no format/sync gate governs it. Match neighbor style and keep the diff
  additions-only; that's all that matters.
- **Cold-call Azure flake**: the first image-gen call in a fresh `sprites:run` can
  fail `provider error [network]: fetch failed` and is not retried → always run a
  throwaway warmup brief first. It can also recur mid-run (intermittent) — a failed
  brief just needs a re-run.
- `--brief` is repeatable: run all briefs in one warmed process.

### Mistakes Made

- Briefly alarmed by "1-byte briefs" — this was a **PowerShell display artifact**
  from interleaving `Get-ChildItem | Select Name` output with a later command;
  `Get-Content -Raw` showed the briefs were full and correct. Early signal: verify
  file content with `Get-Content -Raw`, not a column-formatted `Length` that can
  misalign in mixed output.
- Spent a full diagnostic loop on the churn before recognizing it was a pure
  approve-vs-main ordering mismatch — the `git log --numstat` additions-only signal
  on prior asset commits was the tell and should have been checked first.

### Opportunities for Future Improvement

- **`sprites:approve` should append new manifest entries in main's order (or match
  `checkin`'s ordering) instead of re-sorting**, so every approve yields an
  additions-only diff and never churns. Alternatively, add a `sprites:checkin`
  preflight that canonicalizes the manifest/catalog to an additions-only diff vs
  the base. This would have saved the entire churn-fix loop this session.

## Branch state

- Branch: `nalfeo-f1-asset-burndown-f2-art` (== `origin/main` + this work)
- Commit: `feat(sprites): add 3 welcome-room NPC character sprites` (8 files, additions-only)
- PR: pending (art-only, review-ledger-exempt)
