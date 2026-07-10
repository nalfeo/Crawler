/**
 * renderer.mjs — the achievements-editor canvas iframe document.
 *
 * `renderHtml(instanceId)` returns a complete, self-contained HTML document (the
 * host embeds it in an iframe with no privileged bridge). It is a faithful
 * functional port of the monolith's `renderAchievementsEditorPage`
 * (`src/devtools-main.ts`): search/filter, a two-column list+editor workspace,
 * title/popup/criteria/icon/details/flavor + reward overrides, an art backlog
 * panel, and a base+overrides export dump — with overrides persisted to
 * localStorage under the EXACT same key/shape as the monolith.
 *
 * Data + durable overrides come from the extension's own loopback server:
 *   - `GET  /api/state`      — `{achievements, artBacklog, lootBoxTiers, storageKey, overrides}`
 *   - `PUT  /api/overrides`  — persist `{overrides}` server-side (survives reopen)
 *   - `GET  /lib/overrides-model.mjs` — the SAME pure module the unit tests import
 *
 * The client is an ES module that imports that pure model over loopback, so the
 * tested override logic and the shipped override logic cannot drift. The script
 * body is template-literal-free (String.raw + string concat + createElement) so
 * this whole file stays one clean outer template with no backtick collisions.
 *
 * @module achievements/renderer
 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    background: var(--background-color-default, #0b1220);
    color: var(--text-color-default, #e5e7eb);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--text-body-medium, 13px);
    line-height: var(--leading-body-medium, 1.5);
  }
  h1 { font-size: var(--text-title-large, 20px); font-weight: 600; margin: 0 0 4px; }
  h3 { font-size: 14px; font-weight: 600; margin: 0; }
  .muted { color: var(--text-color-muted, #94a3b8); font-size: 12px; }
  .accent { color: #93c5fd; font-size: 12px; }
  header { margin-bottom: 12px; }
  .panel { border: 1px solid rgba(229,231,235,0.2); border-radius: 10px; background: #0b1220;
    padding: 12px; display: grid; gap: 10px; }
  .subpanel { border: 1px solid rgba(229,231,235,0.2); border-radius: 8px; background: #0f172a;
    padding: 10px; display: grid; gap: 8px; }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  input, textarea, select, button {
    font-family: inherit; font-size: 13px; color: #e5e7eb;
    border-radius: 8px; border: 1px solid rgba(148,163,184,0.35); background: #020617;
    padding: 7px 9px;
  }
  input[type="search"] { flex: 1 1 220px; background: #111827; border-color: rgba(229,231,235,0.3); }
  button { cursor: pointer; }
  button.reset { background: #1f2937; border-color: rgba(229,231,235,0.3); }
  button.reset-all { background: #3f1d1d; border-color: rgba(248,113,113,0.45); color: #fecaca; }
  button.refresh { background: #082f49; border-color: rgba(56,189,248,0.5); color: #e0f2fe; width: fit-content; }
  button.save { background: #052e16; border-color: rgba(34,197,94,0.55); color: #bbf7d0; }
  button.revert { background: #3f1d2e; border-color: rgba(251,113,133,0.55); color: #fecdd3; }
  .workspace { display: grid; gap: 10px; grid-template-columns: minmax(260px, 1fr) minmax(360px, 2fr); }
  .list-host { border: 1px solid rgba(229,231,235,0.2); border-radius: 8px; background: #0f172a;
    max-height: 58svh; overflow: auto; padding: 8px; display: grid; gap: 6px; }
  .editor-host { border: 1px solid rgba(229,231,235,0.2); border-radius: 8px; background: #0f172a;
    padding: 10px; display: grid; gap: 8px; }
  .row-btn { width: 100%; text-align: left; padding: 8px; border-radius: 8px;
    border: 1px solid rgba(148,163,184,0.3); background: #111827; color: #e5e7eb; cursor: pointer; }
  .row-btn.selected { border-color: rgba(56,189,248,0.7); background: #082f49; }
  .row-title { font-weight: 600; font-size: 13px; }
  .row-id { font-size: 11px; color: #7dd3fc; }
  .row-criteria { margin-top: 4px; font-size: 11px; color: #cbd5e1; }
  label.field { display: grid; gap: 4px; font-size: 12px; color: #bfdbfe; }
  textarea { min-height: 70px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .save-status { color: #93c5fd; font-size: 12px; }
  code { font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace); font-size: 12px; }
  .art-card { border: 1px solid rgba(148,163,184,0.3); border-radius: 8px; padding: 8px; background: #111827; }
  .art-card .name { font-weight: 600; }
  .art-card .desc { font-size: 12px; color: #cbd5e1; }
  .art-card .used { font-size: 11px; color: #94a3b8; margin-top: 2px; }
  .export-text { width: 100%; min-height: 180px; background: #020617; border: 1px solid rgba(148,163,184,0.35);
    border-radius: 8px; padding: 8px; font-family: monospace; font-size: 12px; color: #e2e8f0; }
  .panel.error { background: #7f1d1d; color: #fef3c7; border-color: rgba(255,255,255,0.18); }
`;

// NOTE: template-literal-free on purpose (no backticks, no ${}) — see file header.
const CLIENT_SCRIPT = String.raw`
import {
  getMergedAchievements,
  buildOverridePatch,
  normalizeQuery,
  filterMergedAchievements,
  computeSummary,
  rewardLabel,
  sanitizeOverrides,
} from './lib/overrides-model.mjs';

var app = document.getElementById('app');

// Working state (mirrors the monolith's closure vars).
var state = { achievements: [], artBacklog: [], lootBoxTiers: [], storageKey: '' };
var overrides = {};
var selectedId = null;
var query = '';

// Captured element refs (built once into the static shell).
var refs = {};

function h(tag, props, children) {
  var elem = document.createElement(tag);
  if (props) {
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      if (k === 'style') { for (var s in props.style) { elem.style[s] = props.style[s]; } }
      else if (k === 'text') { elem.textContent = props[k]; }
      else if (k === 'class') { elem.className = props[k]; }
      else if (k === 'value') { elem.value = props[k]; }
      else { elem.setAttribute(k, props[k]); }
    }
  }
  if (children) {
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c == null) continue;
      elem.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return elem;
}

function readLocalOverrides() {
  try {
    var raw = window.localStorage.getItem(state.storageKey);
    if (!raw) return {};
    return sanitizeOverrides(JSON.parse(raw));
  } catch (e) { return {}; }
}

function writeLocalOverrides() {
  try {
    window.localStorage.setItem(state.storageKey, JSON.stringify(overrides));
  } catch (e) { /* private mode / quota — server store is the durable source */ }
}

function putOverrides() {
  try {
    fetch('/api/overrides', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: overrides }),
    }).catch(function () { /* fire-and-forget; localStorage still mirrors it */ });
  } catch (e) { /* ignore */ }
}

// Persist a mutation to BOTH the in-page localStorage mirror (parity) and the
// durable server store (survives the harness's per-instance random port).
function persist() {
  writeLocalOverrides();
  putOverrides();
}

function getMerged() {
  return getMergedAchievements(state.achievements, overrides);
}

function updateExport() {
  refs.exportText.value = JSON.stringify(getMerged(), null, 2);
}

function renderList() {
  var merged = getMerged();
  var filtered = filterMergedAchievements(merged, query);
  refs.summary.textContent = computeSummary(merged.length, Object.keys(overrides).length, filtered.length);

  refs.listHost.replaceChildren();
  var makeClick = function (id) {
    return function () { selectedId = id; renderList(); renderEditor(); };
  };
  for (var i = 0; i < filtered.length; i++) {
    var achievement = filtered[i];
    var isSelected = achievement.id === selectedId;
    var hasOverride = Boolean(overrides[achievement.id]);
    var row = h('button', { class: isSelected ? 'row-btn selected' : 'row-btn', type: 'button' }, [
      h('div', { class: 'row-title', text: achievement.title + (hasOverride ? ' *' : '') }),
      h('code', { class: 'row-id', text: achievement.id }),
      h('div', { class: 'row-criteria', text: achievement.unlockCriteria }),
    ]);
    row.addEventListener('click', makeClick(achievement.id));
    refs.listHost.appendChild(row);
  }
}

function makeField(labelText, value, isArea, minHeight) {
  var control = isArea
    ? h('textarea', { value: value })
    : h('input', { value: value });
  if (isArea && minHeight) control.style.minHeight = minHeight + 'px';
  var wrap = h('label', { class: 'field' }, [h('span', { text: labelText }), control]);
  refs.editorHost.appendChild(wrap);
  return control;
}

function renderEditor() {
  refs.editorHost.replaceChildren();
  var merged = getMerged();
  var achievement = null;
  for (var i = 0; i < merged.length; i++) {
    if (merged[i].id === selectedId) { achievement = merged[i]; break; }
  }
  if (!achievement) {
    refs.editorHost.appendChild(h('p', { text: 'No achievement selected.' }));
    return;
  }

  var reward = achievement.reward || { type: 'none' };
  refs.editorHost.appendChild(h('h3', { text: achievement.title + ' (' + achievement.id + ')' }));
  refs.editorHost.appendChild(
    h('p', { class: 'accent', text: 'Difficulty: ' + achievement.difficulty + ' · Reward: ' + rewardLabel(reward) }),
  );

  var titleInput = makeField('Title', achievement.title, false);
  var popupInput = makeField('Popup text', achievement.popupText, false);
  var criteriaInput = makeField('Unlock criteria', achievement.unlockCriteria, false);
  var iconInput = makeField('Icon placeholder ID', achievement.iconId, false);
  var detailsInput = makeField('Details', achievement.details, true, 70);
  var flavorInput = makeField('Director flavor', achievement.directorFlavor, true, 110);

  var rewardTier = makeField(
    'Reward loot-box tier (if lootBox)',
    reward.type === 'lootBox' ? reward.tier : state.lootBoxTiers[0],
    false,
  );
  var rewardItem = makeField(
    'Reward item ID (if item)',
    reward.type === 'item' ? reward.itemId : '',
    false,
  );
  var rewardMessage = makeField(
    'Reward message (if directorMessage)',
    reward.type === 'directorMessage' ? reward.message : '',
    true,
    56,
  );

  // Reward TYPE select is appended AFTER the reward detail fields (monolith order).
  var rewardType = h('select', {});
  var types = ['lootBox', 'item', 'directorMessage', 'none'];
  for (var t = 0; t < types.length; t++) {
    rewardType.appendChild(h('option', { value: types[t], text: types[t] }));
  }
  rewardType.value = reward.type;
  refs.editorHost.appendChild(h('label', { class: 'field' }, [h('span', { text: 'Reward type' }), rewardType]));

  var saveBtn = h('button', { class: 'save', type: 'button', text: 'Save override' });
  var revertBtn = h('button', { class: 'revert', type: 'button', text: 'Revert selected' });
  var saveStatus = h('span', { class: 'save-status' });
  refs.editorHost.appendChild(h('div', { class: 'actions' }, [saveBtn, revertBtn, saveStatus]));

  saveBtn.addEventListener('click', function () {
    overrides[achievement.id] = buildOverridePatch(
      {
        title: titleInput.value,
        popupText: popupInput.value,
        unlockCriteria: criteriaInput.value,
        details: detailsInput.value,
        directorFlavor: flavorInput.value,
        iconId: iconInput.value,
        rewardType: rewardType.value,
        rewardTier: rewardTier.value,
        rewardItem: rewardItem.value,
        rewardMessage: rewardMessage.value,
      },
      state.lootBoxTiers,
    );
    persist();
    saveStatus.textContent = 'Saved override in localStorage.';
    // Monolith re-renders list + export only (editor keeps the typed values + status).
    renderList();
    updateExport();
  });

  revertBtn.addEventListener('click', function () {
    delete overrides[achievement.id];
    persist();
    selectedId = achievement.id;
    renderList();
    renderEditor();
    updateExport();
  });
}

function renderArtBacklog() {
  refs.artPanel.replaceChildren(
    h('h3', { text: 'Placeholder art backlog (icons + loot boxes)' }),
    h('p', { class: 'accent', text: state.artBacklog.length + ' placeholder packs tracked for replacement.' }),
  );
  var list = h('div', { style: { display: 'grid', gap: '6px' } });
  for (var i = 0; i < state.artBacklog.length; i++) {
    var item = state.artBacklog[i];
    var glyph = item.kind === 'lootBox' ? '📦' : '🧷';
    list.appendChild(
      h('div', { class: 'art-card' }, [
        h('div', { class: 'name', text: glyph + ' ' + item.placeholderId }),
        h('div', { class: 'desc', text: item.description }),
        h('div', { class: 'used', text: 'Used by ' + item.usedByAchievementIds.length + ' achievement(s)' }),
      ]),
    );
  }
  refs.artPanel.appendChild(list);
}

function buildShell() {
  app.replaceChildren();

  var search = h('input', { type: 'search', placeholder: 'Filter by id/title/criteria' });
  var resetSelectedBtn = h('button', { class: 'reset', type: 'button', text: 'Reset selected' });
  var resetAllBtn = h('button', { class: 'reset-all', type: 'button', text: 'Reset all overrides' });
  var controls = h('div', { class: 'controls' }, [search, resetSelectedBtn, resetAllBtn]);

  var summary = h('p', { class: 'accent' });

  var listHost = h('div', { class: 'list-host' });
  var editorHost = h('div', { class: 'editor-host' });
  var workspace = h('div', { class: 'workspace' }, [listHost, editorHost]);

  var artPanel = h('div', { class: 'subpanel' });

  var exportText = h('textarea', { class: 'export-text' });
  exportText.readOnly = true;
  var refreshExportBtn = h('button', { class: 'refresh', type: 'button', text: 'Refresh export JSON' });
  var exportPanel = h('div', { class: 'subpanel' }, [
    h('h3', { text: 'Export (base + local overrides)' }),
    refreshExportBtn,
    exportText,
  ]);

  var panel = h('section', { class: 'panel' }, [controls, summary, workspace, artPanel, exportPanel]);
  app.appendChild(panel);

  refs = { search: search, summary: summary, listHost: listHost, editorHost: editorHost,
    artPanel: artPanel, exportText: exportText };

  search.addEventListener('input', function () {
    query = normalizeQuery(search.value);
    renderList();
  });
  resetSelectedBtn.addEventListener('click', function () {
    if (!selectedId) return;
    delete overrides[selectedId];
    persist();
    renderList();
    renderEditor();
    updateExport();
  });
  resetAllBtn.addEventListener('click', function () {
    overrides = {};
    persist();
    renderList();
    renderEditor();
    updateExport();
  });
  refreshExportBtn.addEventListener('click', updateExport);
}

function renderError(message) {
  app.replaceChildren(
    h('section', { class: 'panel error' }, [
      h('h3', { text: 'Could not load the achievements catalog' }),
      h('div', { text: String(message) }),
      h('div', { class: 'muted', style: { marginTop: '6px' } }, [
        'Check that ', h('code', { text: 'src/shared/data/achievements.floor1.json' }), ' is present and valid.',
      ]),
    ]),
  );
}

function hydrateOverrides(serverOverrides) {
  var server = sanitizeOverrides(serverOverrides);
  var local = readLocalOverrides();
  if (Object.keys(server).length === 0 && Object.keys(local).length > 0) {
    // Server empty but the page kept overrides — adopt them and heal the store up.
    overrides = local;
    persist();
  } else {
    // Server is authoritative — adopt it and mirror down to localStorage.
    overrides = server;
    writeLocalOverrides();
  }
}

function loadState() {
  fetch('/api/state')
    .then(function (r) { return r.json(); })
    .then(function (payload) {
      if (payload && payload.error) { renderError(payload.error); return; }
      state = {
        achievements: payload.achievements || [],
        artBacklog: payload.artBacklog || [],
        lootBoxTiers: payload.lootBoxTiers || [],
        storageKey: payload.storageKey || '',
      };
      hydrateOverrides(payload.overrides);
      if (!selectedId) selectedId = state.achievements[0] ? state.achievements[0].id : null;
      buildShell();
      renderList();
      renderEditor();
      renderArtBacklog();
      updateExport();
    })
    .catch(function (err) { renderError(err && err.message ? err.message : err); });
}

loadState();
`;

/**
 * Full HTML document for one canvas instance.
 * @param {string} instanceId
 * @returns {string}
 */
export function renderHtml(instanceId) {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<title>Achievements Editor</title>',
    '<style>' + STYLES + '</style>',
    '</head><body>',
    '<header>',
    '<h1>Achievements Editor</h1>',
    '<div class="muted">View all Floor 1 achievements, edit title/criteria/flavor/reward overrides, and review icon + loot-box art backlog.</div>',
    '</header>',
    '<div id="app" data-instance="' + escapeHtml(instanceId) + '">',
    '<p class="muted">Loading achievements…</p>',
    '</div>',
    '<script type="module">' + CLIENT_SCRIPT + '</script>',
    '</body></html>',
  ].join('');
}
