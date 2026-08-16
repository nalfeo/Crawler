/**
 * Floor 3 Temperaments (affinities) and the effectiveness matrix — ADR 0071 D3.
 *
 * The chart is a balanced **2-regular ring**: each affinity is super-effective
 * (x2) against the next two affinities clockwise, not-very-effective (x0.5)
 * against the previous two, and neutral (x1) against itself and the remaining
 * two. See `docs/knowledge/game-design/floor3-companion-league.md` §4.1.
 */

/** Ring order — each affinity beats the NEXT two and is resisted by the PREVIOUS two. */
export const AFFINITY_RING = ['ember', 'bloom', 'stone', 'gale', 'tide', 'gloom', 'lumen'] as const;

/** One of the seven Floor 3 Temperaments. */
export type Affinity = (typeof AFFINITY_RING)[number];

/** Damage multiplier applied when an attacker affinity strikes a defender affinity. */
export type AffinityMultiplier = 0.5 | 1 | 2;

const RING_SIZE = AFFINITY_RING.length;

function buildMatrix(): Record<Affinity, Record<Affinity, AffinityMultiplier>> {
  const matrix = {} as Record<Affinity, Record<Affinity, AffinityMultiplier>>;
  AFFINITY_RING.forEach((attacker, attackerIndex) => {
    const row = {} as Record<Affinity, AffinityMultiplier>;
    AFFINITY_RING.forEach((defender, defenderIndex) => {
      const forward = (defenderIndex - attackerIndex + RING_SIZE) % RING_SIZE;
      let multiplier: AffinityMultiplier = 1;
      if (forward === 1 || forward === 2) multiplier = 2;
      else if (forward === RING_SIZE - 1 || forward === RING_SIZE - 2) multiplier = 0.5;
      row[defender] = multiplier;
    });
    matrix[attacker] = Object.freeze(row);
  });
  return Object.freeze(matrix);
}

/** Complete effectiveness matrix, read as `AFFINITY_MATRIX[attacker][defender]`. */
export const AFFINITY_MATRIX: Readonly<
  Record<Affinity, Readonly<Record<Affinity, AffinityMultiplier>>>
> = buildMatrix();

/** Pure lookup of the effectiveness multiplier for an attack of one affinity on another. */
export function affinityMultiplier(attacker: Affinity, defender: Affinity): AffinityMultiplier {
  return AFFINITY_MATRIX[attacker][defender];
}

/** Affinities this affinity is super-effective against (always exactly two). */
export function strongAgainst(attacker: Affinity): readonly Affinity[] {
  return AFFINITY_RING.filter((defender) => affinityMultiplier(attacker, defender) === 2);
}

/** Affinities that are super-effective against this affinity (always exactly two). */
export function predatorsOf(defender: Affinity): readonly Affinity[] {
  return AFFINITY_RING.filter((attacker) => affinityMultiplier(attacker, defender) === 2);
}

/** Type guard for untrusted affinity strings (data loading, save files). */
export function isAffinity(value: string): value is Affinity {
  return (AFFINITY_RING as readonly string[]).includes(value);
}
