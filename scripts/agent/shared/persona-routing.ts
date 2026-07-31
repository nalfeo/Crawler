/**
 * persona-routing.ts — Loader for the single persona routing manifest.
 *
 * `docs/agent-os/personas/routing.json` is the one source of truth for
 * persona -> agent -> system routing. It is consumed by:
 *   - `scripts/agent/producer.ts` (work decomposition), and
 *   - `scripts/agent/docs/check-personas.ts` (validates the docs agree).
 *
 * Adding a persona means editing the manifest first; the guard then reports
 * every doc that still disagrees.
 */

import { readFileSync } from 'node:fs';

import { fromRepo } from './report.js';

export const ROUTING_MANIFEST = 'docs/agent-os/personas/routing.json';

export interface RoutedPersona {
  /** Display name used in docs and in decomposition output. */
  readonly name: string;
  /** Filename under `docs/agent-os/personas/`. */
  readonly file: string;
  /** Canonical agent filename under `.github/agents/`. */
  readonly agent: string;
  /** Decomposition system keywords this persona owns. May be empty. */
  readonly systems: ReadonlyArray<string>;
}

export interface SiblingAgent {
  /** Filename under `.github/agents/`. */
  readonly agent: string;
  /** Persona filename whose doctrine this agent narrows. */
  readonly inherits: string;
}

export interface PersonaRouting {
  readonly schema_version: string;
  /** Persona that owns systems no other persona claims (a triage bucket). */
  readonly unrouted_persona: string;
  readonly personas: ReadonlyArray<RoutedPersona>;
  readonly siblings: ReadonlyArray<SiblingAgent>;
}

function fail(message: string): never {
  throw new Error(`${ROUTING_MANIFEST}: ${message}`);
}

function assertStringArray(value: unknown, where: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(`${where} must be an array of strings.`);
  }
  return value as ReadonlyArray<string>;
}

/**
 * Validate an already-parsed manifest object. Throws with an actionable message
 * rather than returning a partially-valid object, so a malformed manifest fails
 * loudly instead of silently dropping a persona from routing.
 */
export function parsePersonaRouting(raw: unknown): PersonaRouting {
  if (typeof raw !== 'object' || raw === null) fail('manifest must be a JSON object.');
  const obj = raw as Record<string, unknown>;

  if (obj.schema_version !== 'persona-routing/v1') {
    fail(`unsupported schema_version ${JSON.stringify(obj.schema_version)}.`);
  }
  if (typeof obj.unrouted_persona !== 'string' || obj.unrouted_persona === '') {
    fail('`unrouted_persona` must be a non-empty string.');
  }
  if (!Array.isArray(obj.personas) || obj.personas.length === 0) {
    fail('`personas` must be a non-empty array.');
  }
  if (!Array.isArray(obj.siblings)) fail('`siblings` must be an array.');

  const personas = obj.personas.map((entry, i): RoutedPersona => {
    if (typeof entry !== 'object' || entry === null) fail(`personas[${i}] must be an object.`);
    const p = entry as Record<string, unknown>;
    for (const key of ['name', 'file', 'agent'] as const) {
      if (typeof p[key] !== 'string' || p[key] === '') {
        fail(`personas[${i}].${key} must be a non-empty string.`);
      }
    }
    return {
      name: p.name as string,
      file: p.file as string,
      agent: p.agent as string,
      systems: assertStringArray(p.systems, `personas[${i}].systems`),
    };
  });

  const siblings = obj.siblings.map((entry, i): SiblingAgent => {
    if (typeof entry !== 'object' || entry === null) fail(`siblings[${i}] must be an object.`);
    const s = entry as Record<string, unknown>;
    for (const key of ['agent', 'inherits'] as const) {
      if (typeof s[key] !== 'string' || s[key] === '') {
        fail(`siblings[${i}].${key} must be a non-empty string.`);
      }
    }
    return { agent: s.agent as string, inherits: s.inherits as string };
  });

  if (!personas.some((p) => p.name === obj.unrouted_persona)) {
    fail(`\`unrouted_persona\` "${obj.unrouted_persona as string}" is not a listed persona.`);
  }

  // A system owned by two personas would make decomposition order-dependent.
  const owner = new Map<string, string>();
  for (const persona of personas) {
    for (const system of persona.systems) {
      const existing = owner.get(system);
      if (existing !== undefined) {
        fail(`system "${system}" is claimed by both "${existing}" and "${persona.name}".`);
      }
      owner.set(system, persona.name);
    }
  }

  // Duplicate names/files/agents would let a later entry silently overwrite an
  // earlier one when the manifest is keyed by persona name, quietly dropping
  // every system the shadowed entry owned.
  for (const field of ['name', 'file', 'agent'] as const) {
    const seen = new Set<string>();
    for (const persona of personas) {
      if (seen.has(persona[field])) {
        fail(`duplicate persona ${field}: ${JSON.stringify(persona[field])}.`);
      }
      seen.add(persona[field]);
    }
  }
  const seenSiblings = new Set<string>();
  const canonicalAgents = new Set(personas.map((p) => p.agent));
  for (const sibling of siblings) {
    if (seenSiblings.has(sibling.agent)) {
      fail(`duplicate sibling agent: ${JSON.stringify(sibling.agent)}.`);
    }
    // An agent is either a persona's canonical entry point or a specialist
    // sibling — never both, or its owning doctrine would be ambiguous.
    if (canonicalAgents.has(sibling.agent)) {
      fail(
        `agent ${JSON.stringify(sibling.agent)} is listed both as a canonical agent and a sibling.`,
      );
    }
    seenSiblings.add(sibling.agent);
  }

  return {
    schema_version: obj.schema_version,
    unrouted_persona: obj.unrouted_persona,
    personas,
    siblings,
  };
}

/** Read and validate the committed routing manifest. */
export function loadPersonaRouting(): PersonaRouting {
  return parsePersonaRouting(JSON.parse(readFileSync(fromRepo(ROUTING_MANIFEST), 'utf8')));
}

/** `{ [personaName]: systems[] }` for personas that own at least one system. */
export function systemsByPersona(routing: PersonaRouting): Record<string, ReadonlyArray<string>> {
  const mapping: Record<string, ReadonlyArray<string>> = {};
  for (const persona of routing.personas) {
    if (persona.systems.length > 0) mapping[persona.name] = persona.systems;
  }
  return mapping;
}
