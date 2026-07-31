# Handoff — Sprite Workflow: name/brief split, Azure reload, Brief/Sheet restart points

**Date:** 2026-06-27
**Session:** sprite-workflow-name-brief-reload-restart
**Persona:** Producer
**Apple estimate:** 🍎🍎🍎🍎🍎 | **Actual:** 🍎🍎🍎🍎 | **Verdict:** ⬇️ over-estimated (−1)

## Why

Operator feedback from the live skull-mace flow on the
`sprite-generation-workflow` DevTools page produced four asks, all landed here
(the first was committed earlier this session as `672c1654`):

1. **Re-approval should only be blocked on identical bytes.** Re-running
   post-processing and re-approving an _improved_ sprite was being rejected as a
   duplicate. (Committed earlier: hash-based guard.)
2. **Split the single "one-line brief" field into Name + Brief.** The Name is the
   identity/slug; the Brief is optional extra synthesis direction we sometimes
   want without baking it into the name.
3. **Reload sheets/briefs that still exist in Azure.** A wiped `localStorage`
   queue left no way to recover runs the sidecar still has in blob storage.
4. **Restart from any meaningful step.** Specifically, **Brief** (re-synthesize
   from scratch) and **Sheet** (keep the expensive AI sheet, redo post-processing
   onward) must both be restart points.

Cost-smart default throughout: **reuse the existing Azure sheet; only call OpenAI
again on an explicit Generate click.**

## What Was Done

### 1. Hash-based re-approval guard (committed `672c1654`)

`scripts/sprites/approve.ts` now computes a SHA-256 `contentHash` of the
processed PNG _before_ the guard and blocks re-approval **only** when the stored
hash equals the new hash (legacy entries without a stored hash fall back to
hashing the on-disk asset). `allowReapprove: true` still force-overwrites. The
DevTools approve button was relaxed to let the sidecar's 409 hash check be
authoritative. 16/16 tests in `tests/unit/sprites/approve.test.ts`.

### 2. Name/Brief split (queue model + synth pipeline)

`src/devtools/sprite-workflow-queue.ts`:

- `QueueItem` gains a `name` field. `makeItem`/`addItem` are now
  `(state, name, brief = '', requestedType = 'auto', source)`. The slug
  (`kebabName`, the brief id / asset identity) derives from **name** (falling
  back to brief only when name is empty). **Brief is never part of the slug.**
- **Back-compat:** items persisted before the split (only `brief`) deserialize
  with `name` derived from the stored name when present, else the brief;
  `kebabName` is preserved verbatim — **zero migration**.

The Brief is a _real_ optional synthesis hint, threaded end-to-end:

- `scripts/sprites/provider/synth-types.ts` — optional `briefHint` on
  `SynthesizeBriefRequest`.
- `scripts/sprites/provider/azure-chat-synth.ts` — `buildUserPrompt` adds an
  `Additional direction: <hint>` line **only** when the hint is non-empty, so
  prompt text + `promptHash` are unchanged for hint-less calls (provenance
  stable; a hint correctly changes provenance).
- `scripts/sprites/synthesize-brief.ts` — `briefHint` in
  `SynthesizeBriefOptions` + the request.
- `scripts/sprites/sidecar/server.ts` — `brief` added to
  `WorkflowSynthesizeBody`, validated, passed through `/api/workflow/synthesize`
  as `briefHint`.

`src/devtools-main.ts` composer split into `nameInput` + `briefInput`; the synth
handler sends `{ name: item.kebabName, brief: briefHint }` (sending
`item.kebabName` as the name keeps the run's `briefId === item.kebabName`, which
the queued-run matcher depends on).

### 3. Azure reload + Brief/Sheet restart points

Two pure helpers in `sprite-workflow-queue.ts`:

- `restartToBriefPatch(item)` → `stage: 'draft'`, clears every post-synthesis
  artifact (candidates, chosen brief, **run**, approval, metadata, errors),
  resets `resolvedType` to null for auto items (keeps an explicit type), and
  **keeps** name/brief/requestedType so the operator re-synthesizes from scratch.
- `restartToSheetPatch(item)` → keeps the expensive `run` (the AI sheet) and
  lands on `'sheet'`; clears approval/metadata/errors. When no run exists it
  falls back to `'candidates'` (if a brief/choice exists) or `'draft'`.

`src/devtools-main.ts`:

- **Restart buttons** `↺ Brief` / `↺ Sheet` with handlers that apply the patches
  via `updateItem` + re-render. Gating: Brief shows once the item is past
  `draft`/`synthesizing`; Sheet shows only when `item.run !== null`. Both hidden
  in the no-item branch.
- **Azure reload picker** (`reloadRow`): a select populated from
  `listSidecarRuns()`, a Refresh button, and a Load button that fetches the run
  summary (`fetchRunSummary`) and rebuilds `item.run` via the existing
  `applyRunToQueue(...)` (reusing `toWorkflowRunState`), landing the item at
  `'sheet'` with approval reset. Reloaded items have no chosen candidate/brief,
  so Generate stays disabled at `sheet` (reuse via PostProcess; regenerate via
  `↺ Brief`). Wired into `workflowPanel.append(...)` right after `queueBar`.
- `generateBtn` gating relaxed to allow the `sheet` stage — at `sheet`, Generate
  is the explicit "call OpenAI again" path; PostProcess reuses the sheet.

No backend change was needed for reload beyond the existing
`listRunsFromStore` / `resolveRunForRerun` / `materializeBriefFromStore` /
`hydrateRunDirFromStore` — the sidecar was already fully Azure-capable.

## Files Changed

| File                                                | Change                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `scripts/sprites/approve.ts`                        | Hash-based re-approval guard (`contentHash`) — committed `672c1654`                        |
| `src/devtools/sprite-workflow-queue.ts`             | `name` field; `makeItem`/`addItem` signature; back-compat deserialize; restart helpers     |
| `scripts/sprites/provider/synth-types.ts`           | optional `briefHint` on `SynthesizeBriefRequest`                                           |
| `scripts/sprites/provider/azure-chat-synth.ts`      | `Additional direction:` line in `buildUserPrompt` (only when hint present)                 |
| `scripts/sprites/synthesize-brief.ts`               | `briefHint` in options + request                                                           |
| `scripts/sprites/sidecar/server.ts`                 | `brief` in `WorkflowSynthesizeBody`; validate + pass through as `briefHint`                |
| `src/devtools-main.ts`                              | name/brief composer; synth payload; gating relax; restart buttons; Azure reload picker     |
| `tests/unit/devtools-sprite-workflow-queue.test.ts` | Updated callers to new `addItem` arg order; +name/brief, back-compat, restart-helper tests |
| `tests/unit/sprites/azure-chat-synth.test.ts`       | New: `buildUserPrompt` hint-threading tests                                                |
| `tests/unit/sprites/approve.test.ts`                | Hash-guard tests — committed `672c1654`                                                    |

## Validation

- `npm run verify:fast` ✓ (typecheck + lint + unit 206)
- `npm run verify` ✓ — full suite green through coverage, integration (49 pass / 1
  skipped), headless Floor 1 (68), and production build.
- Targeted: `devtools-sprite-workflow-queue.test.ts` 77/77; new
  `azure-chat-synth.test.ts` 4/4; `synthesize-brief` + `synth-cli` unchanged.

## Notes for Next Agent

- **`addItem` arg order changed** to `(state, name, brief, requestedType,
source)`. Any new caller must pass `name` first; `brief` is the optional
  synthesis hint, not the requestedType.
- The synth payload deliberately sends `name: item.kebabName` so `briefId`
  matches the queue item's slug — don't "fix" it to send the display name.
- Reloaded-from-Azure items have no chosen candidate/brief, so Generate is
  disabled at `sheet` by design (reuse via PostProcess; regenerate via `↺ Brief`).
- The user's **local skull-mace asset files are intentionally left UNSTAGED**
  (`public/assets/generated/manifest.json`, `src/shared/data/sprite-catalog.json`,
  `public/assets/generated/skull-mace-var-2.png`) — they are operator data, not
  part of this code PR.

## Apples

Estimated 🍎🍎🍎🍎🍎, actual 🍎🍎🍎🍎 (over-estimated by 1). A genuine model
refactor (name/brief + back-compat + two restart helpers), a five-file synth
pipeline threading, and substantial UI in the large `devtools-main.ts` (composer
split, restart buttons, Azure reload picker) — but it **reused** the existing
`applyRunToQueue` / `toWorkflowRunState` / `listSidecarRuns` / `fetchRunSummary`
plumbing and required **no** backend change for reload, landing just under the
Massive estimate.

## Systems touched

sprite-pipeline

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 1,
  "guards": {
    "pr-preflight": {
      "allow": 1
    }
  },
  "tools": {
    "create_pull_request": 1
  }
}
```
