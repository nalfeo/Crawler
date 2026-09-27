/** Descriptive observations only: starting state is never an acquired choice. */
export interface ChoiceOption {
  readonly catalogKey: string;
  readonly selectable: boolean;
  /** Empty means no observed constraint; null means the reason is unavailable. */
  readonly constraints: readonly string[] | null;
  readonly cost?: number;
  readonly budget?: number;
}

export interface BuildEntry {
  readonly catalogKey: string;
  readonly location: 'learned' | 'bag' | 'equipped' | 'owned' | 'active' | 'passive';
}

export interface ChoiceBuildEvent {
  readonly gameTimeMs: number;
  readonly activeTimeMs: number;
  readonly kind: 'offer' | 'selection' | 'build';
  readonly source: string;
  readonly options?: readonly ChoiceOption[];
  readonly selected?: string;
  readonly outcome?: 'confirmed' | 'submitted';
  readonly build?: readonly BuildEntry[];
  readonly acquired?: readonly string[];
}

export interface ChoiceBuildTelemetry {
  readonly schemaVersion: 1;
  readonly coverage: 'partial';
  readonly limitations: readonly string[];
  readonly startingBuild: readonly BuildEntry[];
  readonly events: readonly ChoiceBuildEvent[];
  readonly droppedEvents: number;
}

export interface ChoiceBuildRecorder {
  readonly startingBuild: readonly BuildEntry[];
  readonly events: ChoiceBuildEvent[];
  readonly lastOffers: Map<string, string>;
  readonly selections: Set<string>;
  readonly acquiredCounts: Map<string, number>;
  previousBuild: readonly BuildEntry[];
  droppedEvents: number;
}

const MAX_EVENTS = 2048;

function sortedBuild(build: readonly BuildEntry[]): BuildEntry[] {
  return build
    .map((entry) => ({ ...entry }))
    .sort(
      (a, b) => a.catalogKey.localeCompare(b.catalogKey) || a.location.localeCompare(b.location),
    );
}

export function createChoiceBuildRecorder(build: readonly BuildEntry[]): ChoiceBuildRecorder {
  const startingBuild = sortedBuild(build);
  return {
    startingBuild,
    previousBuild: startingBuild,
    events: [],
    lastOffers: new Map(),
    selections: new Set(),
    acquiredCounts: new Map(
      startingBuild.map((entry) => [
        entry.catalogKey,
        startingBuild.filter((other) => other.catalogKey === entry.catalogKey).length,
      ]),
    ),
    droppedEvents: 0,
  };
}

function append(state: ChoiceBuildRecorder, event: ChoiceBuildEvent): void {
  if (state.events.length < MAX_EVENTS) state.events.push(event);
  else state.droppedEvents += 1;
}

export function recordChoiceOffer(
  state: ChoiceBuildRecorder,
  source: string,
  options: readonly ChoiceOption[],
  gameTimeMs: number,
  activeTimeMs: number,
): void {
  const signature = JSON.stringify(options);
  if (state.lastOffers.get(source) === signature) return;
  state.lastOffers.set(source, signature);
  append(state, {
    kind: 'offer',
    source,
    options: options.map((option) => ({
      ...option,
      constraints: option.constraints === null ? null : [...option.constraints],
    })),
    gameTimeMs,
    activeTimeMs,
  });
}

/** Call only at a confirmed selection seam, never infer a selection from ownership. */
export function recordChoiceSelection(
  state: ChoiceBuildRecorder,
  source: string,
  selected: string,
  gameTimeMs: number,
  activeTimeMs: number,
  outcome: 'confirmed' | 'submitted' = 'confirmed',
): void {
  const key = JSON.stringify([source, selected, outcome]);
  if (state.selections.has(key)) return;
  state.selections.add(key);
  append(state, { kind: 'selection', source, selected, outcome, gameTimeMs, activeTimeMs });
}

export function recordBuildSnapshot(
  state: ChoiceBuildRecorder,
  build: readonly BuildEntry[],
  gameTimeMs: number,
  activeTimeMs: number,
): void {
  const next = sortedBuild(build);
  if (JSON.stringify(next) === JSON.stringify(state.previousBuild)) return;
  const nextCounts = new Map<string, number>();
  const acquired: string[] = [];
  for (const entry of next) {
    const count = (nextCounts.get(entry.catalogKey) ?? 0) + 1;
    nextCounts.set(entry.catalogKey, count);
    if (count > (state.acquiredCounts.get(entry.catalogKey) ?? 0)) {
      acquired.push(entry.catalogKey);
      state.acquiredCounts.set(entry.catalogKey, count);
    }
  }
  state.previousBuild = next;
  append(state, {
    kind: 'build',
    source: 'observed-player-state',
    build: next,
    acquired,
    gameTimeMs,
    activeTimeMs,
  });
}

export function finalizeChoiceBuildTelemetry(state: ChoiceBuildRecorder): ChoiceBuildTelemetry {
  return {
    schemaVersion: 1,
    coverage: 'partial',
    limitations: [
      'Headless observations only; no human choice or enjoyment inference.',
      'Only observed offer and selection seams are covered; acquisition does not imply selection.',
      'Crafting transactions, reward-bundle offers, automatic fallback spell grants, and legacy equipment are not selection-covered.',
      'Offer snapshots include budget changes; counts are observations, not distinct opportunities.',
      'Vendor game timestamps are exact; active timestamps are sampled on first observation.',
    ],
    startingBuild: state.startingBuild,
    events: [...state.events],
    droppedEvents: state.droppedEvents,
  };
}
