# 2026-08-20-release-ux-baselines

**Date:** 2026-08-20  
**Author:** Copilot App (DevOps Engineer)  
**Session Branch:** nalfeo-release-ux-baselines  
**Parent Session:** Equipment UX redesign (nalfeo-equipment-ux-redesign)

## Summary

Implemented a durable, repo-owned release UX screenshot baseline process and registry that allows release agents and reviewers to capture and compare key UX surfaces against stable locked-in references (e.g., `main`) without repeatedly rebuilding and taking ad-hoc snapshots.

## Deliverables

### 1. Durable Baseline Repository Structure

Created `docs/knowledge/ux-baselines/` with:

- **README.md:** Complete process documentation covering:
  - Purpose and goals (stable reference, regression detection, deterministic gates, auditability)
  - Directory structure and manifest schema
  - Baseline metadata and review JSON format
  - Capture/update procedure via npm script
  - Usage in session scripts and screenshot viewer
  - Adding new surfaces to the registry
  - LLM review posture (advisory only, never CI-gating)

- **manifest.json:** Registry of tracked UX surfaces
  - Equipment panel (first tracked surface, 1280×800 viewport, ui-probe-lab capture)
  - Extensible structure: new surfaces can be added by editing manifest + updating capture script

- **schemas/baseline-manifest.schema.json:** JSON Schema v7 for manifest validation
  - Enforces required fields: id, label, viewport, captureSource, setupFile, enabled
  - Validates viewport dimensions (positive integers)
  - Enforces unique, lowercase surface IDs matching `[a-z0-9-]+`

### 2. Release Capture Script

**File:** `scripts/agent/release/capture-ux-baselines.ts`

The script:

- Reads `manifest.json` and identifies enabled surfaces
- For each surface, launches the configured capture source (currently: ui-probe-lab)
- Captures screenshot at registered viewport (1280×800 for equipment)
- Runs deterministic geometry checks (reuses visual-review-agent deterministic sensors)
- Writes PNG, review JSON, and metadata to `docs/knowledge/ux-baselines/releases/<ref>/<surface>/`
- Reports captured surfaces, any deterministic blockers, and exit code 0 on success
- Supports flags: `--ref` (release name, defaults to "main"), `--release-dir` (output directory override), `--with-llm-review` (optional advisory LLM assessment)

Baseline metadata records: surface id, release name, viewport, capture source, source commit SHA, capture timestamp, screenshot hash, and determinism check result.

**Usage:**

```bash
npm run release:capture-ux-baselines -- --ref main
npm run release:capture-ux-baselines -- --ref v0.1.0
npm run release:capture-ux-baselines -- --release-dir <abs-path>
npm run release:capture-ux-baselines -- --ref main --with-llm-review  # advisory LLM
```

### 3. Package.json Integration

Added npm script:

```json
"release:capture-ux-baselines": "tsx scripts/agent/release/capture-ux-baselines.ts"
```

### 4. Tests

**File:** `tests/agent/release-baselines.test.mjs`

Comprehensive test suite covering:

- **Manifest validation:** entries have required fields, IDs are unique/lowercase, viewports are positive
- **Schema validation:** schema.json exists and defines required properties
- **Directory structure:** baseline directories and README exist
- **Capture script:** script exists, has argument parsing, supports --ref/--release-dir flags
- **npm integration:** package.json defines the script correctly

All tests pass deterministic checks (no LLM, no external dependencies).

### 5. Baseline Metadata Format

Each baseline surfaces stores three files:

```
docs/knowledge/ux-baselines/releases/main/equipment/
├── equipment.png              # Screenshot at 1280x800
├── equipment.review.json      # Deterministic findings + optional LLM
└── metadata.json              # Capture provenance
```

**metadata.json structure:**

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
  "screenshotHash": "abc123...",
  "determinismCheck": "passed"
}
```

## Design Decisions

1. **Manifest-driven:** All tracked surfaces defined in `manifest.json`, not hardcoded in script. New surfaces require manifest + capture-script extension only.

2. **Deterministic first:** Geometry checks (element positions, alignment, overflow) are first-class; LLM review is captured as advisory metadata but never blocks release.

3. **Lineage capture:** Uses visual-review-agent's lineage fields (`--lineage-scenario`, `--lineage-state`, `--lineage-side`) for durable A/B tracking in screenshot-viewer canvas.

4. **Screenshot hash:** Metadata records SHA-256 of PNG so unchanged iterations are detectable, avoiding spurious "new baseline" entries when capture produces identical output.

5. **Extensible registry:** Structure supports adding new surfaces (e.g., inventory, quest panel, boss arena) by editing manifest and implementing capture logic in script.

6. **No CI gate (yet):** LLM review is advisory; deterministic geometry checks are mandatory but advisory in nature. A future CI gate could require deterministic blockers to be zero on release branches, but that is out of current scope.

## Files Changed

- `docs/knowledge/ux-baselines/README.md` (new, 6036 bytes)
- `docs/knowledge/ux-baselines/manifest.json` (new, 382 bytes)
- `docs/knowledge/ux-baselines/schemas/baseline-manifest.schema.json` (new, 1787 bytes)
- `scripts/agent/release/capture-ux-baselines.ts` (new, 8804 bytes)
- `tests/agent/release-baselines.test.mjs` (new, 6888 bytes)
- `package.json` (modified, +1 script)

## Validation Results

**Tests:** Running `npm run test:guards -- tests/agent/release-baselines.test.mjs` — all deterministic structure and schema tests pass.

**verify:fast scope:** release UX baseline scripts are tooling-only and fall under the 3🍎 tooling cap. No gameplay behavior or shipped data changes.

**Blockers:** None. Process is ready for use by release agents.

## Systems Touched

- **DevOps/tooling:** Release UX baseline capture pipeline, manifest registry, script validation
- **Visual review:** Reuses deterministic geometry checks from visual-review-agent

## Next Steps (Future)

- Add CI gate: require `npm run release:capture-ux-baselines -- --ref <branch>` to pass with deterministic blockers = 0 on release branches
- Extend manifest with additional surfaces: inventory, quest log, boss arena, etc.
- Wire screenshot-viewer canvas to load lineage pairs from `releases/` directory by default
- Document in release-checklist: capture baselines as part of release publication workflow

## Apple Estimate

**Estimated:** 3🍎  
**Actual:** ~2.5🍎 (deterministic, no game logic, no external dependencies for core process)

Tooling-only work capped at 3🍎 per repo policy; actual delivery was within cap.

---

**Co-authored-by:** Copilot App <223556219+Copilot@users.noreply.github.com>
