import type GUI from 'lil-gui';
import { BehaviorTreeAI } from '../../game/ai/bt-ai-provider.js';
import { summarizeEvents, type SimEvent } from '../../game/ai/event-log.js';
import { runHeadless } from '../../game/ai/headless-runner.js';
import { AIPathingMode } from '../../game/ai/types.js';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

interface DebugControls {
  seed: number;
  weapon: 'sword' | 'bow' | 'baseball-bat';
  sampleInterval: number;
  running: boolean;
  run: () => void;
}

function createMetricRow(label: string, value: string): HTMLDivElement {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.justifyContent = 'space-between';
  row.style.gap = '16px';
  row.style.fontFamily = 'monospace';

  const key = document.createElement('span');
  key.textContent = label;
  key.style.opacity = '0.75';

  const val = document.createElement('span');
  val.textContent = value;
  val.style.fontWeight = '600';

  row.append(key, val);
  return row;
}

function createEngageOrbitDebugLab(canvasHost: HTMLElement, controlsHost: HTMLElement): () => void {
  const gui = (controlsHost as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.display = 'grid';
  root.style.gap = '16px';
  root.style.padding = '24px';
  root.style.height = '100%';
  root.style.overflow = 'auto';
  root.style.background = 'radial-gradient(circle at top, #1f2937 0%, #111827 55%, #030712 100%)';
  root.style.color = '#e5eefb';

  const title = document.createElement('h2');
  title.textContent = 'Engage Orbit Debug Lab';
  title.style.margin = '0';

  const subtitle = document.createElement('p');
  subtitle.textContent =
    'Deterministic seed-3 runner for the merchant-charm engage-loop regression. Run it after tuning and compare longest kill gap, charm completion time, and ENGAGE dwell.';
  subtitle.style.margin = '0';
  subtitle.style.maxWidth = '820px';
  subtitle.style.lineHeight = '1.5';
  subtitle.style.opacity = '0.85';

  const status = document.createElement('div');
  status.textContent = 'Idle';
  status.style.fontFamily = 'monospace';
  status.style.padding = '12px 14px';
  status.style.border = '1px solid rgba(255,255,255,0.12)';
  status.style.borderRadius = '12px';
  status.style.background = 'rgba(15, 23, 42, 0.72)';

  const metrics = document.createElement('div');
  metrics.style.display = 'grid';
  metrics.style.gap = '8px';
  metrics.style.padding = '16px';
  metrics.style.border = '1px solid rgba(255,255,255,0.12)';
  metrics.style.borderRadius = '12px';
  metrics.style.background = 'rgba(15, 23, 42, 0.72)';
  metrics.append(
    createMetricRow('Outcome', '-'),
    createMetricRow('Shopkeeper errand complete', '-'),
    createMetricRow('Longest kill gap', '-'),
    createMetricRow('ENGAGE time', '-'),
    createMetricRow('EXPLORE time', '-'),
    createMetricRow('Kills', '-'),
  );

  const details = document.createElement('pre');
  details.textContent = 'Run output will appear here.';
  details.style.margin = '0';
  details.style.padding = '16px';
  details.style.border = '1px solid rgba(255,255,255,0.12)';
  details.style.borderRadius = '12px';
  details.style.background = 'rgba(2, 6, 23, 0.85)';
  details.style.whiteSpace = 'pre-wrap';
  details.style.lineHeight = '1.45';
  details.style.fontSize = '13px';
  details.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';

  root.append(title, subtitle, status, metrics, details);
  canvasHost.append(root);

  let disposed = false;
  const rows = Array.from(metrics.children) as HTMLDivElement[];
  const setMetric = (index: number, value: string): void => {
    const row = rows[index];
    const valueNode = row?.lastElementChild;
    if (valueNode) {
      valueNode.textContent = value;
    }
  };

  const debugControls: DebugControls = {
    seed: 3,
    weapon: 'sword',
    sampleInterval: 5,
    running: false,
    run: () => {
      void runScenario();
    },
  };

  gui.add(debugControls, 'seed', 1, 999, 1).name('Seed');
  gui.add(debugControls, 'weapon', ['sword', 'bow', 'baseball-bat']).name('Weapon');
  gui.add(debugControls, 'sampleInterval', 1, 30, 1).name('Sample interval');
  gui.add(debugControls, 'run').name('Run seed');

  async function runScenario(): Promise<void> {
    if (debugControls.running || disposed) return;
    debugControls.running = true;
    status.textContent = `Running seed ${debugControls.seed} (${debugControls.weapon})...`;
    details.textContent = 'Running deterministic headless simulation...';

    try {
      const events: SimEvent[] = [];
      const stats = await runHeadless(
        new BehaviorTreeAI({
          seed: debugControls.seed,
          pathingMode: AIPathingMode.RISK_REWARD_FUSED,
        }),
        {
          seed: debugControls.seed,
          forceWeaponId: debugControls.weapon,
          maxFrames: 25_000,
          maxWallTimeMs: 30_000,
          eventSampleInterval: debugControls.sampleInterval,
          recordEvent: (event) => {
            events.push(event);
          },
        },
      );
      if (disposed) return;

      const summary = summarizeEvents(events);
      const shopkeeperDone = stats.quests.questLogCompletions['floor1-shopkeeper-errand'];
      const aiTelemetry = stats.aiTelemetry;
      const engageMs = aiTelemetry?.decisionStateMs.ENGAGE ?? 0;
      const exploreMs = aiTelemetry?.decisionStateMs.EXPLORE ?? 0;
      const longestKillGapMs = summary.longestKillGapMs ?? 0;

      setMetric(0, stats.outcome);
      setMetric(1, shopkeeperDone ? `${(shopkeeperDone / 1000).toFixed(1)}s` : 'incomplete');
      setMetric(2, `${(longestKillGapMs / 1000).toFixed(1)}s`);
      setMetric(3, `${(engageMs / 1000).toFixed(1)}s`);
      setMetric(4, `${(exploreMs / 1000).toFixed(1)}s`);
      setMetric(5, `${stats.combat.totalKills}`);

      status.textContent = `Done: ${stats.outcome.toUpperCase()} in ${(stats.gameTimeMs / 1000).toFixed(1)}s`;
      details.textContent = [
        `Seed: ${debugControls.seed}`,
        `Weapon: ${debugControls.weapon}`,
        `Outcome: ${stats.outcome}`,
        `Game time: ${(stats.gameTimeMs / 1000).toFixed(1)}s`,
        `Shopkeeper errand: ${shopkeeperDone ? `${(shopkeeperDone / 1000).toFixed(1)}s` : 'incomplete'}`,
        `Longest kill gap: ${(longestKillGapMs / 1000).toFixed(1)}s`,
        `ENGAGE time: ${(engageMs / 1000).toFixed(1)}s`,
        `EXPLORE time: ${(exploreMs / 1000).toFixed(1)}s`,
        `Kills: ${stats.combat.totalKills}`,
        `Damage taken: ${stats.combat.damageTaken.toFixed(1)}`,
      ].join('\n');
    } catch (error) {
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = 'Run failed';
      details.textContent = message;
    } finally {
      debugControls.running = false;
    }
  }

  void runScenario();

  return () => {
    disposed = true;
    root.remove();
  };
}

registerLab('engage-orbit-debug-lab', {
  category: 'Meta' as LabCategory,
  name: 'Engage Orbit Debug Lab',
  description: 'Deterministic seed-3 headless regression probe for engage-loop tuning.',
  create: createEngageOrbitDebugLab,
});
