# ADR 0047: Unified experiment result artifacts

## Status

Accepted

## Context

Weapon sweeps, AI sweeps, and persona experiments previously emitted unrelated
JSON shapes and were discovered from a weapon-specific directory. That forced
the Sweep Results Viewer to grow experiment-specific readers and made local
results invisible unless they happened to match the weapon sweep contract.

## Decision

Experiment producers use the versioned `crawler.experiment.v1` fields defined
by `scripts/agent/perf/experiment-result.ts`: experiment metadata, dimensions,
generic records, metrics, aggregates, and optional payloads. Local artifacts
are written under `artifacts/experiments`. Existing weapon-sweep fields remain
as a compatibility projection, and the viewer projects generic records into
its current summary grid until a fully generic renderer is introduced.

## Consequences

New experiments can publish without adding a new discovery directory or
top-level viewer contract. Legacy weapon consumers continue to work, while
the shared fields provide stable identity and extensibility for future metrics.
Explicit output paths remain supported for CI and shard workflows.
