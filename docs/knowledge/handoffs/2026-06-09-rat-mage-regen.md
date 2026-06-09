# Rat mage regen

- Regenerated `briefs/draft/enemies/rat-man-mage.yaml` with a stronger explicit prompt.
- Added a shared enemy prompt rule to keep mobs fully inside the frame with clear padding on all sides.
- Verified the new rat mage run passes all sensors and judge (`generated/runs/rat-man-mage/2026-06-09T16-22-15-1e09401c`).
- Focused checks passed: `npm run typecheck`, `npx vitest run tests/unit/sprites/build-prompt.test.ts tests/unit/sprites/load-brief.test.ts --reporter=dot`, and `npx eslint scripts/sprites/build-prompt.ts tests/unit/sprites/build-prompt.test.ts tests/unit/sprites/load-brief.test.ts --max-warnings 0`.
