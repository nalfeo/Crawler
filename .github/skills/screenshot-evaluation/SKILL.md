---
name: screenshot-evaluation
description: >-
  Evaluate an arbitrary PNG, JPEG, or WebP UX screenshot with evidence-bounded
  findings. Use for a UX screenshot supplied without a live Crawler page, or
  to compare real Phaser lab captures before and after a change.
---

# Screenshot Evaluation

Use this dev-session-only workflow when the input is a still image. It can
evaluate visual evidence; it cannot prove interaction, selection, filtering,
equip, or stat-update behavior.

## Capture contract

For Crawler UI changes, capture through the real Phaser lab renderer. Save the
same task filename in:

- `files/visual-review/before/<task>.png`
- `files/visual-review/after/<task>.png`

Use a metadata JSON object when task, viewport, UI scale, or declared regions
are known:

```json
{
  "task": "compare equipped ring against bag ring",
  "viewport": "1280x800",
  "uiScale": "1",
  "regions": []
}
```

## Run

```bash
npm run review:visual:arbitrary -- \
  --image files/visual-review/after/equipment.png \
  --metadata files/visual-review/equipment.metadata.json \
  --output files/visual-review/reviews/equipment-after.review.json \
  --min-score 75 \
  --min-coverage 85
```

The evaluator writes schema-versioned JSON with 0–100 rubric scores,
pixel-grounded evidence, player-cost findings, hard failures, and
`notObservable` limitations. It rejects unsupported images, malformed model
responses, missing rubric axes, and behavior claims presented as still-image
evidence.

## Review and feedback

Open the `screenshot-viewer` canvas after both images and review artifacts
exist. It pairs captures, shows the score/coverage/hard failures/findings, and
records feedback.

- Use **This task only** for a local implementation correction.
- Use **Promote to reusable guidance** and select the UX agent, visual-review
  skill, deterministic evaluation, or workflow target for a recurring issue.

Task feedback remains a session artifact. Reusable feedback also produces a
durable proposal under `docs/knowledge/ux-feedback/`; an agent must turn an
accepted proposal into the selected documentation, test, or workflow change
and update its status. Do not claim a promotion merely because the proposal
exists.

## Gate split

Screenshot scores and model findings are advisory evidence, never CI gates.
The release gate remains deterministic real-engine behavior, geometry, and
text-safety checks in `tests/e2e/`.
