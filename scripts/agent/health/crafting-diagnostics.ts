/**
 * Descriptive evidence adapter, deliberately independent of RunStats/fun scores.
 * Runtime currently has material rewards but no recipe/transaction producer.
 * Call without evidence for runtime reports; only explicit fixtures may supply
 * synthetic evidence. All clocks below are activeTimeMs, never wall time.
 */
export interface CraftingEvidence {
  source: 'synthetic' | 'runtime';
  endActiveTimeMs: number;
  transactions: readonly {
    transactionId: string;
    recipeId: string;
    activeTimeMs: number;
    /** Actual consumed quantities, once per transaction, not once per output. */
    costs: readonly {
      resourceId: string;
      quantity: number;
      acquiredActiveTimeMs: number;
    }[];
  }[];
  items: readonly {
    instanceId: string;
    itemId: string;
    provenance: { kind: 'starting' } | { kind: 'crafted'; transactionId: string };
    /** null means incomplete observation; [] means observed and never equipped. */
    equippedWindows: readonly ActiveWindow[] | null;
    /** Complete use observations over the item's lifetime, or null if missing. */
    usesActiveTimeMs: readonly number[] | null;
    /** Matched metric/unit windows around first equip; association, not causation. */
    effectiveness: { before: EffectivenessWindow; after: EffectivenessWindow } | null;
  }[];
  /** Complete opportunity observations, or null when the sensor is absent. */
  opportunities:
    | readonly {
        opportunityId: string;
        recipeId: string;
        activeTimeMs: number;
        decision: 'accepted' | 'rejected' | 'unresolved';
      }[]
    | null;
}

export interface ActiveWindow {
  startActiveTimeMs: number;
  endActiveTimeMs: number;
}

export interface EffectivenessWindow extends ActiveWindow {
  metric: string;
  unit: string;
  /** Measured value in this window, including a measured zero. */
  value: number;
}

function requireEvidence(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid crafting evidence: ${message}`);
}

/** Reject contradictory evidence instead of silently producing plausible numbers. */
export function diagnoseCrafting(evidence?: CraftingEvidence) {
  if (!evidence) {
    return {
      status: 'unavailable' as const,
      reason: 'No runtime recipe/craft transaction producer exists.',
      transactions: null,
      items: null,
      opportunities: null,
    };
  }
  const end = evidence.endActiveTimeMs;
  requireEvidence(Number.isFinite(end) && end >= 0, 'invalid observation end');
  const time = (value: number, minimum = 0) =>
    Number.isFinite(value) && value >= minimum && value <= end;
  const transactions = new Map(evidence.transactions.map((entry) => [entry.transactionId, entry]));
  requireEvidence(
    transactions.size === evidence.transactions.length,
    'duplicate transaction identity',
  );
  for (const transaction of transactions.values()) {
    requireEvidence(
      Boolean(transaction.transactionId && transaction.recipeId),
      'missing transaction identity',
    );
    requireEvidence(time(transaction.activeTimeMs), 'invalid craft time');
    for (const cost of transaction.costs) {
      requireEvidence(
        Boolean(cost.resourceId) && Number.isFinite(cost.quantity) && cost.quantity > 0,
        'invalid consumed resource',
      );
      requireEvidence(
        time(cost.acquiredActiveTimeMs) && cost.acquiredActiveTimeMs <= transaction.activeTimeMs,
        'resource acquired after craft',
      );
    }
  }
  const identities = new Set<string>();
  const items = evidence.items.map((item) => {
    requireEvidence(
      Boolean(item.instanceId && item.itemId) && !identities.has(item.instanceId),
      'duplicate or missing item identity',
    );
    identities.add(item.instanceId);
    const transaction =
      item.provenance.kind === 'crafted'
        ? transactions.get(item.provenance.transactionId)
        : undefined;
    requireEvidence(
      item.provenance.kind === 'starting' || transaction !== undefined,
      'unknown craft transaction',
    );
    const acquiredActiveTimeMs = transaction?.activeTimeMs ?? 0;
    const windows = item.equippedWindows;
    let previousEnd = acquiredActiveTimeMs;
    for (const window of windows ?? []) {
      requireEvidence(
        time(window.startActiveTimeMs, previousEnd) &&
          time(window.endActiveTimeMs, window.startActiveTimeMs) &&
          window.endActiveTimeMs > window.startActiveTimeMs,
        'invalid or overlapping equip window',
      );
      previousEnd = window.endActiveTimeMs;
    }
    let previousUse = acquiredActiveTimeMs;
    for (const use of item.usesActiveTimeMs ?? []) {
      requireEvidence(time(use, previousUse), 'invalid or unordered use time');
      if (windows !== null)
        requireEvidence(
          windows.some((window) => use >= window.startActiveTimeMs && use < window.endActiveTimeMs),
          'use outside equip window',
        );
      previousUse = use;
    }
    const firstEquipActiveTimeMs = windows?.[0]?.startActiveTimeMs ?? null;
    const firstUseActiveTimeMs = item.usesActiveTimeMs?.[0] ?? null;
    const effectiveness = item.effectiveness;
    if (effectiveness) {
      const { before, after } = effectiveness;
      for (const window of [before, after])
        requireEvidence(
          time(window.startActiveTimeMs) &&
            time(window.endActiveTimeMs, window.startActiveTimeMs) &&
            window.endActiveTimeMs > window.startActiveTimeMs &&
            Number.isFinite(window.value),
          'invalid effectiveness window',
        );
      requireEvidence(
        Boolean(before.metric && before.unit) &&
          before.metric === after.metric &&
          before.unit === after.unit,
        'effectiveness metric/unit mismatch',
      );
      requireEvidence(
        firstEquipActiveTimeMs !== null &&
          before.endActiveTimeMs === firstEquipActiveTimeMs &&
          after.startActiveTimeMs === firstEquipActiveTimeMs &&
          after.endActiveTimeMs <= windows![0]!.endActiveTimeMs,
        'effectiveness windows must surround first equip',
      );
    }
    return {
      instanceId: item.instanceId,
      itemId: item.itemId,
      provenance: item.provenance,
      recipeId: transaction?.recipeId ?? null,
      acquiredActiveTimeMs,
      firstEquipActiveTimeMs,
      firstUseActiveTimeMs,
      acquisitionToEquipMs:
        firstEquipActiveTimeMs === null ? null : firstEquipActiveTimeMs - acquiredActiveTimeMs,
      acquisitionToUseMs:
        firstUseActiveTimeMs === null ? null : firstUseActiveTimeMs - acquiredActiveTimeMs,
      equipToUseMs:
        firstEquipActiveTimeMs === null || firstUseActiveTimeMs === null
          ? null
          : firstUseActiveTimeMs - firstEquipActiveTimeMs,
      observedLifetimeMs: end - acquiredActiveTimeMs,
      equippedDurationMs:
        windows === null
          ? null
          : windows.reduce(
              (sum, window) => sum + window.endActiveTimeMs - window.startActiveTimeMs,
              0,
            ),
      useCount: item.usesActiveTimeMs?.length ?? null,
      unused: item.usesActiveTimeMs === null ? null : item.usesActiveTimeMs.length === 0,
      effectiveness:
        effectiveness === null
          ? null
          : {
              ...effectiveness,
              interpretation: 'observed association, not causation' as const,
              delta: effectiveness.after.value - effectiveness.before.value,
            },
    };
  });
  const opportunityIds = new Set<string>();
  for (const opportunity of evidence.opportunities ?? []) {
    requireEvidence(
      Boolean(opportunity.opportunityId && opportunity.recipeId) &&
        !opportunityIds.has(opportunity.opportunityId) &&
        time(opportunity.activeTimeMs),
      'invalid opportunity identity/time',
    );
    opportunityIds.add(opportunity.opportunityId);
  }
  return {
    status: 'observed' as const,
    source: evidence.source,
    transactions: evidence.transactions.map((transaction) => ({
      ...transaction,
      costs: transaction.costs.map((cost) => ({
        ...cost,
        acquisitionToCraftMs: transaction.activeTimeMs - cost.acquiredActiveTimeMs,
      })),
      outputInstanceIds: items
        .filter(
          (item) =>
            item.provenance.kind === 'crafted' &&
            item.provenance.transactionId === transaction.transactionId,
        )
        .map((item) => item.instanceId),
    })),
    items,
    opportunities:
      evidence.opportunities === null
        ? null
        : {
            observations: evidence.opportunities,
            count: evidence.opportunities.length,
            explicitRejections: evidence.opportunities.filter(
              (entry) => entry.decision === 'rejected',
            ).length,
          },
  };
}
