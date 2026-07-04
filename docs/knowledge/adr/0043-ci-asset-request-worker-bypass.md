# ADR 0043: Asset-request CI worker bypass for Constitutional §3

## Status

Accepted

## Date

2026-07-03

## Estimated Complexity

🍎 — small, additive change: one gated bypass flag threaded into two
existing §3 guards (`synthesizeBrief`, `judgeVariant`) plus one new
workflow env variable and one new shared helper module.

## Context

Constitutional §3 (Deterministic CI Only) forbids running non-deterministic,
cost-generating Azure code paths from CI gates. The current guards are:

- `scripts/sprites/synthesize-brief.ts` — refuses when `env.CI` is set.
- `scripts/sprites/judge.ts` — refuses when `env.CI` is set.
- `scripts/sprites/checkin.ts`, `asset-pr.ts`, and several sidecar server
  routes — refuse when `env.CI` is set (these mutate repo state).

These guards are the correct default for **pull-request CI gates**, where
non-deterministic behaviour would poison the signal every build.

But the newly-added asset-request pipeline (`.github/workflows/asset-request.yml`,
introduced in PR #714) is a **different kind of CI job**: it drains a
webhook-driven queue of asset-request issues and produces draft briefs +
generated sprites that are **posted back to the issue for human review**.
It is not a pull-request gate.

Concretely:

- The workflow is triggered by `issues.labeled` on the `asset-request` label.
- Only issues from an author allowlist (`SPRITES_INGESTER_ALLOWED_AUTHORS`)
  are processed.
- Output is a draft brief YAML in `briefs/draft/` (never auto-committed)
  and generated sprite artefacts in Azure Blob (never auto-checked-in).
- The worker never calls `checkin.ts`, `asset-pr.ts`, or any of the sidecar
  server routes that push commits or file PRs. Those §3 guards remain
  strict.

Without a bypass, the worker cannot run its inner pipeline in CI: every
dequeued message fails immediately at `synthesizeBrief` with
`ci-refused`. In practice this means either (a) the asset-request CI job
is a no-op and the only actual processing happens on a locally-running
sidecar, or (b) we accept the §3 violation with an explicit ADR + a
gated bypass. This ADR chooses (b).

## Decision

Introduce one shared env flag: **`SPRITES_ALLOW_CI_PIPELINE`**.

When BOTH conditions hold:

1. `env.CI` is set (i.e. we are in a CI runner), AND
2. `env.SPRITES_ALLOW_CI_PIPELINE` is exactly `"true"`, `"1"`, or `"yes"`
   (case-insensitive after trim),

then `synthesizeBrief` and `judgeVariant` DO NOT throw `ci-refused` and
DO run their live Azure paths.

All other §3 guards — `checkin.ts`, `asset-pr.ts`, and the sidecar server
routes for judge/approve/check-in — **remain unchanged**. The bypass
scope is deliberately narrow: it opens ONLY the two code paths the
asset-request worker needs.

The flag is set in exactly one place: `.github/workflows/asset-request.yml`
on the drain step. Any other workflow adding `env: SPRITES_ALLOW_CI_PIPELINE`
must be treated as suspicious in code review.

### Implementation

- New module: `scripts/sprites/ci-bypass.ts`
  - `isCiEnv(env)` — replaces the ad-hoc `env.CI !== undefined` checks
    with the same normalisation `synthesize-brief.ts` already used.
  - `isCiPipelineBypassed(env)` — returns true only when `isCiEnv(env)`
    AND the flag value is exactly one of the accepted forms.
- `synthesize-brief.ts` — guard becomes `if (isCi(env) && !isCiPipelineBypassed(env))`.
- `judge.ts` — same pattern.
- `.github/workflows/asset-request.yml` — adds `SPRITES_ALLOW_CI_PIPELINE: 'true'`
  to the drain step's `env:` block.

## Consequences

### Positive

- The asset-request CI job actually processes queued issues, without
  requiring a dev workstation to keep a sidecar running.
- Users filing an asset-request issue (from an allowlisted author) see
  their sprite generated within minutes, from a cloud runner.
- Copilot cloud sessions can now trigger real sprite generation via
  the issue-based interface.

### Negative

- Every asset-request CI run costs Azure credits: 1 synth call +
  N image gens + N vision-judge calls (bounded by `brief.judge.maxVariants`,
  currently ≤6). Typical cost per run: ~$0.20–$0.40.
- CI output for asset-request runs is non-deterministic — re-running the
  same issue produces different sprites. This is acceptable because the
  output is a human-reviewed draft, not a gate signal.

### Risks

- **Flag leaks into unrelated workflows.** Mitigated by: (a) grep enforcement
  in code review, (b) the flag is only useful when combined with an
  Azure credential — which is also only wired into `asset-request.yml`.
- **Abusive asset-request issues run up cost.** Mitigated by: existing
  `SPRITES_INGESTER_ALLOWED_AUTHORS` allowlist (currently `nalfeo,app/copilot-swe-agent`),
  and `SPRITES_INGESTER_STALE_CLAIM_TTL_MS`/duplicate-fingerprint
  dedup preventing runaway re-enqueue loops.
- **Determinism regression in unrelated PRs.** Impossible: neither
  `synthesizeBrief` nor `judgeVariant` are called from any PR gate.
  The bypass has zero effect on the pull-request CI signal.

## Alternatives Considered

1. **Keep §3 strict; remove the drain step from CI.** CI would just
   enqueue; a local sidecar would still be required to process. Rejected:
   this defeats the point of the asset-request pipeline. Users would
   need to leave a dev machine on 24/7 for the feature to be useful.

2. **Keep §3 strict; make the drain step gracefully skip ci-refused
   errors.** The queue would fill up with un-processable messages that
   only a local sidecar could drain, and the messages would eventually
   be poison-pilled after `dequeueCount` retries. Rejected: same
   fundamental issue as (1), plus a worse failure mode.

3. **Different flag names / two flags.** Considered
   `SPRITES_ALLOW_CI_SYNTHESIZE` + `SPRITES_ALLOW_CI_JUDGE`. Rejected:
   they're always toggled together — the worker calls both. One flag
   keeps the workflow YAML shorter and prevents "only one half is on"
   configurations.

4. **Constitutional amendment to §3.** Rejected: §3 is still the correct
   default for the vast majority of code. The asset-request worker is an
   explicit, ADR-gated exception, not a policy change.
