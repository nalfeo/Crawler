import type { GameWorld } from '../core/world.js';
import type { Floor5SiegeState } from '../shared/floor-types.js';
import type { ScenarioHudSnapshot } from '../shared/scenario-presentation.js';

function currentObjective(state: Floor5SiegeState): string {
  if (state.engineState === 'DESTROYED' && state.phase.kind !== 'DEFEAT') {
    return 'Defend the Command Post during rebuild';
  }
  switch (state.phase.kind) {
    case 'MUSTER':
      return 'Defend the Command Post';
    case 'CONTEST':
      if (!state.tasks.yardSecured) return 'Secure the siege yard';
      if (state.tasks.recoveredComponents.length < 3)
        return `Recover Ram components (${state.tasks.recoveredComponents.length}/3)`;
      if (!state.tasks.checkpointCleared) return 'Clear the enemy checkpoint';
      return 'Authorize Ratings Ram construction at the build site';
    case 'BUILD':
      if (state.engineState === 'READY') return 'Clear threats near the Ram';
      if (state.heroes.buildStallMs > 0) return 'Defend the build site through disruption';
      return state.construction.buildSiteUnderAttack
        ? 'Clear attackers from the build site'
        : 'Defend the Ram build site';
    case 'ESCORT':
      return state.ram.protectionMet ? 'Escort the Ram to the wall' : 'Clear threats near the Ram';
    case 'BREACH':
      return 'Protect the Ram as it breaks the wall';
    case 'COURTYARD':
      return 'Clear the courtyard defenders';
    case 'THRONE':
      return state.finale.captureAvailable ? 'Capture the throne' : 'Defeat the Regent';
    case 'CAPTURED':
      return 'Castle captured';
    case 'DEFEAT':
      return 'Command Post lost';
  }
}

function readable(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}

function ramProgress(state: Floor5SiegeState): string {
  if (state.engineState === 'BUILDING') {
    const percent = Math.min(
      100,
      Math.max(
        0,
        Math.floor(
          (100 * state.construction.progressMs) / Math.max(1, state.construction.requiredMs),
        ),
      ),
    );
    return `build ${percent}%${state.construction.buildSiteUnderAttack || state.heroes.buildStallMs > 0 ? ' (paused)' : ''}`;
  }
  if (state.engineState === 'LOCKED') return 'awaiting components';
  if (state.engineState === 'DESTROYED') return 'rebuild pending';
  if (state.engineState === 'BREACHED') return 'wall breached';
  if (state.engineState === 'ATTACKING') {
    const wall = state.structures['outer-wall'];
    return `wall ${Math.ceil(Math.max(0, wall.health))}/${Math.ceil(wall.maxHealth)} HP`;
  }
  const routeSteps = Math.max(0, state.ram.route.length - 1);
  const reached = state.ram.route.filter(
    (marker) => marker.index > 0 && marker.reachedFrame !== null,
  ).length;
  return `route ${reached}/${routeSteps} · ${state.ram.protectionMet ? 'protected' : 'holding'}`;
}

function commandPostDanger(state: Floor5SiegeState): {
  readonly label: string;
  readonly cues: ScenarioHudSnapshot['cues'];
} {
  const post = state.structures['command-post'];
  const healthFraction = post.maxHealth > 0 ? state.commandPostHealth / post.maxHealth : 0;
  if (state.phase.kind === 'DEFEAT' || state.phase.kind === 'CAPTURED' || healthFraction >= 1) {
    return { label: 'secure', cues: [] };
  }
  if (healthFraction <= 0.25) {
    return {
      label: 'critical — return to the line',
      cues: [
        { id: 'floor5-command-post-critical-audio', kind: 'audio', label: 'Command Post critical' },
        { id: 'floor5-command-post-critical-vfx', kind: 'vfx', label: 'Command Post critical' },
      ],
    };
  }
  return {
    label: 'under attack — defend the line',
    cues: [
      { id: 'floor5-command-post-danger-audio', kind: 'audio', label: 'Command Post under attack' },
      { id: 'floor5-command-post-danger-vfx', kind: 'vfx', label: 'Command Post under attack' },
    ],
  };
}

/**
 * Objective payoffs already raise the deterministic hostile-reinforcement
 * ledger. Surface that committed ledger beside the Command Post so a player
 * can tell why the siege became more dangerous before a minion has dealt
 * visible structure damage. Health warnings remain the urgent signal above.
 */
function commandPostEscalation(state: Floor5SiegeState): string {
  if (state.phase.kind === 'CAPTURED') return 'castle secured';
  if (state.phase.kind === 'DEFEAT') return 'line lost';
  if (state.breach.latched) return 'breach open — route to throne';
  const beats = state.hostileReinforcements.beats;
  if (beats.length === 0) return 'holding line';
  const latestBeat = beats.at(-1)!.replaceAll('-', ' ');
  return `siege payoff ${beats.length}/6 — ${latestBeat} applied`;
}

/** Read-only projection of committed siege state; the scene owns layout and rendering. */
export function getFloor5HudSnapshot(world: GameWorld): ScenarioHudSnapshot | null {
  const state = world.floorExtendedState?.floor5Siege;
  if (world.floorId !== 'floor5' || !state) return null;
  const post = state.structures['command-post'];
  const danger = commandPostDanger(state);
  const lines = [
    `Siege · ${readable(state.phase.kind)} | Objective: ${currentObjective(state)}`,
    `Command Post ${Math.ceil(Math.max(0, state.commandPostHealth))}/${Math.ceil(post.maxHealth)} HP · ${danger.label} | Escalation: ${commandPostEscalation(state)} | Checkpoint: ${readable(state.checkpointOwner)} | Minions: ally ${state.liveMinions.allied} / hostile ${state.liveMinions.enemy}`,
    `Ram: ${readable(state.engineState)} · ${Math.ceil(Math.max(0, state.ram.health))}/${Math.ceil(state.ram.maxHealth)} HP · ${ramProgress(state)}${state.engineState === 'LOCKED' ? ` · prerequisites ${state.requisitionMilestones.length}/4` : ''}`,
    `Hostile pressure: ${state.liveMinions.enemy} minions · wave cap ${state.hostileReinforcements.cap}/16 · Heroes ${state.heroes.status === 'active' ? 1 : 0}/${state.hostileReinforcements.heroCap} max · ${state.hostileReinforcements.beats.length} escalation beats`,
  ];
  return { id: `floor5:${lines.join('|')}`, lines, cues: danger.cues };
}
