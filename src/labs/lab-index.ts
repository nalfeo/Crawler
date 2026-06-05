import { getAllLabs } from './registry.js';
import type { LabCategory, LabDefinition } from './registry.js';

const CATEGORY_ORDER: LabCategory[] = [
  'Combat',
  'Movement & Physics',
  'Items & Equipment',
  'Progression',
  'Entities',
  'Meta',
];

const CATEGORY_ICONS: Record<LabCategory | 'Uncategorized', string> = {
  Combat: '⚔️',
  'Movement & Physics': '🏃',
  'Items & Equipment': '🎒',
  Progression: '📈',
  Entities: '👾',
  Meta: '🔧',
  Uncategorized: '📦',
};

const COLLAPSED_KEY = 'lab-index-collapsed';

function getCollapsedState(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedState(collapsed: Set<string>): void {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
}

function createLabCard(id: string, lab: LabDefinition): HTMLElement {
  const link = document.createElement('a');
  link.href = `?lab=${encodeURIComponent(id)}`;
  link.style.display = 'block';
  link.style.padding = '16px 20px';
  link.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  link.style.borderRadius = '12px';
  link.style.background = 'rgba(22, 33, 62, 0.9)';
  link.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.15)';
  link.style.color = '#e0e0e0';
  link.style.textDecoration = 'none';
  link.style.transition = 'border-color 0.15s, transform 0.15s';
  link.addEventListener('mouseenter', () => {
    link.style.borderColor = 'rgba(126, 224, 255, 0.4)';
    link.style.transform = 'translateY(-1px)';
  });
  link.addEventListener('mouseleave', () => {
    link.style.borderColor = 'rgba(255, 255, 255, 0.12)';
    link.style.transform = 'none';
  });

  const name = document.createElement('h3');
  name.textContent = lab.name;
  name.style.fontSize = '18px';
  name.style.marginBottom = '4px';

  const description = document.createElement('p');
  description.textContent = lab.description;
  description.style.color = '#c9d4ff';
  description.style.lineHeight = '1.5';
  description.style.fontSize = '14px';
  description.style.marginBottom = '8px';

  const meta = document.createElement('code');
  meta.textContent = id;
  meta.style.color = '#7ee0ff';
  meta.style.fontSize = '12px';

  link.append(name, description, meta);
  return link;
}

function createCategorySection(
  categoryName: string,
  labs: [string, LabDefinition][],
  collapsed: Set<string>,
): HTMLElement {
  const section = document.createElement('details');
  section.open = !collapsed.has(categoryName);
  section.style.marginBottom = '8px';

  const summary = document.createElement('summary');
  summary.style.cursor = 'pointer';
  summary.style.padding = '12px 16px';
  summary.style.borderRadius = '12px';
  summary.style.background = 'rgba(8, 12, 24, 0.5)';
  summary.style.border = '1px solid rgba(255, 255, 255, 0.08)';
  summary.style.listStyle = 'none';
  summary.style.display = 'flex';
  summary.style.alignItems = 'center';
  summary.style.gap = '10px';
  summary.style.userSelect = 'none';
  summary.style.transition = 'background 0.15s';
  summary.addEventListener('mouseenter', () => {
    summary.style.background = 'rgba(8, 12, 24, 0.7)';
  });
  summary.addEventListener('mouseleave', () => {
    summary.style.background = 'rgba(8, 12, 24, 0.5)';
  });

  const icon = CATEGORY_ICONS[categoryName as LabCategory | 'Uncategorized'] ?? '📦';

  const chevron = document.createElement('span');
  chevron.textContent = section.open ? '▾' : '▸';
  chevron.style.fontSize = '12px';
  chevron.style.width = '12px';
  chevron.style.color = '#7ee0ff';

  const label = document.createElement('span');
  label.textContent = `${icon} ${categoryName}`;
  label.style.fontSize = '18px';
  label.style.fontWeight = '600';
  label.style.flex = '1';

  const badge = document.createElement('span');
  badge.textContent = `${labs.length}`;
  badge.style.fontSize = '13px';
  badge.style.color = '#7ee0ff';
  badge.style.background = 'rgba(126, 224, 255, 0.1)';
  badge.style.padding = '2px 8px';
  badge.style.borderRadius = '8px';

  summary.append(chevron, label, badge);
  section.append(summary);

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gap = '10px';
  grid.style.padding = '12px 0 4px 28px';

  for (const [id, lab] of labs) {
    grid.append(createLabCard(id, lab));
  }

  section.append(grid);

  section.addEventListener('toggle', () => {
    chevron.textContent = section.open ? '▾' : '▸';
    if (section.open) {
      collapsed.delete(categoryName);
    } else {
      collapsed.add(categoryName);
    }
    saveCollapsedState(collapsed);
  });

  return section;
}

export function renderLabIndex(): void {
  const canvas = document.getElementById('lab-canvas');
  const controls = document.getElementById('lab-controls');

  if (!canvas || !controls) {
    throw new Error('Lab page containers are missing.');
  }

  canvas.replaceChildren();
  controls.replaceChildren();

  // Clear any inline style overrides so #lab-canvas reverts to its stylesheet/flex defaults.
  canvas.style.cssText = '';

  const labs = [...getAllLabs().entries()].sort(([leftId], [rightId]) =>
    leftId.localeCompare(rightId),
  );

  // Group labs by category
  const groups = new Map<string, [string, LabDefinition][]>();
  for (const entry of labs) {
    const category = entry[1].category ?? 'Uncategorized';
    if (!groups.has(category)) {
      groups.set(category, []);
    }
    groups.get(category)!.push(entry);
  }

  // Sort groups by defined order
  const sortedCategories = [...groups.keys()].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a as LabCategory);
    const bi = CATEGORY_ORDER.indexOf(b as LabCategory);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const collapsed = getCollapsedState();

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
  subtitle.style.marginBottom = '16px';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'space-between';
  header.style.marginBottom = '24px';

  const count = document.createElement('p');
  count.textContent = `${labs.length} lab${labs.length === 1 ? '' : 's'} in ${sortedCategories.length} ${sortedCategories.length === 1 ? 'group' : 'groups'}`;
  count.style.color = '#7ee0ff';

  const toggleAll = document.createElement('button');
  const allStartCollapsed = sortedCategories.every((c) => collapsed.has(c));
  toggleAll.textContent = allStartCollapsed ? 'Expand All' : 'Collapse All';
  toggleAll.style.background = 'rgba(126, 224, 255, 0.1)';
  toggleAll.style.border = '1px solid rgba(126, 224, 255, 0.3)';
  toggleAll.style.borderRadius = '8px';
  toggleAll.style.color = '#7ee0ff';
  toggleAll.style.padding = '6px 12px';
  toggleAll.style.cursor = 'pointer';
  toggleAll.style.fontSize = '13px';

  header.append(count, toggleAll);

  const list = document.createElement('div');
  list.style.display = 'grid';
  list.style.gap = '8px';

  if (labs.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = 'No labs are registered yet.';
    empty.style.padding = '24px';
    empty.style.border = '1px solid rgba(255, 255, 255, 0.08)';
    empty.style.borderRadius = '16px';
    empty.style.background = 'rgba(22, 33, 62, 0.75)';
    list.append(empty);
  } else {
    for (const category of sortedCategories) {
      list.append(createCategorySection(category, groups.get(category)!, collapsed));
    }
  }

  toggleAll.addEventListener('click', () => {
    const details = list.querySelectorAll('details');
    const allClosed = [...details].every((d) => !d.open);
    for (const d of details) {
      d.open = allClosed;
      const chevron = d.querySelector('summary span');
      if (chevron) chevron.textContent = allClosed ? '▾' : '▸';
    }
    if (allClosed) {
      collapsed.clear();
    } else {
      for (const cat of sortedCategories) collapsed.add(cat);
    }
    saveCollapsedState(collapsed);
    toggleAll.textContent = allClosed ? 'Collapse All' : 'Expand All';
  });

  wrapper.append(title, subtitle, header, list);
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
