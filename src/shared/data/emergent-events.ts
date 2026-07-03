/**
 * Floor 2 emergent-event archetypes — data-driven per ADR 0011.
 *
 * Events fire on triggers (timer beat, region-enter, threshold cross) and queue
 * faction-relation deltas on `world.factionRelationDeltas` so
 * `familyRelationshipSystem` applies them next tick. Director narration lines
 * are static (P6 — LLM spice is load-time only, never in CI path).
 *
 * Owned by Slice 6; Slice 4 owns `quests.floor2.dens.json`.
 */
import { z } from 'zod';
import eventsJson from './quests.floor2.events.json';
import tuning from './tuning.json';

const FACTION_BANDS = ['hate', 'hostile', 'neutral', 'friendly'] as const;

const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('timer'), atMs: z.number().int().nonnegative() }).strict(),
  z
    .object({
      type: z.literal('regionEnter'),
      roomRole: z.enum(['settlement', 'territory', 'resource_heart', 'boss_den']),
    })
    .strict(),
  z
    .object({
      type: z.literal('threshold'),
      familyIndex: z.number().int().nonnegative(),
      crosses: z.enum(FACTION_BANDS),
    })
    .strict(),
]);

const effectSchema = z
  .object({
    familyIndex: z.number().int().nonnegative(),
    deltaKey: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const emergentEventDefSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    narration: z.string().min(1),
    trigger: triggerSchema,
    oneShot: z.boolean().default(true),
    effects: z.array(effectSchema).min(1),
  })
  .strict();

export type EmergentEventDef = z.infer<typeof emergentEventDefSchema>;
export type EmergentEventTrigger = EmergentEventDef['trigger'];
export type EmergentEventEffect = EmergentEventDef['effects'][number];

export const emergentEventPackSchema = z
  .object({
    id: z.string().min(1),
    _note: z.string().optional(),
    version: z.number().int().positive(),
    events: z.array(emergentEventDefSchema).min(1),
  })
  .strict();

export type EmergentEventPack = z.infer<typeof emergentEventPackSchema>;

let cachedPack: EmergentEventPack | null = null;

/** Load and validate the bundled Floor 2 emergent-event pack. Cached after first call. */
export function loadEmergentEventPack(): EmergentEventPack {
  if (cachedPack !== null) return cachedPack;
  const parsed = emergentEventPackSchema.parse(eventsJson);
  const seen = new Set<string>();
  for (const event of parsed.events) {
    if (seen.has(event.id)) {
      throw new Error(`Duplicate emergent-event id: ${event.id}`);
    }
    seen.add(event.id);
    // Every deltaKey must resolve against tuning.factionRelations.deltas.
    for (const effect of event.effects) {
      if (!(effect.deltaKey in tuning.factionRelations.deltas)) {
        throw new Error(
          `Emergent event "${event.id}" references unknown deltaKey "${effect.deltaKey}"`,
        );
      }
    }
  }
  cachedPack = parsed;
  return cachedPack;
}

/** Test-only reset. */
export function _resetEmergentEventCache(): void {
  cachedPack = null;
}
