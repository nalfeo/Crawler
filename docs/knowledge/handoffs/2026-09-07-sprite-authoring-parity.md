# Session Handoff: Restore sprite authoring parity

## Date

2026-09-07

## Persona

Producer -> DevOps Engineer, UX Designer, Asset Forge, QA Engineer

## Systems touched

sprite-pipeline, sprite-workflow, devtools, ci-policy

## Apples

3🍎 estimated, 3🍎 actual (exact under the tooling-only cap).

## What Was Done

- Re-audited the exact PR #3234 head after PR #4310 landed and current `main`
  was integrated. Ported the previously deferred pinned `proper-pixel-art`
  mesh-recovery bridge and made strict postprocessing use `pixel-grid` before
  resize instead of palette quantization.
- Provisioned Python 3.12 plus pinned mesh-recovery dependencies in sprite CI,
  restored source-sheet force/reset recovery, allowed guarded edits to durable
  synthesized candidate YAML, and added readable required facial-feature
  judging.
- Added 1x-8x pixel-crisp postprocess preview zoom, native-aspect-ratio Workflow
  variants, 1x animation-viewer defaults, stale-view reload after sheet swaps,
  and confirmation before destructive force reprocessing.
- Ported terminal handling for Goobers-owned issue restarts. Exact-ref queue
  repair was already present through current main; older request-context and
  exact-generation rewrites were rejected because they depend on superseded
  Workflow contracts and would weaken current lifecycle route validation.
- Verification passed: 276 focused sprite tests, 429 extension tests, 191 CI
  recovery tests, 1,611 `verify:fast` tests, and PR prerequisites.
- Observed in the real Workflow and animation canvases: a 192x256 variant
  rendered at 120x160 (ratio 0.75 preserved); postprocess zoom scaled the same
  final image from 120x160 at 1x to 240x320 at 2x with
  `image-rendering: pixelated`; and the 256x64 player walk sheet played as four
  native 64x64 frames at 1x.

## Key Decisions Made

- Keep `paletteMode: strict` as the durable brief field while changing its
  implementation contract to pinned pixel-mesh recovery, avoiding migration of
  existing briefs.
- Port only source improvements that preserve current lifecycle and route
  validation. Do not wholesale transplant PR #3234's older Workflow request
  architecture.
- Treat viewer zoom as ephemeral presentation state; it never enters persisted
  postprocess overrides.

## What's Next / Blockers

Publish the follow-up PR and let CI Recovery plus the merge train own final
landing. No art was generated, approved, or deleted.

## Retrospective

### Lessons Learned

Patch identity is not behavioral identity: several unique PR #3234 patches were
already present through stronger mainline implementations, while the useful
remaining ports were distributed across pipeline, extension, and recovery
commits. Real-canvas DOM geometry gave stronger evidence for native resolution
than static CSS inspection alone.

### Mistakes Made

Opening a store-backed run in the real postprocess debugger restored its brief
into the worktree. The observation side effect was detected by the status gate
and the exact untracked file was removed before publication.

### Opportunities for Future Improvement

Teach preflight and sprite test wrappers to discover the installed Python 3.12
launcher path on Windows automatically; the pinned bridge worked once the
existing launcher directory was added to `PATH`, but a fresh shell did not
discover it.
