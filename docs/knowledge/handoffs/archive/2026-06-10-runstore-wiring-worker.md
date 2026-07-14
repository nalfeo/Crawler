# Handoff — Azure Storage integration: RunStore wiring + worker loop (2026-06-10)

## What shipped

Implemented the three recommended next steps from the `2026-06-10-azure-storage-scaffolding` handoff. Azure provisioning (step 1 — `az deployment group create`) is left for the human to run from their PC.

### Changed files

| Path                                | Change                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `scripts/sprites/generate-one.ts`   | Accepts optional `store?: RunStore`; all artifact writes go through `store.put()`          |
| `scripts/sprites/sidecar/server.ts` | Accepts optional `store?: RunStore` in `SidecarDeps`; listing/serving routes use the store |

### New files

| Path                                | Purpose                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `scripts/sprites/worker.ts`         | `runWorker()` — poll loop over `AssetQueue`, calls `generateOne`, acks on success      |
| `scripts/sprites/worker-cli.ts`     | `sprites:worker` CLI entry point (env-driven factory wiring + SIGINT/SIGTERM shutdown) |
| `tests/unit/sprites/worker.test.ts` | 5 unit tests (abort, idle, success+ack, error no-ack, briefPath resolution)            |

### `package.json` additions

```json
"sprites:worker": "tsx scripts/sprites/worker-cli.ts"
```

---

## Key design decisions

### `generate-one.ts` — store.put replaces writeFileSync

- Default: `new LocalRunStore(path.join(outputRoot, 'runs'))` — same filesystem layout as before, fully backward compatible.
- Azure: pass `AzureBlobRunStore` via `options.store` and all artifacts go to Azure Blob.
- Removed: `ensureRunDirs`, `runPaths`, `writeSheet`, `writeVariant`, `writeSummary` calls from the orchestrator (they remain exported in `run-artifacts.ts` for other consumers).
- `storeKey(rel)` helper builds `<briefName>/<runId>/<rel>` keys.

### `sidecar/server.ts` — store-backed routes

- Default: `new LocalRunStore(deps.runsDir)` — same file layout as before.
- `/api/runs` now calls `listRunsFromStore(store)` (async, scans `*/*/summary.json` keys).
- `/api/runs/:briefId/:runId`, `/brief`, `/processed/:filename` routes use `store.has` + `store.get`.
- `safeJoin` is still called as a **pure segment validator** for URL params before they're interpolated into store keys. Comment added to clarify the pattern.
- Health endpoint now surfaces `storeBackend` for operator visibility.
- `listRuns(runsDir)` remains exported unchanged (tested by `sidecar-server.test.ts`).

### `worker.ts` — error handling

- On `generateOne` success: `msg.ack()` is called.
- On `generateOne` failure: **no ack** — the message becomes visible after the queue's visibility timeout and a fixed worker can retry it.
- `sleep()` checks `signal.aborted` before setting the timer (review feedback: pre-aborted signal).

---

## Environment variables (worker)

| Variable                 | Default        | Description                       |
| ------------------------ | -------------- | --------------------------------- |
| `SPRITES_ASSET_QUEUE`    | `noop`         | `noop` or `azure-queue`           |
| `SPRITES_RUN_STORE`      | `local`        | `local` or `azure-blob`           |
| `SPRITES_PROVIDER`       | `azure-openai` | Image provider                    |
| `SPRITES_WORKER_POLL_MS` | `5000`         | Poll interval when queue is empty |

---

## Recommended next steps

1. **Provision Azure** (user will run from PC):

   ```bash
   az deployment group create \
     --resource-group <rg> \
     --template-file infra/azure-storage.bicep \
     --parameters storageAccountName=crawlersprites
   ```

2. **Wire `run-artifacts.ts` legacy exports** — `ensureRunDirs`, `writeSheet`, `writeVariant`, `writeSummary` are no longer called from `generateOne` but are still exported. Consider adding a deprecation comment or removing them in a follow-up cleanup (check if `scripts/agent/shared/report.ts` or any test imports them directly).

3. **Sidecar delete route** — still uses `deps.runsDir` + `rmSync` directly. Wire to `store.remove(key)` for a fully backend-agnostic sidecar.

4. **Worker: vision + budget** — `worker-cli.ts` creates an image and text provider but not a vision provider or judge budget. Wire `createVisionProvider()` and `createJudgeBudget()` from their factories when they exist.

5. **Integration test against Azurite** — `infra/README.md` documents how to start Azurite locally. Adding a CI job that runs the generate-one integration test with `SPRITES_RUN_STORE=azure-blob` + Azurite would close the loop on end-to-end Azure coverage.

---

## Verification

- `npm run verify:fast` — 107 files, 1056 tests, all passing.
