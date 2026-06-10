# Handoff — Azure Storage scaffolding (2026-06-10)

## What shipped

Added Azure Blob Storage + Azure Storage Queue abstractions to the sprite
pipeline, plus Bicep infrastructure template and setup docs.

### New files

| Path                                           | Purpose                                                    |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `scripts/sprites/store/types.ts`               | `RunStore` interface + `StoreNotFoundError`                |
| `scripts/sprites/store/local-store.ts`         | `LocalRunStore` — fs-backed (existing behaviour)           |
| `scripts/sprites/store/azure-store.ts`         | `AzureBlobRunStore` — blob-backed                          |
| `scripts/sprites/store/index.ts`               | `createRunStore()` factory                                 |
| `scripts/sprites/queue/types.ts`               | `AssetQueue`, `AssetRequest`, `DequeuedMessage` interfaces |
| `scripts/sprites/queue/noop-queue.ts`          | `NoopAssetQueue` — local dev stub                          |
| `scripts/sprites/queue/azure-queue.ts`         | `AzureStorageQueue` — Azure-backed                         |
| `scripts/sprites/queue/index.ts`               | `createAssetQueue()` factory                               |
| `scripts/sprites/queue-cli.ts`                 | `npm run sprites:enqueue` CLI                              |
| `infra/azure-storage.bicep`                    | One-time Bicep provisioning template                       |
| `infra/README.md`                              | Setup docs: az commands, Azurite, env vars                 |
| `tests/unit/sprites/run-store.test.ts`         | LocalRunStore unit tests                                   |
| `tests/unit/sprites/run-store-factory.test.ts` | createRunStore factory tests                               |
| `tests/unit/sprites/asset-queue.test.ts`       | NoopAssetQueue + createAssetQueue tests                    |

### Modified files

- `scripts/agent/security/check-deps.ts` — added `@azure/` to TRUSTED_SCOPES
- `package.json` — `@azure/storage-blob@12.32.0`, `@azure/storage-queue@12.30.0` devDeps + `sprites:enqueue` script

## Key design decisions

- **Opt-in via env vars**: `SPRITES_RUN_STORE=azure-blob` and `SPRITES_ASSET_QUEUE=azure-queue` activate Azure backends. Defaults remain `local` / `noop` — no existing workflow changes.
- **Private constructors with static factories**: Both Azure classes use `ClassName.fromOptions(opts)` and `ClassName.fromConnectionString(str)` to avoid TypeScript private-field cast issues.
- **Approved sprites stay in-repo**: Only ephemeral run artifacts (`generated/runs/`) go to Azure. `public/assets/generated/` and `sprite-catalog.json` remain committed.
- **`AzureBlobRunStore.fromOptions` / `AzureStorageQueue.fromOptions`** are the preferred construction paths for the factories. `fromConnectionString` supports Azurite (`UseDevelopmentStorage=true`).

## Environment variables

| Variable                                 | Default          | Description                       |
| ---------------------------------------- | ---------------- | --------------------------------- |
| `SPRITES_RUN_STORE`                      | `local`          | `local` or `azure-blob`           |
| `SPRITES_ASSET_QUEUE`                    | `noop`           | `noop` or `azure-queue`           |
| `AZURE_STORAGE_ACCOUNT`                  | —                | Account name (required for Azure) |
| `AZURE_STORAGE_KEY`                      | —                | Account key (required for Azure)  |
| `AZURE_STORAGE_CONNECTION_STRING`        | —                | Alternative to account+key        |
| `AZURE_STORAGE_RUNS_CONTAINER`           | `generated-runs` | Blob container name               |
| `AZURE_STORAGE_QUEUE_NAME`               | `asset-requests` | Queue name                        |
| `AZURE_STORAGE_QUEUE_VISIBILITY_TIMEOUT` | `300`            | Seconds                           |

## Recommended next steps

1. **Provision Azure**: run `az deployment group create` with `infra/azure-storage.bicep` and add env vars to `.env.local`.
2. **Wire `run-artifacts.ts` to RunStore**: replace direct `writeFileSync/mkdirSync` calls with `store.put(key, data)`. The `RunStore` interface is ready.
3. **Update sidecar** (`sidecar/server.ts`): replace `runsDir` + raw fs calls with a `RunStore` dependency so runs can be listed/served from Azure.
4. **Worker loop**: add a worker that calls `queue.dequeue()` in a loop and invokes `generateOne` for each message.

## Verification

- `npm run verify:fast` — 106 files, 1051 tests, all passing.
