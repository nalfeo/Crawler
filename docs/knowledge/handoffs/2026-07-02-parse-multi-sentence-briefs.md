# Session Handoff: Relax asset-request brief parser for multi-sentence briefs

## Date

2026-07-02

## Persona(s) adopted

**Graphics Designer** — the change lives in the sprite asset-generation pipeline
(`scripts/sprites/asset-request.ts`), which owns the asset-request issue contract that
feeds sprite briefs. No rendering/ECS layers were touched, so the specialist persona fit
better than Producer here.

## Routing verdict

✅ right persona — a single-owner, single-subsystem parser/contract fix with a clear
blast radius; no cross-layer coordination was needed beyond the ADR.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — the fix itself was a moderate regex + validation rewrite, but the
surrounding rigor a cross-system contract change demands (ADR, tier-3 review harness with
plan review + dual code-review rounds, a deterministic before/after harness proving
fingerprint stability, and 29 parser tests) landed it squarely at 3.

Hello kitties: 3/5 = 0.60 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-01-parse-multi-sentence-briefs.review-ledger.json`
Stages (tier 3 = `plan_review` + `code_review`): plan_review ✅ · code_review ✅
`npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-01-parse-multi-sentence-briefs.review-ledger.json` → **pass** (valid 3-apple ledger).

- **plan_review** (gpt-5.4, rubber-duck): 4 concerns raised, all 4 adopted (full-section
  capture boundary, fingerprint-stability proof requirement, raw-vs-normalized cap
  asymmetry, and the unrendered `${{ }}` marker guard).
- **code_review** (loop until clean): round 1 gpt-5.4 → 0 concerns; round 2
  claude-sonnet-4.6 → 0 concerns (independently re-ran the sha256 to confirm the 4
  hardcoded fixture fingerprints are correct, verified no ReDoS, correct section
  boundaries, and cap behavior). Both rounds clean.

## What Was Done

Relaxed the asset-request issue parser so rich multi-sentence / multi-line `### Brief`
sections parse into valid requests, unblocking issues **#588–#626** that the sidecar
ingester was silently skipping.

Core change — `scripts/sprites/asset-request.ts`:

- Replaced `isSingleSentence` (length 8–240, no newline, terminal `[.!?]`, exactly-one
  terminal punct) with honest `isValidBriefText`: allows newlines and multiple
  sentences; no terminal-punctuation requirement; length bounds on the
  **normalized** (whitespace-collapsed) text of **8–2000** chars, plus a raw pre-trim
  cap of **4000** applied before normalization on the verbatim marker path.
- `parseAssetRequestIssueBody` now CRLF-normalizes the body up front, and
  `parseIssueFormBody` captures the **FULL** `### Brief` section (`[\s\S]*?` up to the
  next `\n### ` heading / `\n<!--` marker / EOF) instead of only the first line.
- Added `normalizeBriefText(s) = s.trim().replace(/\s+/g, ' ')`; the stored form-path
  `briefSentence` is normalized to a clean single line. Because
  `fingerprintAssetRequest` already collapses `\s+`, this is a **no-op for the 26
  currently-valid briefs → their fingerprints are byte-identical** (no spurious
  re-enqueue).
- Added `containsUnrenderedTemplate` guard: the marker path rejects payloads whose
  `name`/`briefSentence` still contain unrendered `${{ }}` GitHub Actions expressions,
  so a failed workflow render cleanly falls back to the rendered form headings.
  Marker-path only (a human form brief may legitimately mention `${{`).
- Applied the SAME relaxed `isValidBriefText` rule to BOTH the issue-form path and the
  `asset-request:v1` JSON-marker `briefSentence` path. `### Name` / `### Type` handling
  and `SPRITE_TYPES` validation are UNCHANGED. Public API is stable.

Supporting changes:

- `tests/unit/sprites/asset-request.test.ts` — +22 tests (29/29 pass), reading byte-exact
  real bodies from the new committed fixture.
- `tests/fixtures/asset-request-issues.json` — committed byte-exact bodies for
  #555 (single-sentence baseline) / #588 / #607 / #626.
- `.github/ISSUE_TEMPLATE/asset-request.yml` — Brief field description/placeholder updated
  to describe the multi-sentence contract.
- `docs/knowledge/adr/0038-asset-request-multi-sentence-brief.md` — ADR (Accepted) for the
  contract relaxation (2 consumers: ingest parser + downstream brief synthesis), plus
  registration in `docs/knowledge/adr/README.md`.

## What's Next

- Merge the PR (task asked for a PR, not an auto-merge — left for the creator/human).
- Once merged, the sidecar ingester will pick up #588–#626 on its next sweep; a downstream
  sibling session owns the generation-side fixes (bad-grid slice gate + worker poison
  loop) so those briefs actually render.
- Optional cleanup (out of scope here): 3 pre-existing merged ADRs
  (0034-config-driven-sprite-wiring, 0034-quarter-tile-fov-resolution,
  2026-06-30-mob-appearance-multiplayer-variants) fail `docs:check` due to inline
  `**Status:**` instead of a `## Status` heading and a non-expandable glob path. Not
  gating (`docs:check` is not part of `verify`), left untouched.

## Blockers

None. Scope boundary respected — did not touch `worker.ts`, `generate-one.ts`, or
`slice-sheet.ts` (owned by the sibling generation session).

## Branch State

- Branch: `nalfeo-parse-multi-sentence-briefs`
- All tests passing: yes
- PR created: yes — see PR opened from this branch (holistic title/description covering
  parser + tests + fixture + template + ADR).

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl` (this is repo test-fixture
telemetry — guard names `boom`/`ctx-a`/`pr-a`/`shell-bad` are unit-test guards, not
real session events — but pasted per the handoff rule):

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 15,
  "guards": {
    "boom": { "crash": 2 },
    "ctx": { "allow": 1 },
    "ctx-a": { "allow": 1 },
    "ctx-b": { "allow": 1 },
    "edit-bad": { "bypass": 1 },
    "edit-guard-self-protection": { "ask": 2 },
    "pr-a": { "deny": 1 },
    "pr-b": { "deny": 1 },
    "pr-hard": { "deny": 1 },
    "pr-warn": { "allow": 1 },
    "shell-a": { "deny": 1 },
    "shell-bad": { "deny": 2 }
  },
  "tools": { "create_pull_request": 4, "edit": 6, "powershell": 5 }
}
```

## Test Results

- `npm run verify:fast` → green (typecheck + lint + changed unit tests).
- `npm run verify` → all real suites green: **2866 unit + 49 integration + 17 headless**
  passing; typecheck, lint, format, build all pass. (Before the ledger + handoff + apple
  files existed, Step 9 PR-prereqs correctly flagged the missing handoff and the
  unrecorded `code_review` ledger stage; both are now resolved.)
- Parser suite specifically: `tests/unit/sprites/asset-request.test.ts` → **29/29 pass**.
- Deterministic before/after harness (session-only, not committed) over the real
  65-issue baseline (`files/open-asset-issues.json`): **oldParsed=26 · newlyParsed=39 ·
  now 65/65 parse · 65 unique fingerprints · 0 dupes · fingerprintChangedAmongOld=0**.

## Key Decisions Made

- **Normalized 2000 / raw 4000 caps.** 2000 ≈ 4× the longest observed real brief (498)
  and ~8× the old single-sentence norm — generous for multi-paragraph briefs while still
  rejecting runaway pastes (whole templates/novels). Documented inline + in the ADR.
- **Normalize form-path `briefSentence`, keep marker-path verbatim.** Only the shared
  validation rule is applied to both paths; the form path additionally collapses
  whitespace so the stored value is a clean single line. Marker payloads are preserved
  byte-for-byte (that contract is producer-controlled).
- **Kept the public parse API stable** (`parseAssetRequestIssueBody`,
  `fingerprintAssetRequest`) — renamed only the private helper.
- **Wrote ADR 0038** because the contract is consumed by 2 systems (ingest + synthesis),
  per the ADR-required rule.

## Retrospective

### Lessons Learned

- `fingerprintAssetRequest` already collapsed `\s+`, which is what made whitespace
  normalization a provable no-op for existing briefs — the single most important
  invariant for avoiding a mass spurious re-enqueue. Proving it with a real-baseline
  harness (fingerprintChangedAmongOld=0) was far more convincing than reasoning alone.
- The empty-`### Brief` edge is subtle: a naive `\s*\n+` separator after the heading
  bleeds the NEXT section into the capture. Using `[^\S\n]*\n` (consume only the heading
  line's own trailing spaces + its single newline) makes an empty brief capture `""` and
  reject correctly.
- The raw-cap (4000) vs normalized-cap (2000) asymmetry only bites the verbatim marker
  path, because the form path normalizes before validating. Tests must target each path
  deliberately, or a "raw cap" test silently exercises the normalized cap instead.

### Mistakes Made

- First test run had 2 failures: I initially dropped the "unrendered `${{ }}` marker is
  invalid" behavior, and I placed a raw-cap rejection test on the form path (where
  normalization subsumes it). Early signal: the failing assertions pointed exactly at the
  path-asymmetry the plan review had already flagged — I should have encoded that
  asymmetry into the tests from the start rather than rediscovering it.

### Opportunities for Future Improvement

- `docs:check` is not wired into `verify`, so 3 merged ADRs have been failing it unnoticed.
  Worth a small future session to fix those and add `docs:check` to a non-blocking CI lane.
- A tiny shared `normalizeBriefText`/fingerprint helper is now duplicated in spirit
  between parser and fingerprint; a future refactor could export one canonical
  normalizer to guarantee they never drift.
