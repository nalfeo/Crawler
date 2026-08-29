import type {
  Floor4ActIndex,
  Floor4ArenaState,
  Floor4GreenRoomState,
  Floor4HeadlinerEncounterState,
} from './floor-types.js';

export interface Floor4HudPhaseConfig {
  readonly actCount: number;
  readonly actDurationMs: number;
  readonly waveWindowMs: number;
  readonly overtimeCapMs: number;
}

export interface Floor4HudInput {
  readonly arena?: Floor4ArenaState;
  readonly greenRoom?: Floor4GreenRoomState;
  readonly phaseConfig: Floor4HudPhaseConfig;
  readonly playerGold: number;
  readonly headlinerHealth?: {
    readonly current: number;
    readonly max: number;
  };
}

export interface Floor4HudPip {
  readonly index: number;
  readonly state: 'pending' | 'armed' | 'released';
}

export interface Floor4HudHeadliner {
  readonly title: string;
  readonly subtitle: string;
  readonly hpLabel: string | null;
  readonly hpPercent: number | null;
}

export interface Floor4HudState {
  readonly visible: boolean;
  readonly title: string;
  readonly clock: string;
  readonly subline: string;
  readonly overtime: boolean;
  readonly pips: readonly Floor4HudPip[];
  readonly headliner: Floor4HudHeadliner | null;
  readonly notice: string | null;
  readonly summary: readonly string[];
  readonly winner: boolean;
}

const CUT_NOTICE_MS = 3_000;
const DEFAULT_WAVES_PER_ACT = 8;

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function phaseAct(state: Floor4ArenaState): Floor4ActIndex {
  const phase = state.phase;
  if ('act' in phase) return phase.act;
  return phase.kind === 'VICTORY' ? 5 : 1;
}

function releasedPipCount(state: Floor4ArenaState): number {
  const phase = state.phase;
  if (phase.kind === 'WAVES') return state.waves?.releaseCursor ?? 0;
  if (
    phase.kind === 'HEADLINE' ||
    phase.kind === 'OVERTIME' ||
    phase.kind === 'INTERMISSION' ||
    phase.kind === 'VICTORY'
  ) {
    return Math.max(0, state.waves?.manifests.length ?? DEFAULT_WAVES_PER_ACT);
  }
  return 0;
}

function activePipIndexes(state: Floor4ArenaState): Set<number> {
  const telegraphs =
    state.phase.kind === 'WAVES'
      ? (state.waves?.armedTelegraphs ?? [])
      : (state.pendingWaves?.armedTelegraphs ?? []);
  return new Set(telegraphs.map((telegraph) => telegraph.waveIndex));
}

function buildPips(state: Floor4ArenaState): readonly Floor4HudPip[] {
  const total =
    state.phase.kind === 'WAVES'
      ? (state.waves?.manifests.length ?? DEFAULT_WAVES_PER_ACT)
      : DEFAULT_WAVES_PER_ACT;
  const released = releasedPipCount(state);
  const armed = activePipIndexes(state);
  return Array.from({ length: total }, (_, index) => ({
    index,
    state: index < released ? 'released' : armed.has(index) ? 'armed' : 'pending',
  }));
}

function buildHeadliner(
  encounter: Floor4HeadlinerEncounterState | undefined,
  phaseKind: Floor4ArenaState['phase']['kind'],
  health?: Floor4HudInput['headlinerHealth'],
): Floor4HudHeadliner | null {
  if (!encounter || (phaseKind !== 'HEADLINE' && phaseKind !== 'OVERTIME')) {
    return null;
  }
  const max = Math.max(0, health?.max ?? 0);
  const current = Math.max(0, Math.min(max, health?.current ?? 0));
  return {
    title: encounter.displayName,
    subtitle:
      phaseKind === 'OVERTIME'
        ? `ACT ${encounter.act} HEADLINER · OVERTIME`
        : `ACT ${encounter.act} HEADLINER`,
    hpLabel: max > 0 ? `${Math.ceil(current)} / ${Math.ceil(max)}` : null,
    hpPercent: max > 0 ? current / max : null,
  };
}

function phaseTitle(state: Floor4ArenaState, act: Floor4ActIndex): string {
  switch (state.phase.kind) {
    case 'COUNTDOWN':
      return 'THE MAIN EVENT';
    case 'WAVES':
      return `ACT ${act} / 5`;
    case 'HEADLINE':
      return state.phase.cleared ? `ACT ${act} VICTORY LAP` : `ACT ${act} HEADLINER`;
    case 'OVERTIME':
      return 'OVERTIME';
    case 'INTERMISSION':
      return act === 5 ? "WINNER'S CIRCLE" : `GREEN ROOM · ACT ${act} BREAK`;
    case 'VICTORY':
      return "WINNER'S CIRCLE";
    case 'DEFEAT':
      return 'BROADCAST ENDED';
  }
}

function buildSummary(input: Floor4HudInput, act: Floor4ActIndex): readonly string[] {
  const visit = input.greenRoom?.currentVisit;
  const prefix = act === input.phaseConfig.actCount ? 'Final tally' : `Act ${act} survived`;
  const tableCount = visit?.tables.length ?? 0;
  return [
    prefix,
    `Gold held: ${Math.max(0, Math.trunc(input.playerGold))}`,
    `Enemies booked: ${Math.max(0, Math.trunc(input.arena?.waveTelemetry.enemiesSpawned ?? 0))}`,
    `Cuts: ${Math.max(0, Math.trunc(input.arena?.waveTelemetry.enemiesCut ?? 0))}`,
    tableCount > 0 ? `Sponsors open: ${tableCount}` : 'Sponsors clearing the room',
    act === input.phaseConfig.actCount
      ? 'Take the stairs to claim the belt'
      : 'Shop, equip, then back to one',
  ];
}

export function buildFloor4HudState(input: Floor4HudInput): Floor4HudState {
  const state = input.arena;
  if (!state) {
    return {
      visible: false,
      title: '',
      clock: '',
      subline: '',
      overtime: false,
      pips: [],
      headliner: null,
      notice: null,
      summary: [],
      winner: false,
    };
  }

  const act = phaseAct(state);
  const actEndMs = input.phaseConfig.actDurationMs * act;
  const totalMs = input.phaseConfig.actDurationMs * input.phaseConfig.actCount;
  const actRemainingMs =
    state.phase.kind === 'OVERTIME'
      ? input.phaseConfig.overtimeCapMs - state.phaseElapsedMs
      : actEndMs - state.arenaElapsedMs;
  const waveRemainingMs =
    state.phase.kind === 'WAVES'
      ? Math.max(
          0,
          input.phaseConfig.actDurationMs * (act - 1) +
            input.phaseConfig.waveWindowMs -
            state.arenaElapsedMs,
        )
      : 0;
  const summary =
    state.phase.kind === 'INTERMISSION' || state.phase.kind === 'VICTORY'
      ? buildSummary(input, act)
      : [];
  const cutNotice =
    state.phase.kind === 'HEADLINE' && state.phaseElapsedMs <= CUT_NOTICE_MS
      ? 'CLEAR THE FLOOR'
      : null;

  return {
    visible: true,
    title: phaseTitle(state, act),
    clock:
      state.phase.kind === 'OVERTIME'
        ? `+${formatClock(actRemainingMs)}`
        : formatClock(actRemainingMs),
    subline:
      state.phase.kind === 'WAVES'
        ? `SHOW ${formatClock(totalMs - state.arenaElapsedMs)} · WAVES ${formatClock(waveRemainingMs)}`
        : `SHOW ${formatClock(totalMs - state.arenaElapsedMs)}`,
    overtime: state.phase.kind === 'OVERTIME',
    pips: buildPips(state),
    headliner: buildHeadliner(state.activeHeadliner, state.phase.kind, input.headlinerHealth),
    notice: cutNotice,
    summary,
    winner: state.phase.kind === 'VICTORY' || (state.phase.kind === 'INTERMISSION' && act === 5),
  };
}
