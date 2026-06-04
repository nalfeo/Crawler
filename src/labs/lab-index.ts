import { getAllLabs } from './registry.js';

export function renderLabIndex(): void {
  const canvas = document.getElementById('lab-canvas');
  const controls = document.getElementById('lab-controls');

  if (!canvas || !controls) {
    throw new Error('Lab page containers are missing.');
  }

  canvas.replaceChildren();
  controls.replaceChildren();

  const labs = [...getAllLabs().entries()].sort(([leftId], [rightId]) =>
    leftId.localeCompare(rightId),
  );

  const wrapper = document.createElement('div');
  wrapper.style.padding = '32px';
  wrapper.style.maxWidth = '960px';
  wrapper.style.margin = '0 auto';

  const title = document.createElement('h1');
  title.textContent = '🧪 Crawler Labs';
  title.style.fontSize = '40px';
  title.style.marginBottom = '12px';

  const subtitle = document.createElement('p');
  subtitle.textContent =
    'Developer sandboxes for prototyping systems before they move into the game.';
  subtitle.style.color = '#c9d4ff';
  subtitle.style.lineHeight = '1.6';
  subtitle.style.marginBottom = '24px';

  const count = document.createElement('p');
  count.textContent = `${labs.length} lab${labs.length === 1 ? '' : 's'} registered`;
  count.style.marginBottom = '24px';
  count.style.color = '#7ee0ff';

  const list = document.createElement('div');
  list.style.display = 'grid';
  list.style.gap = '16px';

  if (labs.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No labs are registered yet.';
    empty.style.padding = '24px';
    empty.style.border = '1px solid rgba(255, 255, 255, 0.08)';
    empty.style.borderRadius = '16px';
    empty.style.background = 'rgba(22, 33, 62, 0.75)';
    list.append(empty);
  }

  for (const [id, lab] of labs) {
    const link = document.createElement('a');
    link.href = `?lab=${encodeURIComponent(id)}`;
    link.style.display = 'block';
    link.style.padding = '20px 24px';
    link.style.border = '1px solid rgba(255, 255, 255, 0.12)';
    link.style.borderRadius = '16px';
    link.style.background = 'rgba(22, 33, 62, 0.9)';
    link.style.boxShadow = '0 12px 32px rgba(0, 0, 0, 0.2)';
    link.style.color = '#e0e0e0';
    link.style.textDecoration = 'none';

    const name = document.createElement('h2');
    name.textContent = lab.name;
    name.style.fontSize = '22px';
    name.style.marginBottom = '8px';

    const description = document.createElement('p');
    description.textContent = lab.description;
    description.style.color = '#c9d4ff';
    description.style.lineHeight = '1.6';
    description.style.marginBottom = '12px';

    const meta = document.createElement('code');
    meta.textContent = id;
    meta.style.color = '#7ee0ff';
    meta.style.fontSize = '14px';

    link.append(name, description, meta);
    list.append(link);
  }

  wrapper.append(title, subtitle, count, list);
  canvas.append(wrapper);

  const aside = document.createElement('div');
  aside.style.display = 'grid';
  aside.style.gap = '16px';

  const summary = document.createElement('section');
  summary.style.padding = '16px';
  summary.style.border = '1px solid rgba(255, 255, 255, 0.08)';
  summary.style.borderRadius = '12px';
  summary.style.background = 'rgba(8, 12, 24, 0.4)';

  const summaryTitle = document.createElement('h2');
  summaryTitle.textContent = 'How labs work';
  summaryTitle.style.marginBottom = '8px';

  const summaryBody = document.createElement('p');
  summaryBody.textContent =
    'Each lab is a standalone sandbox with its own canvas and lil-gui controls.';
  summaryBody.style.color = '#c9d4ff';
  summaryBody.style.lineHeight = '1.6';

  summary.append(summaryTitle, summaryBody);

  const hint = document.createElement('section');
  hint.style.padding = '16px';
  hint.style.border = '1px solid rgba(255, 255, 255, 0.08)';
  hint.style.borderRadius = '12px';
  hint.style.background = 'rgba(8, 12, 24, 0.4)';

  const hintTitle = document.createElement('h2');
  hintTitle.textContent = 'Quick start';
  hintTitle.style.marginBottom = '8px';

  const hintBody = document.createElement('p');
  hintBody.textContent =
    labs.length > 0
      ? 'Select a lab to launch it in this window.'
      : 'Register a lab in src/labs to see it here.';
  hintBody.style.color = '#c9d4ff';
  hintBody.style.lineHeight = '1.6';

  hint.append(hintTitle, hintBody);

  aside.append(summary, hint);
  controls.append(aside);
}
