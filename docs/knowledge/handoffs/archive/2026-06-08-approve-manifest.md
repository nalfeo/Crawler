# Handoff — Approve mutation endpoint + asset manifest (2026-06-08)

## What shipped

Closing the human-review → engine-pickup loop. The sprite pipeline can now
be driven end-to-end as: `npm run sprites:synth` → `npm run sprites:gallery`
→ click **Approve variant N** → asset lands in `public/assets/generated/`
and a manifest entry is upserted for the engine to load.

### Files

- **`scripts/sprites/approve.ts`** — pure `approveVariant({ runDir,
variantIndex, manifestPath, publicAssetsDir, fs?, now? }) => ManifestEntry`.
  All filesystem and clock IO is injected; the body has no globals. Reads
  the run's `processed/NN.png` + `processed/NN.scorecard.json` +
  `processed/NN.anchor.json` (optional) + `summary.json`, copies the PNG to
  `public/assets/generated/<brief.name>.png`, and upserts the manifest
  entry. Errors are a tagged union (`ApproveError` with `kind`) so HTTP
  callers can map cleanly to status codes.
- **`scripts/sprites/approve-cli.ts`** — `npm run sprites:approve --
<runDir> --variant N`. Same pure core, no sidecar. Exit codes: 1 general
  failure, 2 missing-resource, 3 corrupt-data.
- **`scripts/sprites/sidecar/server.ts`** — `POST
/api/runs/:briefId/:runId/approve` with body `{ variantIndex: number }`.
  Reuses the existing `safeJoin` path-traversal guard for both `:briefId`
  and `:runId`. Refuses mutation when `process.env.CI` is truthy (403)
  following the `judge.ts` pattern. CI gate is HTTP-layer only — the pure
  function and the CLI run anywhere, matching the constitutional concern
  "no sidecar mutations during CI".
- **`src/labs/sprite-gallery-lab/index.ts`** — "Approve variant N" button
  on the candidate detail panel. Disabled with a tooltip when the sidecar
  is unreachable (matches spec §F9 review-only fallback). Inline status
  shows the resulting asset path; on success re-fetches the run summary so
  any sidecar-side metadata refreshes. Exports `postApprove(briefId,
runId, variantIndex, fetcher?)` so the wire contract is unit-testable
  without a DOM.
- **`public/assets/generated/manifest.json`** — bootstrap empty manifest
  (`{ "version": 1, "entries": {} }`). `.gitignore` already carves
  `public/assets/generated/` out of ignore rules, so this file is tracked
  and ships in fresh clones (the engine needs something to read).
- **`package.json`** — added `"sprites:approve"` script.
- **`scripts/sprites/sidecar/cli.ts`** — updated startup route summary
  string.

### Tests

- `tests/unit/sprites/approve.test.ts` — 8 cases: copy + create manifest,
  alphabetical upsert, latest-wins overwrite, variant-not-found,
  processed-missing, run-not-found, manifest version mismatch,
  brief-anchor fallback / null anchor.
- `tests/unit/sprites/sidecar-server.test.ts` — 6 new cases for the POST
  route: happy path, CI refusal (rebuilds the server with `env: {CI:'1'}`),
  path traversal blocked, variant-not-found 404, run-not-found 404,
  bad-request 400.
- `tests/unit/sprite-gallery-lab-approve.test.ts` — 4 cases pinning the
  `postApprove` fetch contract (URL, method, headers, body, error
  propagation, slash-encoding).

Full `npm test --run` is green (882 passed, 1 pre-existing skip). `npm run
typecheck` and `npm run lint --max-warnings 0` both clean.

## Decisions made (open questions I owned)

| Question                           | Decision                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset identity supersede policy    | **Latest-wins**. Re-approval overwrites `public/assets/generated/<brief.name>.png` and replaces the manifest entry's `sourceRun`/`approvedAt`/`variantIndex`. Pinning (`-v2.png`) is YAGNI; a brief that genuinely needs both renames itself.                                                                   |
| Manifest schema version            | **`version: 1`**. Top-level `{ version, entries }`. Loaders should reject unknown majors so migration is a separate concern.                                                                                                                                                                                    |
| `anchor.source` value range        | **2-valued** (`'derived'` \| `'brief'`) with `null` for derive-failed. The 3-valued widening to `'derived-failed'` isn't surfaced by any consumer, and `null` already carries the same information.                                                                                                             |
| Manifest key shape                 | **Single-segment** `brief.name` (e.g. `'iron-sword'`), not the spec's `'weapons/iron-sword'` example. The brief schema regex `^[a-z0-9][a-z0-9-]*$` already constrains names to one safe segment, and the sidecar's `safeJoin` rejects slashes in route params. Type-grouped subfolders are a future migration. |
| `manifest.json` tracked vs ignored | **Tracked.** `.gitignore` already lists `public/assets/generated/` as a checked-in path. The engine needs something to read on a fresh clone; an empty `{ "version": 1, "entries": {} }` is the right zero state.                                                                                               |
| CI mutation refusal scope          | **Sidecar HTTP only.** `approveVariant()` is pure file IO and CLI runs are operator-driven. The constitutional concern is "no mutations via a running server during CI", not "no `fs.writeFile` ever".                                                                                                          |

## Manifest entry shape

```json
{
  "briefId": "iron-sword",
  "spriteName": "iron-sword",
  "assetPath": "generated/iron-sword.png",
  "approvedAt": "2026-06-08T15:30:00.000Z",
  "sourceRun": "generated/runs/iron-sword/2026-06-08T12-00-00-deadbeef",
  "variantIndex": 5,
  "anchor": { "x": 8, "y": 13, "source": "derived" },
  "sensorScore": "7/7",
  "judgeScore": "4"
}
```

`anchor` is `null` when derive-failed. `judgeScore` is `null` when the
variant wasn't judged (sensor-only path).

## Workflow gotchas (carry-forward for next session)

- `prettier --check` runs against the **whole tree** in CI but the
  `package.json` `format` script only targets `src/**`, `tests/**`,
  `scripts/**`. Run `npx prettier --write .` before every push or CI will
  pick up `public/` / `docs/` drift.
- Branch protection still requires a stale `ci` context that no current
  workflow produces. PRs are expected to need `gh pr merge <N> --squash
--admin` until that protection is updated.

## Next up (not in this PR)

- **Engine asset loader**: consume `public/assets/generated/manifest.json`
  at boot, register textures with Phaser keyed by `briefId`/`spriteName`.
  Likely lives in `src/engine/` with a tiny ECS shim in `src/game/`. Until
  this lands the manifest is approved-but-unloaded.
- **Batch approve CLI**: take a list of `<runDir>=<variant>` pairs so a
  designer can rubber-stamp a synthesis run from the terminal.
- **`anchor.source: 'derived-failed'`** widening if/when a consumer needs
  to distinguish "we tried and it didn't work" from "we never tried".
