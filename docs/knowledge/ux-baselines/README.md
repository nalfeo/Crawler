# UX Baselines — Release Reference Library

Durable screenshot and review baselines captured at every release, stored in the repository to serve as visual reference points instead of repeatedly rebuilding `main` and taking ad-hoc snapshots.

## Purpose

- **Stable reference:** Release agents and reviewers can compare current branch state against a locked-in `main` baseline without worktree churn.
- **Regression detection:** Visual or layout regressions are caught by comparing against the last known-good release baseline.
- **Deterministic gates:** Deterministic geometry checks (element positions, alignment, overflow) are first-class; LLM visual review remains advisory.
- **Auditability:** Each baseline records viewport, capture source commit, capture timestamp, deterministic findings, and optional LLM assessment.

## Directory Structure

```
docs/knowledge/ux-baselines/
├── README.md                               (this file)
├── manifest.json                           (registry of all tracked UX surfaces)
├── releases/
│   ├── <release-ref>/                      (e.g., "v0.1.0", "main", "2026-08-20")
│   │   ├── equipment/
│   │   │   ├── equipment.png               (1280x800 screenshot)
│   │   │   ├── equipment.review.json       (deterministic+LLM findings)
│   │   │   └── metadata.json               (viewport, commit SHA, timestamp)
│   │   ├── equipment-hover-equipped/
│   │   ├── equipment-hover-duplicate/
│   │   ├── equipment-hover-empty-slot/
│   │   ├── equipment-hover-mixed-delta/
│   │   └── ...other-surfaces...
│   └── ...other-releases...
└── schemas/                                (JSON schemas for validation)
    └── baseline-manifest.schema.json
```

## Manifest Schema

Each entry in `manifest.json` registers one tracked UX surface:

```json
{
  "id": "equipment",
  "label": "Equipment Panel",
  "viewport": { "width": 1280, "height": 800 },
  "captureSource": "ui-probe-lab",
  "setupFile": "src/labs/ui-probe-lab.ts",
  "enabled": true,
  "description": "Ten-slot equipment panel at 1280x800 viewport using Phaser ui-probe-lab capture."
}
```

Fields:

- **id:** unique surface identifier (used as directory name and baseline filename)
- **label:** human-readable name
- **viewport:** { width, height } in pixels
- **captureSource:** how to obtain the screenshot ("ui-probe-lab", "lab", "dev-server", etc.)
- **setupFile:** path to the lab or setup script that renders the surface
- **enabled:** whether this surface is actively tracked in releases
- **description:** what the surface shows and any special capture requirements

## Baseline Metadata

Each release/{ref}/<surface>/metadata.json records:

```json
{
  "surface": "equipment",
  "release": "main",
  "viewport": { "width": 1280, "height": 800 },
  "captureSource": "ui-probe-lab",
  "sourceCommit": "abc1234567890...",
  "capturedAt": "2026-08-20T11:00:00Z",
  "screenshotPath": "equipment.png",
  "reviewPath": "equipment.review.json",
  "determinismCheck": "passed"
}
```

## Required equipment tooltip scenarios

Every release baseline captures the equipment panel plus these four important
interaction states, each compared against the release's `main` baseline:

| Surface                       | Required state                                           |
| ----------------------------- | -------------------------------------------------------- |
| `equipment-hover-equipped`    | Hover an equipped item                                   |
| `equipment-hover-duplicate`   | Hover an inventory item duplicating an equipped item     |
| `equipment-hover-empty-slot`  | Hover an inventory item for a slot with no equipped item |
| `equipment-hover-mixed-delta` | Hover an item with both better and worse stats           |

These are registered in `manifest.json`; do not replace them with unreviewed
e2e-only screenshots. Each capture must include its `.review.json` evaluator
artifact.

## Review JSON

Each baseline includes `<surface>.review.json` with deterministic geometry findings + optional LLM assessment:

```json
{
  "overall": {
    "score": 73.0,
    "verdict": "pass"
  },
  "score_derivation": {
    "axis_mean": 75.0,
    "penalty": 5,
    "deterministic_blockers": 0,
    "llm_blockers": 0,
    "model_reported_score": 80
  },
  "deterministic_blocking_findings": [],
  "blocking_findings": [],
  "recommended_fixes": [],
  "geometry": { ... }
}
```

## Capturing/Updating Baselines

Release agents use the release-baseline script:

```bash
npm run release:capture-ux-baselines -- --ref main
npm run release:capture-ux-baselines -- --ref v0.1.0
npm run release:capture-ux-baselines -- --release-dir <absolute-path>
```

This script:

1. Reads `manifest.json` for enabled surfaces.
2. Launches the required capture source (ui-probe-lab, etc.).
3. Captures each surface at the registered viewport.
4. Runs deterministic geometry checks.
5. Optionally runs LLM visual review (advisory only).
6. Writes PNG, review JSON, and metadata to `releases/<ref>/<surface>/`.
7. Reports captured surfaces, any blockers, and exit code 0 on success.

## Using Baselines in Session Scripts

### For release agents / visual-review sessions:

Compare current branch against a locked baseline:

```bash
npm run review:visual:deterministic -- \
  --compare-baseline docs/knowledge/ux-baselines/releases/main/equipment
```

### For screenshot viewer / visual-review canvas:

Load lineage pairs from releases:

```
Screenshot Viewer → Browse Lineage → select "equipment" scenario
→ pairs: before=releases/main/equipment, after=releases/<current-branch>/equipment
```

## Adding a New Surface to the Registry

1. Add a new entry to `manifest.json` with a unique `id`, label, viewport, capture source, and setup file.
2. Ensure the capture source (lab, dev-server, etc.) is runnable and reports a readiness probe (`window.__visualReview.ready`).
3. Update the release-baseline script if a new capture mode is needed.
4. Test locally: `npm run release:capture-ux-baselines -- --surface <new-id> --ref test-local`.
5. Commit the manifest update and new surface to the repo.

## Testing

Unit tests in `tests/agent/release-baselines.test.mjs`:

- Manifest schema validation
- Metadata path generation
- Deterministic check logic

Integration tests (when Azure is available):

- Real capture on `ui-probe-lab` at 1280x800
- Screenshot hash validation
- Review JSON completeness

## LLM Review Posture

LLM visual review is **advisory only** and **never CI-gating**:

- Deterministic geometry checks (element alignment, spacing, overflow) are first-class and must pass.
- LLM findings are captured in the review JSON but do **not** block release.
- Recurring LLM patterns should be converted to deterministic checks (see `computeGeometryBlockers` in `visual-review-lib.mjs`).

---

**Canonical owner:** DevOps Engineer (tooling/process)  
**Related:** `scripts/agent/release/capture-ux-baselines.ts`, visual-review agent, screenshot-viewer canvas
