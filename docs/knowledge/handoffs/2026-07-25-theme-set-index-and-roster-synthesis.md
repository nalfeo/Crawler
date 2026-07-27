# Theme equipment set index, create-new-theme flow, and model-proposed rosters

## Systems touched

asset-pipeline, agent-tooling

## What shipped

The themed-equipment pipeline (ADR 0073, PR #1971) shipped agent-first: the
`theme-equipment-review` canvas required a caller-supplied `setId`, so it could
neither list the sets that exist nor author a new one, and the one authored plan
(`classic-fantasy`) had never been initialized because `init` was never dispatched.
Four pointed questions from the maintainer — "where is our initial set?", "why is
there no set picker?", "shouldn't the manifest live in repo?", "why is there no
create button?" — drove this follow-up.

- **Set index.** The canvas now opens with no `setId` and boots into an index of
  every authored plan in `data/theme-equipment-sets/` unioned with `theme-sets/`
  in the `RunStore`, each with its coverage and durable-state badge. Set selection
  is validated against a server-computed allowlist built from that same listing.
- **Create-new-theme.** The human authors the set id, display name, and
  `themeDesignLanguage`; a model then proposes **only the item roster**; the human
  edits the JSON with a live coverage meter; `save-plan` writes the plan into the
  repo at a path derived server-side from the validated `plan.id`.
- **Hardened dispatch.** `gh workflow run` now pins `--ref` and, for `init`,
  proves the plan blob exists on the remote ref before dispatching.

`data/theme-equipment-sets/edo-samurai.json` is a real second collection produced
end-to-end through the new flow (22 items, 6 weapon types, 16 slots).

## Observe before done

Verified live in the running canvas via Playwright, not from the diff:

- **Before:** opening the canvas failed with `"setId" is a required property`;
  there was no way to see or create a set.
- **After:** the canvas opens on the index listing Classic Fantasy and Edo Samurai
  with correct coverage and `not initialized` badges; **+ New theme** synthesizes a
  complete valid roster from a brief; **Save plan to repo** writes the file (confirmed
  on disk) and the index picks it up; **Open** routes to the review board, which shows
  the uninitialized state and an **Initialize set on GitHub** control.
- Screenshot: `theme-set-index.png` (session artifacts).

The CLI exit path was also measured, not assumed: 6.0s for a synth run and 2.5s
for a list, both exit 0.

## Gotchas for the next session

- **`process.exit()` in an Azure-calling CLI crashes on Windows.** Exiting while
  undici keep-alive sockets are tearing down trips
  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94`
  (exit code `-1073740791`). The CLI produced a perfect roster on stdout and the
  bridge still reported an error, because the bridge reads the exit code. Fix used
  here: set `process.exitCode` and add an unref'd forced-exit timer as a
  hang guard. **`process.exit(code)` is the widespread pattern across
  `scripts/sprites/*-cli.ts`, so the other Azure-calling CLIs likely carry the same
  latent crash** — it just does not fire on Linux CI.
- **`gh workflow run` without `--ref` targets the default branch.** Telling a user
  to "commit and push first" is not enough on its own; a plan pushed to a feature
  branch is invisible to a default-branch run.
- **`FETCH_HEAD` and `origin/<ref>` are both shared per repository.** Neither is safe
  for a "does this blob exist on the remote?" check if any other git process might run
  concurrently. Fetch into a private per-call ref and delete it in a `finally`.
- **A `store.has()` guard followed by a filesystem write is not atomic**, and the
  rollback has to cover a _throwing_ re-check as well as a `true` one — otherwise a
  transient store outage leaves exactly the drift the guard exists to prevent.
- **Node error messages leak absolute paths** (ENOENT etc.). Anything forwarded from a
  server to a canvas page must be scrubbed.
- The canvas CLI takes a **single positional base64url-JSON argument**, not stdin, and
  does **not** load `.env.local` itself — the bridge's `loadRepoEnv()` does that and
  passes `env` to the child. Direct CLI runs need the env exported manually.
- `node --test <dir>` fails on Windows with `MODULE_NOT_FOUND`; pass explicit file paths.
- The `sprites` vitest project excludes `tests/unit/sprites/**` from the `unit` project —
  run those with `npx vitest run --project sprites`.

## Follow-ups

- `classic-fantasy` and `edo-samurai` still have **no durable state**. Once this PR
  merges, dispatch `init` for each (the plan must be on the pushed ref).
- Consider auditing the other `scripts/sprites/*-cli.ts` entrypoints for the
  `process.exit()` libuv crash.
