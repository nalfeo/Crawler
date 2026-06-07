/**
 * Sprite gallery lab — read-only viewer for sprite-pipeline runs.
 *
 * This lab is the human review surface for unattended batch runs. It is
 * strictly read-only this PR (no approve / no mutation). Approve flows
 * land in a follow-up — see the spec at
 * `.specify/specs/sprite-generation-pipeline.md` §F7-F9.
 *
 * Layer note (per `src/labs/**` instructions): labs are unrestricted. We
 * still avoid Phaser here — this is a DOM/Canvas viewer, not a scene.
 *
 * Sidecar contract: GET http://127.0.0.1:3010/api/health, /api/runs,
 * /api/runs/:brief/:run, and /api/runs/:brief/:run/processed/:filename.
 * When the sidecar is unreachable the lab degrades to a fallback banner
 * (spec §F9) — review-only mode without a data source — and continues
 * to render successfully.
 */

import { registerLab } from '../registry.js';

const SIDECAR_BASE = 'http://127.0.0.1:3010';
const SPRITE_PIXEL_SCALE = 8;

interface SidecarRunListEntry {
  briefId: string;
  runId: string;
  timestamp: string | null;
  briefHash: string | null;
  chosenIndex: number | null;
  candidateCount: number | null;
  hasJudge: boolean;
}

interface SidecarRunListResponse {
  runs: SidecarRunListEntry[];
}

interface SidecarHealth {
  status: string;
  repoRoot: string;
  runsDir: string;
  version: string;
}

interface CandidateRef {
  briefIndex: number;
  candidateIndex: number;
}

type ElProps<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], 'style'>
> & {
  style?: Partial<CSSStyleDeclaration>;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps<K> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { style, ...rest } = props as { style?: Partial<CSSStyleDeclaration> } & Record<
    string,
    unknown
  >;
  Object.assign(node, rest);
  if (style) {
    Object.assign(node.style, style);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

function spriteUrl(briefId: string, runId: string, filename: string): string {
  return `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}/processed/${encodeURIComponent(filename)}`;
}

function summaryUrl(briefId: string, runId: string): string {
  return `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return (await res.json()) as T;
}

/** Render a value as a collapsible tree using <details> for object/array nodes. */
function renderJsonTree(value: unknown, label?: string): HTMLElement {
  const wrap = el('div', {
    style: { fontFamily: 'monospace', fontSize: '12px', lineHeight: '1.5' },
  });
  if (value === null || typeof value !== 'object') {
    const line = el('div');
    const labelSpan = label
      ? el('span', { textContent: `${label}: `, style: { color: '#94a3b8' } })
      : null;
    const valSpan = el('span', {
      textContent: typeof value === 'string' ? `"${value}"` : String(value),
      style: {
        color:
          typeof value === 'number'
            ? '#facc15'
            : typeof value === 'boolean'
              ? '#a78bfa'
              : '#bef264',
      },
    });
    if (labelSpan) line.append(labelSpan);
    line.append(valSpan);
    wrap.append(line);
    return wrap;
  }
  const details = el('details', { open: true });
  details.style.marginLeft = label ? '12px' : '0';
  const summary = el('summary', {
    textContent: label
      ? `${label} ${Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`}`
      : Array.isArray(value)
        ? `Array(${value.length})`
        : 'Object',
    style: { cursor: 'pointer', color: '#7ee0ff' },
  });
  details.append(summary);
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries) {
    details.append(renderJsonTree(v, k));
  }
  wrap.append(details);
  return wrap;
}

function renderBanner(
  host: HTMLElement,
  kind: 'error' | 'warn' | 'info',
  title: string,
  body: string,
): void {
  const bg = kind === 'error' ? '#7f1d1d' : kind === 'warn' ? '#78350f' : '#1e3a8a';
  const banner = el(
    'div',
    {
      style: {
        background: bg,
        color: '#fef3c7',
        padding: '16px 20px',
        borderRadius: '10px',
        margin: '0 0 16px 0',
        border: '1px solid rgba(255,255,255,0.18)',
        lineHeight: '1.5',
      },
    },
    [
      el('div', {
        textContent: title,
        style: { fontWeight: '700', fontSize: '15px', marginBottom: '6px', color: '#fff' },
      }),
      el('div', { textContent: body, style: { fontSize: '13px', whiteSpace: 'pre-wrap' } }),
    ],
  );
  host.append(banner);
}

interface CreatedGallery {
  candidates: CandidateRef[];
  briefCount: number;
  focus(ref: CandidateRef): void;
}

function createGalleryGrid(
  host: HTMLElement,
  runs: SidecarRunListEntry[],
  details: Map<string, Record<string, unknown>>,
  state: { showOverlay: boolean; onSelect: (ref: CandidateRef) => void },
): CreatedGallery {
  host.replaceChildren();
  const candidates: CandidateRef[] = [];

  for (let bi = 0; bi < runs.length; bi++) {
    const run = runs[bi]!;
    const briefDetail = details.get(`${run.briefId}/${run.runId}`);
    const candidatesArr = Array.isArray(briefDetail?.candidates)
      ? (briefDetail!.candidates as Array<Record<string, unknown>>)
      : [];

    const briefRow = el('section', {
      style: {
        marginBottom: '24px',
        padding: '14px',
        border: '1px solid rgba(148,163,184,0.2)',
        borderRadius: '10px',
        background: 'rgba(15,23,42,0.6)',
      },
    });

    const header = el(
      'header',
      {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: '10px',
          gap: '12px',
        },
      },
      [
        el('div', {}, [
          el('span', {
            textContent: run.briefId,
            style: { fontWeight: '700', fontSize: '15px', color: '#f1f5f9' },
          }),
          el('span', {
            textContent: ` · ${run.runId}`,
            style: { fontSize: '11px', color: '#94a3b8', marginLeft: '8px' },
          }),
        ]),
        el('div', {
          textContent: `${run.candidateCount ?? '?'} candidates${run.hasJudge ? ' · judge' : ''}`,
          style: { fontSize: '11px', color: '#94a3b8' },
        }),
      ],
    );
    briefRow.append(header);

    const grid = el('div', {
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '12px',
      },
    });

    if (candidatesArr.length === 0) {
      grid.append(
        el('div', {
          textContent: 'Run summary missing or unreadable.',
          style: { color: '#fca5a5', fontSize: '12px', padding: '10px' },
        }),
      );
    }

    for (let ci = 0; ci < candidatesArr.length; ci++) {
      const cand = candidatesArr[ci]!;
      const idx = typeof cand.index === 'number' ? cand.index : ci;
      const padded = String(idx).padStart(2, '0');
      const passed = cand.passed === true;
      const combinedPassed = cand.combinedPassed === true;
      const isChosen = run.chosenIndex === idx;
      const judge = cand.judgeScorecard as Record<string, unknown> | null | undefined;

      const flatIndex = candidates.length;
      candidates.push({ briefIndex: bi, candidateIndex: ci });

      const tile = el('button', {
        type: 'button',
        style: {
          position: 'relative',
          padding: '0',
          border: isChosen ? '2px solid #facc15' : '2px solid rgba(148,163,184,0.25)',
          borderRadius: '8px',
          background: 'rgba(2,6,23,0.8)',
          cursor: 'pointer',
          width: `${SPRITE_PIXEL_SCALE * 16 + 24}px`,
          textAlign: 'left',
          color: '#f1f5f9',
          fontFamily: 'inherit',
        },
      });
      tile.dataset.flatIndex = String(flatIndex);

      const spriteHolder = el('div', {
        style: {
          position: 'relative',
          width: `${SPRITE_PIXEL_SCALE * 16}px`,
          height: `${SPRITE_PIXEL_SCALE * 16}px`,
          margin: '8px auto 6px',
          backgroundImage:
            'linear-gradient(45deg, #1e293b 25%, transparent 25%), linear-gradient(-45deg, #1e293b 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1e293b 75%), linear-gradient(-45deg, transparent 75%, #1e293b 75%)',
          backgroundSize: '12px 12px',
          backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0',
          backgroundColor: '#334155',
        },
      });
      const spriteImg = el('img', {
        src: spriteUrl(run.briefId, run.runId, `${padded}.png`),
        alt: `${run.briefId} #${padded}`,
        style: {
          position: 'absolute',
          inset: '0',
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated' as CSSStyleDeclaration['imageRendering'],
        },
      });
      const overlayImg = el('img', {
        src: spriteUrl(run.briefId, run.runId, `${padded}.anchor-overlay.png`),
        alt: '',
        style: {
          position: 'absolute',
          inset: '0',
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated' as CSSStyleDeclaration['imageRendering'],
          display: state.showOverlay ? 'block' : 'none',
          pointerEvents: 'none',
        },
      });
      overlayImg.dataset.role = 'anchor-overlay';
      spriteHolder.append(spriteImg, overlayImg);
      tile.append(spriteHolder);

      const meta = el('div', {
        style: { padding: '0 8px 8px', display: 'flex', flexWrap: 'wrap', gap: '4px' },
      });

      const sensorBadge = el('span', {
        textContent: passed ? 'sensor ✓' : 'sensor ✗',
        style: {
          fontSize: '10px',
          padding: '2px 6px',
          borderRadius: '4px',
          background: passed ? '#14532d' : '#7f1d1d',
          color: '#ecfdf5',
        },
      });
      meta.append(sensorBadge);

      if (judge && typeof judge === 'object') {
        const minScore = typeof judge.minScore === 'number' ? judge.minScore : null;
        const judgePassed = judge.passed === true;
        const judgeBadge = el('span', {
          textContent: `judge ${judgePassed ? '✓' : '✗'}${minScore != null ? ` · ${minScore}` : ''}`,
          style: {
            fontSize: '10px',
            padding: '2px 6px',
            borderRadius: '4px',
            background: judgePassed ? '#14532d' : '#7f1d1d',
            color: '#ecfdf5',
          },
        });
        meta.append(judgeBadge);
      }

      if (isChosen) {
        meta.append(
          el('span', {
            textContent: 'chosen',
            style: {
              fontSize: '10px',
              padding: '2px 6px',
              borderRadius: '4px',
              background: '#facc15',
              color: '#422006',
              fontWeight: '700',
            },
          }),
        );
      }

      if (!combinedPassed && !isChosen) {
        meta.append(
          el('span', {
            textContent: 'rejected',
            style: { fontSize: '10px', color: '#fca5a5' },
          }),
        );
      }

      tile.append(meta);
      tile.addEventListener('click', () => state.onSelect({ briefIndex: bi, candidateIndex: ci }));
      grid.append(tile);
    }

    briefRow.append(grid);
    host.append(briefRow);
  }

  function focus(ref: CandidateRef): void {
    const flat = candidates.findIndex(
      (c) => c.briefIndex === ref.briefIndex && c.candidateIndex === ref.candidateIndex,
    );
    if (flat < 0) return;
    const tile = host.querySelector<HTMLButtonElement>(`button[data-flat-index="${flat}"]`);
    if (!tile) return;
    tile.focus({ preventScroll: false });
    tile.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  return { candidates, briefCount: runs.length, focus };
}

function createGalleryLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const root = el('div', {
    style: {
      position: 'absolute',
      inset: '0',
      display: 'grid',
      gridTemplateColumns: '1fr 360px',
      gap: '0',
      background: '#0f172a',
      color: '#e2e8f0',
      overflow: 'hidden',
    },
  });

  const left = el('div', { style: { overflow: 'auto', padding: '16px 20px' } });
  const right = el('aside', {
    style: {
      overflow: 'auto',
      padding: '16px',
      borderLeft: '1px solid rgba(148,163,184,0.18)',
      background: 'rgba(2,6,23,0.6)',
    },
  });

  const toolbar = el(
    'div',
    {
      style: {
        display: 'flex',
        gap: '10px',
        alignItems: 'center',
        marginBottom: '14px',
        flexWrap: 'wrap',
      },
    },
    [
      el('h2', {
        textContent: 'Sprite gallery',
        style: { margin: '0', fontSize: '18px', color: '#f8fafc' },
      }),
      el('span', {
        textContent: 'Read-only · ←/→ candidates · ↑/↓ briefs',
        style: { fontSize: '11px', color: '#94a3b8' },
      }),
    ],
  );

  const overlayToggle = el('button', {
    type: 'button',
    textContent: 'Anchor overlay: on',
    style: {
      marginLeft: 'auto',
      padding: '6px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(148,163,184,0.4)',
      background: 'transparent',
      color: '#e2e8f0',
      cursor: 'pointer',
      fontSize: '12px',
    },
  });
  toolbar.append(overlayToggle);

  const refreshBtn = el('button', {
    type: 'button',
    textContent: 'Refresh',
    style: {
      padding: '6px 10px',
      borderRadius: '6px',
      border: '1px solid rgba(148,163,184,0.4)',
      background: 'transparent',
      color: '#e2e8f0',
      cursor: 'pointer',
      fontSize: '12px',
    },
  });
  toolbar.append(refreshBtn);

  const bannerHost = el('div', {});
  const gridHost = el('div', {});

  left.append(toolbar, bannerHost, gridHost);

  const sidePanel = el('div', {});
  sidePanel.append(
    el('div', {
      textContent: 'Select a candidate to see its scorecard, judge breakdown, and derived anchor.',
      style: { fontSize: '12px', color: '#94a3b8' },
    }),
  );
  right.append(sidePanel);

  root.append(left, right);
  canvasHost.append(root);

  controls.style.display = 'none';

  const state = {
    showOverlay: true,
    runs: [] as SidecarRunListEntry[],
    details: new Map<string, Record<string, unknown>>(),
    grid: null as CreatedGallery | null,
    selected: null as CandidateRef | null,
  };

  function setOverlayVisibility(show: boolean): void {
    state.showOverlay = show;
    overlayToggle.textContent = `Anchor overlay: ${show ? 'on' : 'off'}`;
    for (const img of gridHost.querySelectorAll<HTMLImageElement>(
      'img[data-role="anchor-overlay"]',
    )) {
      img.style.display = show ? 'block' : 'none';
    }
  }
  overlayToggle.addEventListener('click', () => setOverlayVisibility(!state.showOverlay));

  function renderSidePanel(ref: CandidateRef | null): void {
    sidePanel.replaceChildren();
    if (!ref) {
      sidePanel.append(
        el('div', {
          textContent: 'Select a candidate.',
          style: { fontSize: '12px', color: '#94a3b8' },
        }),
      );
      return;
    }
    const run = state.runs[ref.briefIndex];
    if (!run) return;
    const detail = state.details.get(`${run.briefId}/${run.runId}`);
    const candidatesArr = Array.isArray(detail?.candidates)
      ? (detail!.candidates as Array<Record<string, unknown>>)
      : [];
    const cand = candidatesArr[ref.candidateIndex];
    if (!cand) return;
    const header = el('div', { style: { marginBottom: '10px' } }, [
      el('div', { textContent: run.briefId, style: { fontWeight: '700', color: '#f1f5f9' } }),
      el('div', {
        textContent: `${run.runId} · candidate ${cand.index ?? ref.candidateIndex}`,
        style: { fontSize: '11px', color: '#94a3b8' },
      }),
    ]);
    sidePanel.append(header);
    sidePanel.append(renderJsonTree(cand, 'candidate'));
  }

  function selectCandidate(ref: CandidateRef): void {
    state.selected = ref;
    renderSidePanel(ref);
    state.grid?.focus(ref);
  }

  function rerenderGrid(): void {
    state.grid = createGalleryGrid(gridHost, state.runs, state.details, {
      showOverlay: state.showOverlay,
      onSelect: selectCandidate,
    });
    if (state.selected) {
      state.grid.focus(state.selected);
    }
  }

  async function load(): Promise<void> {
    bannerHost.replaceChildren();
    gridHost.replaceChildren(
      el('div', { textContent: 'Loading…', style: { color: '#94a3b8', padding: '24px' } }),
    );

    let health: SidecarHealth;
    try {
      health = await fetchJson<SidecarHealth>(`${SIDECAR_BASE}/api/health`);
    } catch (err) {
      gridHost.replaceChildren();
      renderBanner(
        bannerHost,
        'warn',
        'Sidecar not running — gallery is in read-only fallback mode.',
        `Start it with:\n    npm run sprites:gallery\n\nReason: ${err instanceof Error ? err.message : String(err)}\n\nNo pre-baked snapshot is bundled with this build, so there is nothing to display until the sidecar is reachable on ${SIDECAR_BASE}.`,
      );
      return;
    }

    try {
      const list = await fetchJson<SidecarRunListResponse>(`${SIDECAR_BASE}/api/runs`);
      state.runs = list.runs;
      state.details = new Map();
      const detailEntries = await Promise.all(
        state.runs.map(async (r) => {
          try {
            const summary = await fetchJson<Record<string, unknown>>(
              summaryUrl(r.briefId, r.runId),
            );
            return [`${r.briefId}/${r.runId}`, summary] as const;
          } catch {
            return [
              `${r.briefId}/${r.runId}`,
              { candidates: [] } as Record<string, unknown>,
            ] as const;
          }
        }),
      );
      for (const [key, summary] of detailEntries) {
        state.details.set(key, summary);
      }
      if (state.runs.length === 0) {
        renderBanner(
          bannerHost,
          'info',
          'Sidecar healthy — no runs found yet.',
          `Looked under: ${health.runsDir}\nRun \`npm run sprites:run -- --brief <id>\` to produce candidates.`,
        );
        gridHost.replaceChildren();
        return;
      }
      rerenderGrid();
      if (state.grid && state.grid.candidates.length > 0 && !state.selected) {
        selectCandidate(state.grid.candidates[0]!);
      }
    } catch (err) {
      gridHost.replaceChildren();
      renderBanner(
        bannerHost,
        'error',
        'Sidecar replied but /api/runs failed.',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  refreshBtn.addEventListener('click', () => {
    void load();
  });

  function onKeyDown(event: KeyboardEvent): void {
    if (!state.grid || state.grid.candidates.length === 0) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
      return;
    const cur = state.selected ?? state.grid.candidates[0]!;
    let next: CandidateRef | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const flat = state.grid.candidates.findIndex(
        (c) => c.briefIndex === cur.briefIndex && c.candidateIndex === cur.candidateIndex,
      );
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const target = Math.max(0, Math.min(state.grid.candidates.length - 1, flat + delta));
      next = state.grid.candidates[target] ?? null;
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const targetBrief = Math.max(0, Math.min(state.grid.briefCount - 1, cur.briefIndex + delta));
      const candidate = state.grid.candidates.find((c) => c.briefIndex === targetBrief);
      if (candidate) {
        next = candidate;
      }
    } else {
      return;
    }
    if (next) {
      event.preventDefault();
      selectCandidate(next);
    }
  }
  window.addEventListener('keydown', onKeyDown);

  void load();

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    controls.style.display = '';
    canvasHost.replaceChildren();
  };
}

registerLab('sprite-gallery', {
  name: 'Sprite Gallery',
  description:
    'Read-only review surface for sprite-pipeline runs. Renders thumbnails, anchor overlays, sensor + judge badges. Requires the sprites sidecar (`npm run sprites:gallery`).',
  category: 'Meta',
  create: createGalleryLab,
});
