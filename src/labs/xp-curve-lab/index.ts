import GUI from 'lil-gui';
import { xpThresholdForLevel, xpRequiredForLevel } from '../../shared/xpMath.js';
import { registerLab } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function createXpCurveLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = 700;
  canvas.height = 400;
  canvas.style.cssText = 'width:100%;height:auto;background:#0d0d14;';
  canvasHost.append(canvas);

  const table = document.createElement('div');
  table.style.cssText = 'padding:16px;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:12px;overflow:auto;max-height:300px;';
  canvasHost.append(table);

  const params = { maxLevel: 50, gemsPerMinute: 30, gemValue: 2 };

  function renderTable(maxLevel: number) {
    let html = '<table style="border-collapse:collapse;"><thead><tr><th style="padding:3px 10px">Lv</th><th style="padding:3px 10px">XP Required</th><th style="padding:3px 10px">Threshold</th><th style="padding:3px 10px">Mins @ rate</th></tr></thead><tbody>';
    const xpPerMinute = params.gemsPerMinute * params.gemValue;
    for (let n = 1; n <= maxLevel; n++) {
      const xpReq = xpRequiredForLevel(n) - xpRequiredForLevel(n - 1);
      const totalXp = xpRequiredForLevel(n);
      const threshold = xpThresholdForLevel(n);
      const mins = xpPerMinute > 0 ? (xpReq / xpPerMinute).toFixed(1) : '∞';
      html += `<tr><td style="padding:2px 10px;color:#9ba">${n}</td><td style="padding:2px 10px;text-align:right;color:#aef">${totalXp}</td><td style="padding:2px 10px;text-align:right;color:#888">${threshold}</td><td style="padding:2px 10px;text-align:right;color:#4f8">${mins}</td></tr>`;
    }
    html += '</tbody></table>';
    table.innerHTML = html;
  }

  function renderChart(maxLevel: number) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    const PAD = { top: 20, right: 20, bottom: 40, left: 60 };

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d0d14';
    ctx.fillRect(0, 0, W, H);

    const xs = Array.from({ length: maxLevel }, (_, i) => i + 1);
    const ys = xs.map((n) => xpRequiredForLevel(n));
    const maxY = ys[ys.length - 1] ?? 1;

    const toX = (n: number) => PAD.left + ((n - 1) / (maxLevel - 1)) * (W - PAD.left - PAD.right);
    const toY = (xp: number) => PAD.top + (1 - xp / maxY) * (H - PAD.top - PAD.bottom);

    // Grid
    ctx.strokeStyle = '#2a2a3a';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = PAD.top + (i / 4) * (H - PAD.top - PAD.bottom);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(W - PAD.right, y);
      ctx.stroke();
      ctx.fillStyle = '#666';
      ctx.font = '11px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round((maxY * (4 - i)) / 4).toLocaleString(), PAD.left - 6, y + 4);
    }

    // XP curve
    ctx.beginPath();
    ctx.strokeStyle = '#4f8';
    ctx.lineWidth = 2;
    for (let i = 0; i < xs.length; i++) {
      const x = toX(xs[i]!);
      const y = toY(ys[i]!);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = '#aaa';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    for (let n = 10; n <= maxLevel; n += 10) {
      const x = toX(n);
      ctx.fillText(`${n}`, x, H - PAD.bottom + 16);
    }
    ctx.fillText('Level', W / 2, H - 4);

    ctx.save();
    ctx.translate(14, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Cumulative XP', 0, 0);
    ctx.restore();
  }

  function redraw() {
    const ml = Math.max(2, Math.min(100, params.maxLevel));
    renderChart(ml);
    renderTable(ml);
  }

  gui.add(params, 'maxLevel', 2, 100, 1).name('Max Level').onChange(redraw);
  gui.add(params, 'gemsPerMinute', 1, 200, 1).name('Gems/min').onChange(redraw);
  gui.add(params, 'gemValue', 1, 20, 1).name('Gem Value').onChange(redraw);

  redraw();

  const hint = document.createElement('p');
  hint.textContent = 'XP curve tuner — adjust max level, gem rate, and gem value to see how long each level takes to reach.';
  hint.style.cssText = 'padding:8px 16px;color:#fbcfe8;font-family:monospace;font-size:12px;background:#0d0d14;';
  controls.append(hint);

  return () => {
    canvas.remove();
    table.remove();
    hint.remove();
  };
}

registerLab('xp-curve-lab', {
  name: 'XP Curve Lab',
  description: 'Visualize XP requirements per level and simulate progression speed at different gem collection rates.',
  create: createXpCurveLab,
});
