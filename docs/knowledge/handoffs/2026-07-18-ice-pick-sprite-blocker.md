# Handoff: Ice Pick Sprite Generation — Blocked (Azure Unavailable)

**Date:** 2026-07-18  
**Wave:** `floor2-equipment-weapon-axe`  
**Issue:** nalfeo/Crawler#1357  
**Tracking:** nalfeo/Crawler#1303  
**Branch:** `copilot/create-ice-pick-icon`  
**Apple estimate:** 1 🍎 (pure art, review-ledger-exempt fast lane)

---

## Summary

Sprite generation for the `ice-pick` Floor 2 equipment weapon was attempted but
**could not proceed** because Azure OpenAI credentials are not available in this
CI/GitHub Actions environment. Per the Azure-required sidecar policy (AGENTS.md
§"Azure-required sidecar policy" point 5) and the task instructions, this is
reported as a hard blocker — no placeholder was created.

---

## What is done

- **Brief authored and committed:** `briefs/weapons/ice-pick.yaml`
  - `type: weapon`, `name: ice-pick`
  - Spike-upward ice pick, cold steel bluish highlight, charcoal iron collar,
    wrapped grip, plain cap pommel
  - `minVariations: 6`
  - Two authored variation hints (hooked tip; reinforced riveted collar)
  - Runtime key `equipment/weapon/ice-pick` preserved in comment
  - Production wave `floor2-equipment-weapon-axe` noted

---

## What is blocked

| Step | Status | Reason |
| ---- | ------ | ------ |
| `npm run sprites:run -- --brief briefs/weapons/ice-pick.yaml` | ❌ BLOCKED | `AZURE_OPENAI_ENDPOINT` missing |
| Judge candidates | ❌ BLOCKED | Generation never ran |
| `npm run sprites:approve` | ❌ BLOCKED | No run artifacts |
| `npm run sprites:checkin` | ❌ BLOCKED | Nothing to check in |
| `npm run sprites:asset-pr` | ❌ BLOCKED | No checkin issue |
| manifest.json entry for `equipment/weapon/ice-pick` | ❌ BLOCKED | Approve step skipped |
| `npm run verify:fast` | ⏸ DEFERRED | Nothing changed that needs verification |

---

## Diagnostic evidence

```
$ npm run sprites:run -- --brief briefs/weapons/ice-pick.yaml

sprites:run — 1 brief
gallery : launch requested but health endpoint is still unavailable (http://127.0.0.1:23370/api/health)

Failures:
  - briefs/weapons/ice-pick.yaml:
    Missing required env var 'AZURE_OPENAI_ENDPOINT'.
    Set it before running the sprite generator.
    See docs/agent-os/personas/graphics-designer.md for the expected list.

$ npm run setup:azure:env
Cloud/CI environment detected - skipping local .env.local setup.

$ az account show
ERROR: Please run 'az login' to setup account.
```

The `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY` environment variables
are absent from the runner environment. The `setup-azure-env.ps1` script
correctly detected the CI context and exited without writing `.env.local`
(it cannot bootstrap credentials in CI — that path is for local worktrees only).

---

## How to unblock

**Option A — Run locally (recommended for a single-sprite quick turnaround):**

1. On a machine with the correct Azure credentials:
   ```pwsh
   # Ensure .env.local is populated
   pwsh scripts/setup-azure-env.ps1 -IncludeStorage
   # Then generate
   npm run sprites:run -- --brief briefs/weapons/ice-pick.yaml
   ```
2. Judge the 6+ variants; approve the best with:
   ```bash
   npm run sprites:approve -- generated/runs/ice-pick/<run-id> --variant <N>
   ```
3. Check in:
   ```bash
   npm run sprites:checkin
   ```
4. The asset-pr skill folds the checkin issue into an art-only PR and arms auto-merge.

**Option B — GitHub Actions workflow dispatch:**

If the repository has a `asset-request` workflow that dispatches generation on Azure,
trigger it against the `copilot/create-ice-pick-icon` branch using the brief at
`briefs/weapons/ice-pick.yaml`.

**Option C — Add `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` as repository
secrets and re-assign this issue** to a Copilot coding-agent session that has
access to those secrets in the runner environment.

---

## Constraints to preserve

- Runtime key **must remain** `equipment/weapon/ice-pick` (no rename)
- manifest.json `briefId` must be `ice-pick`
- Approved PNG lands in `public/assets/generated/`
- Do NOT merge or arm auto-merge on this branch without explicit authorization
  (this is stacked work on top of G2-A / PR #1302)
- No wiring / engine changes needed for this PR (art-only fast lane)

## Systems touched

- `briefs/weapons/ice-pick.yaml` — new brief (committed)
- `public/assets/generated/manifest.json` — **not yet updated** (needs generation)
- `public/assets/generated/ice-pick-v1-var-N.png` — **not yet generated**
