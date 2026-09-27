import type {
  BuildEntry,
  ChoiceBuildTelemetry,
  ChoiceBuildEvent,
  ChoiceOption,
} from '../../../src/game/ai/choice-build-telemetry.js';

export interface ChoiceBuildDiagnostics {
  readonly availability: 'missing' | 'partial' | 'truncated' | 'invalid';
  /** Unique observed snapshots, not independent choice opportunities. */
  readonly offers: number;
  readonly selectableOptions: number;
  readonly confirmedSelections: number;
  readonly acquisitions: number;
  /** Canonical descriptions, not scores. Starting state and timestamps are excluded. */
  readonly pathIdentity: string | null;
  readonly acquiredBuildIdentity: string | null;
}

const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const key = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function validBuild(value: unknown): value is BuildEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: BuildEntry) =>
        entry &&
        key(entry.catalogKey) &&
        ['learned', 'bag', 'equipped', 'owned', 'active', 'passive'].includes(entry.location),
    )
  );
}
function validOption(option: ChoiceOption): boolean {
  return (
    !!option &&
    key(option.catalogKey) &&
    typeof option.selectable === 'boolean' &&
    (option.constraints === null ||
      (Array.isArray(option.constraints) &&
        option.constraints.every((item: unknown) => typeof item === 'string'))) &&
    (option.cost === undefined || nonnegative(option.cost)) &&
    (option.budget === undefined || nonnegative(option.budget))
  );
}
function canonicalBuild(build: readonly BuildEntry[]): BuildEntry[] {
  return build
    .map((entry) => ({ catalogKey: entry.catalogKey, location: entry.location }))
    .sort(
      (a, b) => a.catalogKey.localeCompare(b.catalogKey) || a.location.localeCompare(b.location),
    );
}
/** Subtract starting inventory as a multiset, irrespective of later equip changes. */
function acquiredBuild(
  build: readonly BuildEntry[],
  starting: readonly BuildEntry[],
): BuildEntry[] {
  const result = canonicalBuild(build);
  for (const entry of starting) {
    const exact = result.findIndex(
      (item) => item.catalogKey === entry.catalogKey && item.location === entry.location,
    );
    const index =
      exact >= 0 ? exact : result.findIndex((item) => item.catalogKey === entry.catalogKey);
    if (index >= 0) result.splice(index, 1);
  }
  return result;
}

export function choiceBuildDiagnostics(
  data: ChoiceBuildTelemetry | undefined,
  chainedFloorIds?: unknown,
): ChoiceBuildDiagnostics {
  const empty: ChoiceBuildDiagnostics = {
    availability: 'missing',
    offers: 0,
    selectableOptions: 0,
    confirmedSelections: 0,
    acquisitions: 0,
    pathIdentity: null,
    acquiredBuildIdentity: null,
  };
  // Flattened chains spread the final leg's telemetry into a whole-run record.
  // Until a producer aggregates choices/builds, never credit that partial leg
  // under the chain's scenario identity.
  if (chainedFloorIds !== undefined) {
    if (
      !Array.isArray(chainedFloorIds) ||
      chainedFloorIds.length === 0 ||
      !chainedFloorIds.every((id: unknown) => typeof id === 'string' && id.trim().length > 0)
    )
      return { ...empty, availability: 'invalid' };
    if (chainedFloorIds.length > 1) return empty;
  }
  if (data === undefined) return empty;
  if (
    !data ||
    data.schemaVersion !== 1 ||
    data.coverage !== 'partial' ||
    !validBuild(data.startingBuild) ||
    !Array.isArray(data.limitations) ||
    !data.limitations.every((item: unknown) => typeof item === 'string') ||
    !Array.isArray(data.events) ||
    !Number.isInteger(data.droppedEvents) ||
    data.droppedEvents < 0
  )
    return { ...empty, availability: 'invalid' };
  const events: readonly ChoiceBuildEvent[] = data.events;
  if (
    events.some(
      (event) =>
        !event ||
        !nonnegative(event.gameTimeMs) ||
        !nonnegative(event.activeTimeMs) ||
        !key(event.source) ||
        !['offer', 'selection', 'build'].includes(event.kind) ||
        (event.kind === 'offer' &&
          (!Array.isArray(event.options) || !event.options.every(validOption))) ||
        (event.kind === 'selection' &&
          (!key(event.selected) || !['confirmed', 'submitted'].includes(event.outcome ?? ''))) ||
        (event.kind === 'build' &&
          (!validBuild(event.build) ||
            !Array.isArray(event.acquired) ||
            !event.acquired.every(key))),
    )
  )
    return { ...empty, availability: 'invalid' };

  const seen = new Set<string>();
  const path: unknown[] = [];
  const seenEvents = new Set<string>();
  let previousAcquired = '[]';
  let offers = 0,
    selectableOptions = 0,
    confirmedSelections = 0,
    acquisitions = 0;
  let finalBuild: readonly BuildEntry[] = data.startingBuild;
  const maxima = new Map<string, number>();
  for (const entry of data.startingBuild)
    maxima.set(entry.catalogKey, (maxima.get(entry.catalogKey) ?? 0) + 1);
  for (const event of [...events].sort(
    (a, b) => a.gameTimeMs - b.gameTimeMs || a.activeTimeMs - b.activeTimeMs,
  )) {
    const options =
      event.kind === 'offer'
        ? [
            ...new Map(
              event.options!.map((option) => {
                const normalized = [
                  option.catalogKey,
                  option.selectable,
                  option.constraints === null ? null : [...option.constraints].sort(),
                  option.cost ?? null,
                  option.budget ?? null,
                ];
                return [JSON.stringify(normalized), normalized] as const;
              }),
            ).values(),
          ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        : [];
    const acquired = event.kind === 'build' ? acquiredBuild(event.build!, data.startingBuild) : [];
    const description =
      event.kind === 'offer'
        ? ['offer', event.source, options]
        : event.kind === 'selection'
          ? ['selection', event.source, event.selected, event.outcome]
          : ['build', acquired];
    const signature = JSON.stringify(description);
    const newObservation = !seen.has(signature);
    seen.add(signature);
    if (newObservation && event.kind === 'offer' && options.length) {
      offers++;
      selectableOptions += options.filter((option) => option[1] === true).length;
    }
    if (newObservation && event.kind === 'selection' && event.outcome === 'confirmed')
      confirmedSelections++;
    const eventKey = JSON.stringify([signature, event.gameTimeMs, event.activeTimeMs]);
    if (seenEvents.has(eventKey)) continue;
    seenEvents.add(eventKey);
    if (event.kind === 'build') {
      finalBuild = event.build!;
      const counts = new Map<string, number>();
      for (const entry of finalBuild)
        counts.set(entry.catalogKey, (counts.get(entry.catalogKey) ?? 0) + 1);
      for (const [catalogKey, count] of counts) {
        acquisitions += Math.max(0, count - (maxima.get(catalogKey) ?? 0));
        maxima.set(catalogKey, Math.max(count, maxima.get(catalogKey) ?? 0));
      }
    }
    const acquiredSignature = JSON.stringify(acquired);
    const changedBuild = event.kind === 'build' && acquiredSignature !== previousAcquired;
    if (event.kind === 'build') previousAcquired = acquiredSignature;
    if ((event.kind === 'offer' && options.length) || event.kind === 'selection' || changedBuild) {
      // Strip seed-specific stock/transaction IDs only after deduplicating exact observations.
      path.push(
        event.kind === 'build'
          ? description
          : [description[0], event.source.split(':')[0], ...description.slice(2)],
      );
    }
  }
  const finalAcquired = acquiredBuild(finalBuild, data.startingBuild);
  const truncated = data.droppedEvents > 0;
  return {
    availability: truncated ? 'truncated' : 'partial',
    offers,
    selectableOptions,
    confirmedSelections,
    acquisitions,
    pathIdentity: !truncated && path.length ? JSON.stringify(path) : null,
    acquiredBuildIdentity:
      !truncated && finalAcquired.length ? JSON.stringify(finalAcquired) : null,
  };
}

/** A scenario has one vote; conflicting copies are excluded rather than cherry-picked. */
export function choiceBuildEvidence(
  rows: readonly {
    identity: string | null;
    source: string;
    choice_build: ChoiceBuildDiagnostics;
  }[],
): {
  observedScenarios: number;
  conflictingScenarios: number;
  distinctPaths: number;
  distinctAcquiredBuilds: number;
} {
  const byIdentity = new Map<string, ChoiceBuildDiagnostics>();
  const conflicts = new Set<string>();
  for (const row of rows) {
    if (row.identity === null || row.source !== 'headless') continue;
    const previous = byIdentity.get(row.identity);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row.choice_build))
      conflicts.add(row.identity);
    else byIdentity.set(row.identity, row.choice_build);
  }
  const usable = [...byIdentity]
    .filter(([identity, value]) => !conflicts.has(identity) && value.availability === 'partial')
    .map(([, value]) => value);
  return {
    observedScenarios: usable.length,
    conflictingScenarios: conflicts.size,
    distinctPaths: new Set(
      usable.flatMap((value) => (value.pathIdentity === null ? [] : [value.pathIdentity])),
    ).size,
    distinctAcquiredBuilds: new Set(
      usable.flatMap((value) =>
        value.acquiredBuildIdentity === null ? [] : [value.acquiredBuildIdentity],
      ),
    ).size,
  };
}
