#!/usr/bin/env node
/**
 * docs/check-personas.ts — Keep the agent persona system internally consistent
 * so the routing matrix can't silently drift.
 *
 * Deterministic, LLM-free. Asserts that every persona doc under
 * `docs/agent-os/personas/` (excluding the README index itself):
 *   1. Contains each required `##` section heading
 *      (Responsibilities, Constraints, Tools & Workflows, Quality Criteria,
 *      Collaborates with, Agent, Skills).
 *   2. Is listed in the README's "Persona Index" table by filename.
 *   3. Names at least one invocable agent under `.github/agents/` in its
 *      `## Agent` section (the first is its canonical entry point), and every
 *      agent it names exists.
 *
 * It also asserts, for the agent layer:
 *   4. Every `.github/agents/*.agent.md` has YAML frontmatter with a non-empty
 *      `description` (required by the custom-agent spec — an agent without one
 *      is never selectable).
 *   5. Every agent file is reachable from the personas README, either as a
 *      persona's agent (Persona Index) or as a specialist sibling (Agent
 *      Index). No orphan agents.
 *
 * And the reverse: a persona file referenced by the README index that does not
 * exist on disk.
 *
 * Finally, it enforces the single routing manifest
 * (`docs/agent-os/personas/routing.json`), which is the one machine-readable
 * source of truth consumed by `scripts/agent/producer.ts`:
 *   6. Manifest personas and persona docs are in bijection, and each entry's
 *      agent is that persona's canonical agent.
 *   7. Every agent is either a manifest persona's canonical agent or a listed
 *      specialist sibling with an existing `inherits` persona.
 *   8. The README's Routing Matrix rows match the manifest exactly (same
 *      personas, same agent per persona).
 *
 * Exit code is non-zero (blocking) on any of the above.
 */

import { readFileSync, readdirSync } from 'node:fs';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';
import {
  ROUTING_MANIFEST,
  loadPersonaRouting,
  type PersonaRouting,
} from '../shared/persona-routing.js';
import {
  frontmatterDescription,
  headingSet,
  referencedAgents,
  referencedPersonas,
  routingMatrixRows,
  sectionBody,
} from './doc-refs-lib.js';

const PERSONA_DIR = 'docs/agent-os/personas';
const README = `${PERSONA_DIR}/README.md`;
const AGENT_DIR = '.github/agents';

const REQUIRED_SECTIONS = [
  'Responsibilities',
  'Constraints',
  'Tools & Workflows',
  'Quality Criteria',
  'Collaborates with',
  'Agent',
  'Skills',
] as const;

function listPersonaFiles(): ReadonlyArray<string> {
  return readdirSync(fromRepo(PERSONA_DIR))
    .filter((entry) => entry.endsWith('.md') && entry !== 'README.md')
    .sort();
}

function listAgentFiles(): ReadonlyArray<string> {
  try {
    return readdirSync(fromRepo(AGENT_DIR))
      .filter((entry) => entry.endsWith('.agent.md'))
      .sort();
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const report = new Report('docs-check-personas');

  let readmeText: string;
  try {
    readmeText = readFileSync(fromRepo(README), 'utf8');
  } catch {
    report.error(`Persona index is missing: \`${README}\``, {
      file: README,
      remediation: 'Restore the persona routing README that indexes every persona doc.',
    });
    report.finish();
    return;
  }

  const personaFiles = listPersonaFiles();
  if (personaFiles.length === 0) {
    report.warn('No persona docs found under the personas directory.', { file: PERSONA_DIR });
    report.finish();
    return;
  }

  // 1. Section completeness.
  for (const file of personaFiles) {
    const rel = `${PERSONA_DIR}/${file}`;
    const headings = headingSet(readFileSync(fromRepo(rel), 'utf8'));
    for (const section of REQUIRED_SECTIONS) {
      if (!headings.has(section)) {
        report.error(`Persona doc is missing required section "## ${section}".`, {
          file: rel,
          remediation: `Add a "## ${section}" section so every persona has a consistent shape.`,
        });
      }
    }
  }

  // 2. Index coverage (each persona file is referenced by the README).
  for (const file of personaFiles) {
    if (!readmeText.includes(file)) {
      report.error(`Persona doc is not listed in the README persona index: \`${file}\`.`, {
        file: README,
        remediation: `Add \`${file}\` to the "Persona Index" table in ${README}.`,
      });
    }
  }

  // 3. Reverse check: README must not reference a persona file that is absent.
  const known = new Set(personaFiles);
  const referenced = new Set<string>();
  let m: RegExpExecArray | null;
  const re = /`([a-z0-9-]+\.md)`/g;
  while ((m = re.exec(readmeText)) !== null) {
    if (m[1] && m[1] !== 'README.md') referenced.add(m[1]);
  }
  for (const ref of referenced) {
    if (!known.has(ref)) {
      report.error(`README persona index references a missing persona file: \`${ref}\`.`, {
        file: README,
        remediation: `Create ${PERSONA_DIR}/${ref} or remove the stale reference from the index.`,
      });
    }
  }

  // 4. Persona -> agent wiring: every persona names at least one existing
  //    agent. The FIRST named agent is its canonical entry point and may be
  //    claimed by only one persona; the rest are specialist siblings.
  const agentFiles = new Set(listAgentFiles());
  const claimedByPersona = new Set<string>();
  const canonicalOwner = new Map<string, string>();
  for (const file of personaFiles) {
    const rel = `${PERSONA_DIR}/${file}`;
    const body = sectionBody(readFileSync(fromRepo(rel), 'utf8'), 'Agent');
    if (body === null) continue; // already reported by the section check
    const named = referencedAgents(body);
    if (named.length === 0) {
      report.error('Persona "## Agent" section names no invocable agent.', {
        file: rel,
        remediation: `Reference the persona's agent file under \`${AGENT_DIR}/\` (e.g. \`${file.replace(/\.md$/, '.agent.md')}\`).`,
      });
      continue;
    }
    for (const agent of named) {
      if (!agentFiles.has(agent)) {
        report.error(`Persona references a missing agent file: \`${AGENT_DIR}/${agent}\`.`, {
          file: rel,
          remediation: `Create \`${AGENT_DIR}/${agent}\` or point the "## Agent" section at an existing agent.`,
        });
        continue;
      }
      claimedByPersona.add(agent);
    }
    const canonical = named[0];
    if (canonical !== undefined && agentFiles.has(canonical)) {
      const existing = canonicalOwner.get(canonical);
      if (existing !== undefined) {
        report.error(
          `Agent \`${canonical}\` is claimed as the canonical agent of two personas (\`${existing}\` and \`${file}\`).`,
          {
            file: rel,
            remediation:
              'An agent has exactly one owning persona. List it as a non-first "specialist sibling" here, or give this persona its own agent.',
          },
        );
      } else {
        canonicalOwner.set(canonical, file);
      }
    }
  }

  // 5. Agent frontmatter: `description` is required by the custom-agent spec,
  //    and every agent must link back to a persona doc that exists.
  for (const agent of agentFiles) {
    const rel = `${AGENT_DIR}/${agent}`;
    const text = readFileSync(fromRepo(rel), 'utf8');
    if (frontmatterDescription(text) === null) {
      report.error('Agent file has no non-empty `description` in its YAML frontmatter.', {
        file: rel,
        remediation:
          'Add a `description:` line describing when to select this agent — without it the agent is never selectable.',
      });
    }
    const personas = referencedPersonas(text);
    if (personas.length === 0) {
      report.error('Agent file does not name the persona whose doctrine it inherits.', {
        file: rel,
        remediation: `Reference an existing persona doc (e.g. \`${PERSONA_DIR}/reviewer.md\`) so the persona↔agent link is bidirectional.`,
      });
    }
    for (const persona of personas) {
      if (!known.has(persona)) {
        report.error(`Agent references a missing persona doc: \`${PERSONA_DIR}/${persona}\`.`, {
          file: rel,
          remediation: `Point at an existing persona doc under \`${PERSONA_DIR}/\` or remove the stale reference.`,
        });
      }
    }
    const canonicalPersona = canonicalOwner.get(agent);
    if (canonicalPersona !== undefined && !personas.includes(canonicalPersona)) {
      report.error(
        `Agent \`${agent}\` is canonically owned by \`${canonicalPersona}\` but does not backlink to it.`,
        {
          file: rel,
          remediation: `Add \`${PERSONA_DIR}/${canonicalPersona}\` to this agent doc so persona↔agent ownership stays bidirectional.`,
        },
      );
    }
  }

  // 6. No orphan agents: each agent is a persona's agent or a listed sibling.
  const personaIndex = sectionBody(readmeText, 'Persona Index') ?? '';
  const agentIndex = sectionBody(readmeText, 'Agent Index') ?? '';
  const readmeAgents = referencedAgents(`${personaIndex}\n${agentIndex}`);
  for (const agent of agentFiles) {
    if (claimedByPersona.has(agent)) continue;
    if (readmeAgents.includes(agent)) continue;
    report.error(`Agent is not reachable from the persona system: \`${AGENT_DIR}/${agent}\`.`, {
      file: README,
      remediation: `Either name \`${agent}\` in a persona's "## Agent" section, or list it in the "Agent Index" table as a specialist sibling.`,
    });
  }

  // 7. Reverse: the README must not point at an agent file that is absent.
  for (const agent of readmeAgents) {
    if (!agentFiles.has(agent)) {
      report.error(`Persona README references a missing agent file: \`${AGENT_DIR}/${agent}\`.`, {
        file: README,
        remediation: `Create \`${AGENT_DIR}/${agent}\` or remove the stale reference.`,
      });
    }
  }

  // 8. Routing manifest is the single source of truth: it must agree with the
  //    persona docs, the agent files, and the README Routing Matrix.
  let routing: PersonaRouting | null = null;
  try {
    routing = loadPersonaRouting();
  } catch (err) {
    report.error(
      `Persona routing manifest is invalid: ${err instanceof Error ? err.message : String(err)}`,
      {
        file: ROUTING_MANIFEST,
        remediation:
          'Fix the manifest so persona routing has exactly one machine-readable source of truth.',
      },
    );
  }

  if (routing !== null) {
    const manifestFiles = new Set(routing.personas.map((p) => p.file));
    for (const persona of routing.personas) {
      if (!known.has(persona.file)) {
        report.error(`Routing manifest lists a missing persona doc: \`${persona.file}\`.`, {
          file: ROUTING_MANIFEST,
          remediation: `Create ${PERSONA_DIR}/${persona.file} or drop the entry.`,
        });
      }
      if (!agentFiles.has(persona.agent)) {
        report.error(`Routing manifest lists a missing agent file: \`${persona.agent}\`.`, {
          file: ROUTING_MANIFEST,
          remediation: `Create \`${AGENT_DIR}/${persona.agent}\` or point the entry at an existing agent.`,
        });
      } else {
        // The manifest's agent must be the persona doc's CANONICAL agent (the
        // one listed first), not merely one it mentions — otherwise
        // decomposition would dispatch to a sibling that does not own the
        // doctrine.
        const owner = canonicalOwner.get(persona.agent);
        const remediation = `Point the entry at the agent named first in ${PERSONA_DIR}/${persona.file}'s "## Agent" section.`;
        if (owner === undefined) {
          report.error(
            `Routing manifest maps "${persona.name}" to \`${persona.agent}\`, but that agent is not the canonical (first-listed) agent of any persona doc.`,
            { file: ROUTING_MANIFEST, remediation },
          );
        } else if (owner !== persona.file) {
          report.error(
            `Routing manifest maps "${persona.name}" to \`${persona.agent}\`, but that agent is canonically owned by \`${owner}\`.`,
            { file: ROUTING_MANIFEST, remediation },
          );
        }
      }
    }
    for (const file of personaFiles) {
      if (!manifestFiles.has(file)) {
        report.error(`Persona doc is absent from the routing manifest: \`${file}\`.`, {
          file: ROUTING_MANIFEST,
          remediation: `Add an entry for \`${file}\` (display name, agent, and any decomposition system keywords).`,
        });
      }
    }

    for (const sibling of routing.siblings) {
      if (!agentFiles.has(sibling.agent)) {
        report.error(`Routing manifest lists a missing sibling agent: \`${sibling.agent}\`.`, {
          file: ROUTING_MANIFEST,
          remediation: `Create \`${AGENT_DIR}/${sibling.agent}\` or drop the entry.`,
        });
      }
      if (!known.has(sibling.inherits)) {
        report.error(
          `Sibling agent \`${sibling.agent}\` inherits a missing persona doc: \`${sibling.inherits}\`.`,
          {
            file: ROUTING_MANIFEST,
            remediation: `Point \`inherits\` at an existing persona doc under \`${PERSONA_DIR}/\`.`,
          },
        );
      }
    }
    const siblingAgents = new Set(routing.siblings.map((s) => s.agent));
    for (const agent of agentFiles) {
      if (canonicalOwner.has(agent)) continue;
      if (siblingAgents.has(agent)) continue;
      report.error(`Agent is absent from the routing manifest: \`${AGENT_DIR}/${agent}\`.`, {
        file: ROUTING_MANIFEST,
        remediation: `Add \`${agent}\` to \`siblings\` (with the persona whose doctrine it narrows), or make it a persona's canonical agent.`,
      });
    }

    // 9. README Routing Matrix must match the manifest exactly.
    const matrixRows = routingMatrixRows(sectionBody(readmeText, 'Routing Matrix') ?? '');
    const matrix = new Map(matrixRows.map((row) => [row.persona, row.agent]));
    const seenRows = new Set<string>();
    for (const row of matrixRows) {
      if (seenRows.has(row.persona)) {
        report.error(`README Routing Matrix has more than one row for "${row.persona}".`, {
          file: README,
          remediation:
            'Delete the duplicate row — a persona routes to exactly one agent, and a duplicate hides the stale row from this check.',
        });
      }
      seenRows.add(row.persona);
    }
    for (const persona of routing.personas) {
      const slug = persona.agent.replace(/\.agent\.md$/, '');
      const row = matrix.get(persona.name);
      if (row === undefined) {
        report.error(`README Routing Matrix has no row for "${persona.name}".`, {
          file: README,
          remediation: `Add a row with **${persona.name}** and agent \`${slug}\`, matching ${ROUTING_MANIFEST}.`,
        });
      } else if (row !== slug) {
        report.error(
          `README Routing Matrix routes "${persona.name}" to \`${row}\`, but the manifest says \`${slug}\`.`,
          {
            file: README,
            remediation: `Update the Agent column to \`${slug}\`, or change ${ROUTING_MANIFEST} if the manifest is wrong.`,
          },
        );
      }
    }
    const manifestNames = new Set(routing.personas.map((p) => p.name));
    for (const name of matrix.keys()) {
      if (!manifestNames.has(name)) {
        report.error(`README Routing Matrix lists an unknown persona: "${name}".`, {
          file: README,
          remediation: `Add "${name}" to ${ROUTING_MANIFEST} or remove the stale row.`,
        });
      }
    }
  }

  report.finish();
}

main().catch((err) => {
  process.stderr.write(`check-personas crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
