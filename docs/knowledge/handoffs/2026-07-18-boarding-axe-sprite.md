# Handoff: Boarding Axe Sprite Asset — 2026-07-18

**Apple estimate:** 1🍎 — art-only, no review harness required

## Summary

Generated the boarding-axe weapon sprite for Floor 2 equipment icon (issue #1427).
Runtime key: `equipment/weapon/boarding-axe`.

The standard Azure-sidecar generation pipeline is credential-blocked in the coding-agent
CI environment, so the sprite was hand-authored as pixel art using pngjs. All sensor
gates were verified manually:

| Sensor                                         | Result                       |
| ---------------------------------------------- | ---------------------------- |
| binary-alpha                                   | PASS                         |
| opaque-ratio                                   | 0.215 (needs 0.10–0.65) PASS |
| silhouette-orientation-axis (vertical, tol 5°) | 4.7° → PASS                  |
| anchor at (32,56) opaque                       | PASS                         |

The sprite depicts a wide-headed boarding axe (nautical / pirate-themed): a broad iron
crescent blade centered over the haft, with a cutting edge on the left and a poll on the
right, iron rust weathering accents, dark-brown wooden haft, and iron socket collar.

## Systems touched

| File                                             | Change                                               |
| ------------------------------------------------ | ---------------------------------------------------- |
| `briefs/weapons/boarding-axe.yaml`               | New brief (weapon, Floor 2, 3 seed variations)       |
| `public/assets/generated/boarding-axe-var-0.png` | Approved sprite PNG (64×64)                          |
| `public/assets/generated/manifest.json`          | New entry `boarding-axe-var-0`                       |
| `src/shared/data/sprite-catalog.json`            | New catalog entry `generated:boarding-axe-var-0`     |
| `generated/runs/boarding-axe/…/`                 | Run directory + summary (not committed — local only) |

## Verification run

```
npm run verify:fast → 4254/4255 tests passed
```

The one failure (`epic-status.test.ts > rejects merge facts that point at a non-commit…`)
is a **pre-existing environment issue**: the hardcoded HANDOFF_COMMIT SHA
`461b8a334a018ebbf6e81aa7b31f81c74e08aa6b` does not exist in this shallow clone's object
store. It is unrelated to this PR's art diff.

## Unresolved issues

- **Azure sidecar generation not possible from coding-agent CI** — Azure OpenAI credentials
  are deliberately excluded from `copilot-setup-steps.yml` for security. For future wave
  generation, the maintainer should run `npm run sprites:run -- --brief briefs/weapons/boarding-axe.yaml`
  locally or trigger the `asset-request` workflow to regenerate with proper models.
- **No engine wiring yet** — The sprite is registered in the manifest and catalog.
  Wiring `equipment/weapon/boarding-axe` to this sprite in the equipment system is a
  separate code PR (≥3🍎, full review harness).

## Recommended next steps

1. **Wire the runtime key**: map `equipment/weapon/boarding-axe` → `boarding-axe-var-0`
   in `entity-sprite-mappings.json` or the equipment data layer.
2. **Regenerate via Azure sidecar**: trigger the `asset-request` workflow for
   `boarding-axe` to produce AI-generated variants; approve and swap in the best one.
3. **Run the full asset-pr batching flow** locally once more variants are available.
