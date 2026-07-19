# Handoff: Frost-Crook Weapon Icon Brief — 2026-07-19

**Date:** 2026-07-19
**Branch:** `copilot/create-frost-crook-icon-again`
**PR:** #1650 (Refs #1319)
**Agent:** Asset Forge (Graphics Designer persona)
**Apple estimate:** 🍎 1 apple (pure art — brief-only; review-ledger-exempt)

---

## What was done

Authored and committed the sprite brief for the Floor 2 `frost-crook` magic-focus
weapon icon.

### Brief summary (`briefs/weapons/frost-crook.yaml`)

- **Type:** weapon (vertical orientation, 64×64, kenney-roguelike palette, 4×4 sheet — all inherited)
- **Identity:** `frost-crook` → runtime key `equipment/weapon/frost-crook` → auto-resolves via identity model
- **Design:** hooked magic staff (crook shape); crystalline frost arc at the top; deep midnight-blue shaft with pale cyan highlights; dungeon-worn aesthetic per style guide
- **Variations:** 3 authored seeds (hexagonal crystal tip, spiral frost-rime bands, icicle spurs); `minVariations: 8` to expand pipeline diversity
- **Floor:** 2 (ice-cold intensity)

### Context

Multiple prior sessions authored briefs for this issue (PR #1546 has a similar brief on
`copilot/create-frost-crook-icon`). This session consolidates the best content from both
and commits it to the current session's PR branch.

---

## Pipeline status

| Step                              | Status                                                 |
| --------------------------------- | ------------------------------------------------------ |
| Brief authored                    | ✅ done                                                |
| Brief committed                   | ✅ done (this PR)                                      |
| Asset-request pipeline run        | ⏳ pending — generation blocked                        |
| Sprite generated (PNG + manifest) | ⏳ pending                                             |
| Judge/approve                     | ⏳ pending                                             |
| Check-in (asset-checkin issue)    | ⏳ pending                                             |
| Art-only PR                       | ⏳ pending                                             |
| Wire runtime key                  | ⚡ auto — briefId == itemId, no explicit wiring needed |

---

## Generation blocker

The `asset-request.yml` workflow ran for issue #1319 on 2026-07-18T01:27:00Z (run #417)
but was **cancelled** before executing due to Azure queue concurrency saturation — all
70 G2-B issues were labeled simultaneously by `g2b-seed-issues.yml` and ran afoul of the
`${{ github.workflow }}-worker` concurrency group's one-in-flight-plus-one-queued limit.

**To unblock generation**, issue #1319 must carry the `asset-request` label — manual
dispatch only processes open issues that have that label, and the `labeled` event itself
triggers the workflow.  Apply the label first:

```bash
# Preferred: re-label to fire the labeled event (workflow auto-starts)
gh issue edit 1319 --repo nalfeo/Crawler --add-label asset-request
```

If the label is already present but the run still needs to start manually:

```bash
gh workflow run asset-request.yml --repo nalfeo/Crawler
```

The worker synthesizes its own brief from the issue body (does **not** use
`briefs/weapons/frost-crook.yaml` from disk — that file is for local generation runs only).

---

## After generation completes

Once the worker finishes (posting a success comment on issue #1319 with the run URL),
choose **one** of the two delivery routes below — do not combine steps from both.

### Route A — Azure CI harvest (recommended)

The `g2b-harvest-approve.yml` workflow downloads Azure results, approves the best
variant, commits the art, and opens a stacked PR automatically.  No local steps needed.

```bash
gh workflow run g2b-harvest-approve.yml --repo nalfeo/Crawler \
  -f issue_number=1319
```

Then close issue #1319 separately after the art PR merges (the workflow PR does not
add `Closes #1319` automatically):

```bash
gh issue close 1319 --repo nalfeo/Crawler
```

### Route B — Local generation + manual delivery

Use this route only if Azure artifacts are not available or you want to re-generate
from the local brief.

```bash
# 1. Generate locally from the brief
npm run sprites:run -- --brief briefs/weapons/frost-crook.yaml

# 2. Approve winner
npm run sprites:approve -- generated/runs/frost-crook/<run-id> --variant <N>

# 3. Check in
npm run sprites:checkin

# 4. Batch into art-only PR
#    NOTE: sprites:asset-pr closes only intermediate asset-checkin issues,
#    NOT the original asset-request issue #1319.  Add Closes #1319 to the
#    PR body manually, or close the issue separately after the art PR merges.
npm run sprites:asset-pr

# 5. Wire — item icons auto-resolve; no separate code PR needed
#    Verify in: npm run dev  (observe equipment panel renders frost-crook icon)
```

---

## Systems touched

- `briefs/weapons/frost-crook.yaml` — new file (art-only lane, review-ledger-exempt)
- `docs/knowledge/handoffs/2026-07-19-frost-crook-icon-brief.md` — this file

## Related

- Original issue: #1319
- Previous brief PR: #1546 (also open, brief-only)
- Asset-request workflow run (cancelled): `https://github.com/nalfeo/Crawler/actions/runs/29625210586`
- G2-B aggregate issue: #1303 (closed)
