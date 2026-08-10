# Session Handoff: postprocess canvas ext — persist/mutation slice (Slice C2)

## Date

2026-07-09

## Persona

Producer → Tools/DevEx Engineer (canvas-extension port, mutation slice)

## Systems touched

devtools, sprite-workflow

## Apples

3🍎 estimated, 3🍎 actual (🎯 on estimate). Honestly re-scored **down** from
C1's 4🍎 — and this is the honest-scoring line done right, not gaming the tier
to dodge review. C2 rebuilds **none** of C1's novel infrastructure
(per-instance loopback server, SSE lifecycle, sidecar proxy, sheet-slice
overlay projection, browser-crop→base64 live relay, `toString()` client
injection). It is **additive within one subsystem**: a persist relay that
mirrors the existing preview relay + one pure payload builder + 5 authoring
controls + confirm/double-submit guards + read-back. That is a genuine 3, not
a 4. 3🍎 harness = separate-model **plan review** + **code-review loop until
clean** (no multi-model tax — appropriate for a reversible, scratch-validatable,
single-subsystem mutation).

## What Was Done

Slice C2 of the DevTool-canvas epic: adds the monolith postprocess page's
**persisting** authoring controls (the "Apply changes" flow that writes
`postprocessOverrides` to the sprite run store) to the already-merged **C1**
read-only postprocess canvas extension (`.github/extensions/postprocess/`),
**alongside** the untouched monolith. Full parity for postprocess =
C1 (read) + C2 (this).

Commits on `nalfeo-postprocess-c2-mutation` (rebased onto `origin/main`):

- `5cad101b` — feat: add persist/mutation slice to postprocess canvas ext (C2)
- `61984034` — fix: guard against double-submit on postprocess Apply

### Persist path (server-authoritative)

- **`extension.mjs`** — NEW `POST /api/persist-postprocess` route. Reads the
  JSON body → `normalizePersistRequest(body)` (validate/shape) →
  `buildPersistPostprocessPayload(args)` (**rebuild server-side — never trust
  the client shape**) → `relayPersistPostprocess({briefId, runId, payload})` →
  on success returns `{ok:true, state}` (NO SSE broadcast, like `/api/select`;
  the in-iframe fetch renders once). The relay POSTs the sidecar
  `POST {SIDECAR}/api/runs/:briefId/:runId/postprocess` — the same monolith
  endpoint (`src/devtools-main.ts` `renderPostprocessDebugger` `:5728`,
  body assembly `:5733–5754`). This wires the **`renderPostprocessDebugger`**
  controls, **NOT** the workflow-gallery `postprocessBtn` `:7127` (a distinct
  surface — the footgun C1 flagged; explicitly avoided).
- **`lib/postprocess-client.mjs`** (extended, all PURE / no I/O in the builder):
  - `buildPersistPostprocessPayload(args)` — the riskiest piece, exhaustively
    unit-tested. `mode:'reset'` → `{mode:'reset'}` (short-circuit).
    `mode:'replace'` → `{mode:'replace', options:{background:{colorToleranceSq,
fringeToleranceSq}}, facing:{variantIndex,direction,[applyToAllVariants]},
[manualAnchor], [variantIndexes:[variantIndex]]}`. `manualAnchor` is
    **tri-state**: clear→`null`, set→`{variantIndex,x,y,[applyToAllVariants]}`,
    untouched→**key omitted**. `variantIndexes:[variantIndex]` present **only**
    when `!applyToAll` (omitted for all-variants fan-out and for reset).
  - `normalizePersistRequest(body)` — validates required `briefId`/`runId`,
    coerces `variantIndex`, `mode`, `facingDirection`, booleans, tolerances.
  - `relayPersistPostprocess(...)` — **never throws**: network throw →
    `{ok:false,reason:'network'}`; non-2xx → `{ok:false,reason:'persist-failed'}`;
    read-back summary throw → `{ok:true,summary:null}`.
  - `extractAppliedFacing` / `extractAppliedManualAnchor` — read the persisted
    overrides back for the panel's "applied" display.
  - `clampTolerance` = `max(0, min(195075, round(v)))` (MAX = 255²·3 = 195075);
    defaults color 4000 / fringe 12000 (`DEFAULT_BACKGROUND_TWEAKS`).
- **`lib/sidecar-client.mjs`** (extended) — `runPostprocessUrl` +
  `urls.runPostprocess` (the persist endpoint URL builder).
- **`lib/anchor.mjs`** (NEW, pure, self-contained for `toString()` injection) —
  `finalImageClickToAnchor` (click px → anchor {x,y} in image space) and
  `anchorMarkerPercent` (anchor → marker % for the overlay dot). References only
  `Number.isFinite` / `Math.*`.
- **`renderer.mjs`** (extended) — an **Apply-overrides authoring panel** distinct
  from C1's non-persisting tuning preview: facing select, apply-scope select
  (this-variant / all-variants), a **clickable final image** anchor picker +
  x/y inputs + marker dot, "Reset anchor" and "Apply changes" buttons, and a
  status line seeded from the persisted overrides. Local state machine stages
  facing/scope/anchor/reset into `pendingMode`; the persist POST fires **only**
  on "Apply changes".

### Guards

- **Confirm-guard** — `isDestructivePersist({mode,applyToAll})` (true when
  `reset` OR `applyToAll`) gates a `window.confirm()` in the client **before**
  the persist POST fires — not cosmetic. Single-variant replace applies without
  a prompt (matches the monolith's no-confirm-on-Apply semantics); the
  broad/clobbering actions (all-variants, reset) confirm.
- **Double-submit guard** (`61984034`) — a module-level `applyInFlight` flag +
  disabling `authoringApplyBtn` during the in-flight persist prevents a rapid
  double-click from firing two identical POSTs + a redundant re-render (the same
  duplicate-relay class C1 fixed on the boot path). `applyInFlight` is reset
  unconditionally in `.then` (before the ok/fail split) and in `.catch`, so it
  can never get permanently stuck. Regression asserted in `renderer.test.mjs`.
- **Server rebuilds + clamps** the payload from validated primitives — the
  client shape is never trusted.
- **Non-destructive to the monolith** — `src/devtools-main.ts`, `devtools.html`,
  `src/devtools/*` untouched (verified: diff is `.github/extensions/postprocess/**`
  - the ledger only).

### Observed on the REAL artifact (instance server, NOT a lab)

Deterministic round-trip against the **real** per-instance loopback server
(`http://127.0.0.1:61587/`) `POST /api/persist-postprocess`, against the live
sidecar (worktree port 10030, azure-blob), on a **scratch** run
`cactusfolk-elite-desert-capo-v1 / 2026-07-09T08-50-35-665d50f3` (16 candidates,
chosenIndex 2, not-promoted draft):

- **before** — read-back via sidecar `runSummaryUrl` `.postprocessOverrides`:
  `{options:{}, manualAnchor:null, facing:null, appliedMode:"default"}` (pristine).
- **after (replace)** — persisted `{mode:'replace', colorToleranceSq:4321,
fringeToleranceSq:11111, facing v2 → right}` → read back
  `{options:{background:{colorToleranceSq:4321,fringeToleranceSq:11111}},
facing:{variantIndex:2,direction:"right"}, appliedMode:"replace"}` — **exact
  round-trip**.
- **after (reset, leave no residue)** — persisted `{mode:'reset'}` → read back
  `{options:null, facing:null, appliedMode:"reset", profilePath:null}`; **16
  candidates intact** (non-destructive). `appliedMode:"reset"` (explicit reset)
  vs the pristine `"default"` are BOTH the default postprocess output — zero
  functional residue on the real committed brief.
- **before/after monolith** — untouched; C1 already confirmed `?page=postprocess`
  boots clean. (Visual side-by-side stays blocked by shared-box browser-MCP
  contention across the 3 sibling overnight sessions; deterministic checks are
  the stronger, prompt-preferred bar.)

### Deterministic parity checks (primary evidence)

**91/91** postprocess ext tests pass (55 from C1 + 36 new for C2):
`persist-payload.test.mjs` (NEW — exhaustive builder branches: replace vs reset,
tri-state manualAnchor, applyToAll fan-out, variantIndexes presence rule,
tolerance clamp), `anchor.test.mjs` (NEW — click→anchor + marker math),
extended `postprocess-client.test.mjs` (normalize + relay never-throws
contract), extended `sidecar-client.test.mjs` (`runPostprocess` URL), extended
`renderer.test.mjs` (authoring panel + confirm-guard + double-submit guard
serialized into the client HTML), `harness-drift.test.mjs` unchanged. Glob
already on `test:guards` (added by C1; survived the rebase).

## Review harness (3🍎)

- **Plan review** (separate model) — gpt-5.4 rubber-duck, verdict
  `approved_with_changes`, 7/7 concerns resolved, `plan_divergence: minor`.
- **Code-review loop** — converged clean. One concern surfaced (Apply button not
  disabled during in-flight persist → double-click double-POST) and RESOLVED in
  `61984034`; the definitive review (claude-sonnet-4.6, on the complete rebased
  branch incl. the fix) found **no significant issues** across all 5 high-value
  checks (payload-builder mode/tri-state/variantIndexes correctness; confirm-guard
  gating; `relayPersistPostprocess` never throws; injected fns self-contained;
  `applyInFlight` cannot stick). One benign already-handled code smell noted, no
  action needed.
- **Ledger**
  `docs/knowledge/review-ledgers/2026-07-09-postprocess-c2-mutation.review-ledger.json`
  — `plan_review` + `code_review` complete; `npm run review:ledger -- validate`
  exits 0.

## Key Decisions Made

- **"Reset anchor" (mode:'replace', persists `manualAnchor:null`) vs "Reset to
  defaults" (mode:'reset').** The panel's per-control "Reset anchor" clears just
  the manual anchor by staging `manualAnchorClear` and persisting with
  `mode:'replace'` (so tolerances/facing survive), matching the monolith's
  anchor-reset. The distinct full `mode:'reset'` (clears ALL overrides to
  defaults) is the confirm-guarded broad action. Both round-trip; don't conflate.
- **`currentAnchor` single-variant simplification.** The picker stages a single
  `{x,y}` for the active variant; the all-variants fan-out is expressed via
  `applyToAllVariants` on the payload (so one click can broadcast) rather than
  per-variant anchor arrays — faithful to how the monolith's Apply assembles
  `manualAnchor` from the active picker + scope select.
- **Persist wires `renderPostprocessDebugger` `:5728`, NOT gallery
  `postprocessBtn` `:7127`** — the flagged footgun; the gallery button is a
  different surface (Slice B's run-inspection lane).
- **No SSE echo on persist** (like `/api/select`) — the in-iframe fetch renders
  the returned state once; SSE `pushState` stays reserved for external actions.
- **Server-authoritative payload** — `normalizePersistRequest` +
  `buildPersistPostprocessPayload` rebuild + clamp everything; the client shape
  is advisory only.

## What's Next / Blockers

- **Off-ramp (decision #5) stays open** — the maintainer may decide read-only
  (C1) is sufficient for these debug tools. If so, close this C2 PR won't-merge
  (cheap; building it now does not foreclose that). Default per the stated
  overnight goal = **full parity** (C1 + C2).
- **Coexistence window** — the ext lives alongside the monolith until all 5
  slices prove parity + the maintainer signs off; only then does the monolith
  retire.
- **Persist is data-gated like C1** — a run needs a valid brief/run in the store
  for the sidecar to persist; draft-only runs degrade the same way C1 traces do.

## Retrospective

### Lessons Learned

- The double-POST class is recurring across this ext (C1 boot path, C1
  `/api/select`, now C2 Apply). Any user-triggerable expensive relay needs an
  in-flight/idempotency guard from the start — treat "can this fire twice?" as a
  checklist item on every new POST control.
- A pure, closure-free payload builder is the right shape for a mutation slice:
  it makes the riskiest logic exhaustively unit-testable on the Node side and
  keeps the server as the single source of truth (client never trusted).
- Honest downward re-scoring (4🍎→3🍎) is correct when the new work reuses prior
  infra — score the actual diff, not the subsystem's history. Paying the 4–5🍎
  adversarial+multi-model tax on genuine-3 work is the waste the review-harness
  side-project exists to cut.

### Mistakes Made

- Initially shipped the Apply button without an in-flight guard even though C1
  had already taught the double-POST lesson on two other paths — the code-review
  loop caught it. The pattern should have been applied proactively.

### Opportunities for Future Improvement

- A shared in-flight/idempotency helper in the harness would stop every mutation
  slice re-implementing the `applyInFlight` + button-disable dance.
- A shared graceful-degrade panel renderer in the harness (carried from C1)
  would stop B–E each re-implementing sidecar-down/wrong-repo states.
