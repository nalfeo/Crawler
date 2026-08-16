/**
 * Floor 3 fighting styles — the reusable AI-persona catalog (ADR 0071 D3).
 *
 * A species is `affinity × style`: the affinity decides what it is good/bad
 * against (`affinity.ts`), the style decides *how* it fights. Every species that
 * shares a style shares one AI persona, so 52 species run on 7 behaviors. Style
 * is a species-line trait — constant across all three forms; only the numbers
 * scale (see `species.ts` form `statScale`).
 *
 * See `docs/knowledge/game-design/floor3-companion-league.md` §5.
 */

/** The seven fighting styles. */
export const FIGHTING_STYLES = [
  'charger',
  'bruiser',
  'slinger',
  'burster',
  'pouncer',
  'warden',
  'kindler',
] as const;

export type FightingStyle = (typeof FIGHTING_STYLES)[number];

/**
 * AI persona key a style drives. `CHASE`/`RANGED`/`LEAPER` already exist in the
 * game-layer `AI_TYPE` enum; `GUARDIAN` and `SUPPORT` are the two net-new
 * personas added by the Floor 3 epic (spec slice 4). Kept as string keys here
 * because `src/shared/` must not depend on `src/game/`.
 */
export type StylePersonaAiType = 'CHASE' | 'RANGED' | 'LEAPER' | 'GUARDIAN' | 'SUPPORT';

/** Engagement distance band a style prefers. */
export type RangeProfile = 'melee' | 'gap-close' | 'medium' | 'long';

/** Coarse stat band, resolved to a numeric multiplier via {@link STAT_BAND_SCALE}. */
export type StatBand = 'very-low' | 'low' | 'low-med' | 'medium' | 'high' | 'very-high';

/** Numeric multiplier for each stat band, applied over the base companion archetype. */
export const STAT_BAND_SCALE: Readonly<Record<StatBand, number>> = Object.freeze({
  'very-low': 0.4,
  low: 0.7,
  'low-med': 0.85,
  medium: 1,
  high: 1.4,
  'very-high': 1.8,
});

/** Area-of-effect payload shape for styles that do not attack a single target. */
export type AoeShape = 'circle';

/** The persona parameters shared by every species of one fighting style. */
export interface StylePersona {
  /** AI persona the style drives. */
  readonly aiType: StylePersonaAiType;
  /** Preferred engagement distance band. */
  readonly rangeProfile: RangeProfile;
  /** Attacks per second at form 0 / level 1, before per-form scaling. */
  readonly cadence: number;
  /** Health band relative to the base companion archetype. */
  readonly hpProfile: StatBand;
  /** Damage band relative to the base companion archetype. */
  readonly dmgProfile: StatBand;
  /** Movement-speed band relative to the base companion archetype. */
  readonly speedProfile: StatBand;
  /** Present only for styles whose attack is an area payload. */
  readonly aoeShape?: AoeShape;
}

/**
 * Style → persona registry. Numbers are the initial authored values from the
 * design table; the balance sweep (spec slice 16) is what tunes them.
 */
export const STYLE_PERSONAS: Readonly<Record<FightingStyle, StylePersona>> = Object.freeze({
  charger: Object.freeze({
    aiType: 'CHASE',
    rangeProfile: 'melee',
    cadence: 1.6,
    hpProfile: 'low-med',
    dmgProfile: 'medium',
    speedProfile: 'high',
  }),
  bruiser: Object.freeze({
    aiType: 'CHASE',
    rangeProfile: 'melee',
    cadence: 0.6,
    hpProfile: 'high',
    dmgProfile: 'high',
    speedProfile: 'low',
  }),
  slinger: Object.freeze({
    aiType: 'RANGED',
    rangeProfile: 'long',
    cadence: 1.1,
    hpProfile: 'low',
    dmgProfile: 'medium',
    speedProfile: 'medium',
  }),
  burster: Object.freeze({
    aiType: 'RANGED',
    rangeProfile: 'medium',
    cadence: 0.5,
    hpProfile: 'low-med',
    dmgProfile: 'high',
    speedProfile: 'low',
    aoeShape: 'circle',
  }),
  pouncer: Object.freeze({
    aiType: 'LEAPER',
    rangeProfile: 'gap-close',
    cadence: 0.8,
    hpProfile: 'medium',
    dmgProfile: 'high',
    speedProfile: 'high',
  }),
  warden: Object.freeze({
    aiType: 'GUARDIAN',
    rangeProfile: 'melee',
    cadence: 0.7,
    hpProfile: 'very-high',
    dmgProfile: 'low',
    speedProfile: 'low',
  }),
  kindler: Object.freeze({
    aiType: 'SUPPORT',
    rangeProfile: 'medium',
    cadence: 0.9,
    hpProfile: 'medium',
    dmgProfile: 'very-low',
    speedProfile: 'medium',
  }),
});

/** Pure lookup of the persona for a fighting style. */
export function stylePersona(style: FightingStyle): StylePersona {
  return STYLE_PERSONAS[style];
}

/** Type guard for untrusted fighting-style strings (data loading, save files). */
export function isFightingStyle(value: string): value is FightingStyle {
  return (FIGHTING_STYLES as readonly string[]).includes(value);
}
