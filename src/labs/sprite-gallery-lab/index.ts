/**
 * Sprite gallery lab — read-only viewer for sprite-pipeline runs.
 *
 * This lab is the human review surface for unattended batch runs. It is
 * strictly read-only (no approve / no mutation). Approval now lives in the
 * devtools workflow to keep labs focused on inspection and debugging.
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
const SPRITE_BASE_SIZE = 64;
const PREVIEW_SCALE_OPTIONS = [0.25, 0.5, 1, 2, 4] as const;

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

interface SidecarSheetsResponse {
  files: string[];
}

interface CandidateRef {
  briefIndex: number;
  candidateIndex: number;
}

interface SensorFailureSummary {
  sensor: string;
  reason: string;
}

interface PipelineStepManifest {
  id?: string;
  label?: string;
  file?: string;
}

interface PipelineManifest {
  profile?: string;
  steps?: PipelineStepManifest[];
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

function sheetsUrl(briefId: string, runId: string): string {
  return `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}/sheets`;
}

function sheetUrl(briefId: string, runId: string, filename: string): string {
  return `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}/sheet/${encodeURIComponent(filename)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function extractSensorFailures(candidate: Record<string, unknown>): SensorFailureSummary[] {
  const breakdown = Array.isArray(candidate.breakdown) ? candidate.breakdown : [];
  const failures: SensorFailureSummary[] = [];
  for (const item of breakdown) {
    if (!isRecord(item)) continue;
    const ok = item.ok;
    const sensor = item.sensor;
    const reason = item.reason;
    if (
      ok === false &&
      typeof sensor === 'string' &&
      sensor.length > 0 &&
      typeof reason === 'string' &&
      reason.length > 0
    ) {
      failures.push({ sensor, reason });
    }
  }
  return failures;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return (await res.json()) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestGalleryStart(): Promise<void> {
  const res = await fetch('/__sprite-gallery-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    let detail: string;
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text();
    }
    throw new Error(`Auto-start failed (${res.status}): ${detail || res.statusText}`);
  }
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
  state: {
    showOverlay: boolean;
    previewScale: number;
    onSelect: (ref: CandidateRef) => void;
    onDismiss?: (briefId: string, runId: string) => void;
  },
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
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, [
          el('span', {
            textContent: `${run.candidateCount ?? '?'} candidates${run.hasJudge ? ' · judge' : ''}`,
            style: { fontSize: '11px', color: '#94a3b8' },
          }),
          (() => {
            const btn = el('button', {
              textContent: '✕ Dismiss',
              style: {
                fontSize: '11px',
                padding: '2px 8px',
                border: '1px solid rgba(239,68,68,0.4)',
                borderRadius: '4px',
                background: 'rgba(239,68,68,0.1)',
                color: '#fca5a5',
                cursor: 'pointer',
              },
            });
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              if (state.onDismiss) state.onDismiss(run.briefId, run.runId);
            });
            return btn;
          })(),
        ]),
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
          width: `${Math.max(16, Math.round(SPRITE_BASE_SIZE * state.previewScale)) + 24}px`,
          textAlign: 'left',
          color: '#f1f5f9',
          fontFamily: 'inherit',
        },
      });
      tile.dataset.flatIndex = String(flatIndex);

      const spriteHolder = el('div', {
        style: {
          position: 'relative',
          width: `${Math.max(16, Math.round(SPRITE_BASE_SIZE * state.previewScale))}px`,
          height: `${Math.max(16, Math.round(SPRITE_BASE_SIZE * state.previewScale))}px`,
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
      const sizeBadge = el('span', {
        textContent: 'size …',
        style: {
          fontSize: '10px',
          padding: '2px 6px',
          borderRadius: '4px',
          background: '#1e293b',
          color: '#cbd5e1',
        },
      });
      spriteImg.addEventListener('load', () => {
        const width = spriteImg.naturalWidth;
        const height = spriteImg.naturalHeight;
        sizeBadge.textContent = width > 0 && height > 0 ? `size ${width}x${height}` : 'size n/a';
      });
      spriteImg.addEventListener('error', () => {
        sizeBadge.textContent = 'size n/a';
      });
      meta.append(sizeBadge);

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
      const failedSensors = extractSensorFailures(cand);
      const failureList = el('div', {
        style: {
          padding: '0 8px 8px',
          fontSize: '10px',
          color: failedSensors.length > 0 ? '#fecaca' : '#86efac',
          lineHeight: '1.35',
        },
      });
      if (failedSensors.length === 0) {
        failureList.textContent = passed
          ? 'No sensor failures'
          : 'Sensor failed, but no per-sensor reasons were recorded for this run.';
      } else {
        const visible = failedSensors.slice(0, 2);
        for (const failure of visible) {
          failureList.append(
            el('div', {
              textContent: `${failure.sensor}: ${failure.reason}`,
              title: `${failure.sensor}: ${failure.reason}`,
              style: {
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            }),
          );
        }
        if (failedSensors.length > visible.length) {
          failureList.append(
            el('div', {
              textContent: `+${failedSensors.length - visible.length} more`,
              style: { color: '#fda4af' },
            }),
          );
        }
      }
      tile.append(failureList);
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

  const scaleGroup = el('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '2px',
      borderRadius: '8px',
      border: '1px solid rgba(148,163,184,0.35)',
      background: 'rgba(15,23,42,0.85)',
    },
  });
  scaleGroup.append(
    el('span', {
      textContent: 'Scale',
      style: {
        fontSize: '11px',
        color: '#cbd5e1',
        padding: '0 6px',
      },
    }),
  );
  const scaleButtons = new Map<number, HTMLButtonElement>();
  const updateScaleButtons = (): void => {
    for (const [scale, button] of scaleButtons) {
      const selected = state.previewScale === scale;
      button.style.background = selected ? '#334155' : 'transparent';
      button.style.borderColor = selected ? '#93c5fd' : 'rgba(148,163,184,0.35)';
      button.style.color = selected ? '#f8fafc' : '#cbd5e1';
      button.style.fontWeight = selected ? '700' : '500';
    }
  };
  for (const scale of PREVIEW_SCALE_OPTIONS) {
    const btn = el('button', {
      type: 'button',
      textContent: `${scale}x`,
      style: {
        padding: '4px 8px',
        borderRadius: '6px',
        border: '1px solid rgba(148,163,184,0.35)',
        background: 'transparent',
        color: '#cbd5e1',
        fontSize: '12px',
        cursor: 'pointer',
      },
    });
    btn.addEventListener('click', () => {
      state.previewScale = scale;
      updateScaleButtons();
      rerenderGrid();
      renderSidePanel(state.selected);
    });
    scaleButtons.set(scale, btn);
    scaleGroup.append(btn);
  }
  toolbar.append(scaleGroup);

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
  const controlsToggle = document.getElementById('controls-toggle');
  if (controlsToggle instanceof HTMLElement) {
    controlsToggle.style.display = 'none';
  }
  if (controlsToggle instanceof HTMLButtonElement) {
    controlsToggle.hidden = true;
  }

  const state = {
    showOverlay: true,
    previewScale: 1,
    runs: [] as SidecarRunListEntry[],
    details: new Map<string, Record<string, unknown>>(),
    grid: null as CreatedGallery | null,
    selected: null as CandidateRef | null,
    healthy: false,
    sidecarAutostartAttempted: false,
  };
  updateScaleButtons();

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
    const variantIndex = typeof cand.index === 'number' ? cand.index : ref.candidateIndex;
    const selectionSnapshot = state.selected
      ? {
          briefIndex: state.selected.briefIndex,
          candidateIndex: state.selected.candidateIndex,
        }
      : null;
    const header = el('div', { style: { marginBottom: '10px' } }, [
      el('div', { textContent: run.briefId, style: { fontWeight: '700', color: '#f1f5f9' } }),
      el('div', {
        textContent: `${run.runId} · candidate ${variantIndex}`,
        style: { fontSize: '11px', color: '#94a3b8' },
      }),
    ]);
    sidePanel.append(header);
    const padded = String(variantIndex).padStart(2, '0');
    const previewImg = el('img', {
      src: spriteUrl(run.briefId, run.runId, `${padded}.png`),
      alt: `${run.briefId} ${padded}`,
      style: {
        width: `${Math.max(16, Math.round(SPRITE_BASE_SIZE * state.previewScale))}px`,
        height: `${Math.max(16, Math.round(SPRITE_BASE_SIZE * state.previewScale))}px`,
        objectFit: 'contain',
        imageRendering: 'pixelated' as CSSStyleDeclaration['imageRendering'],
        background:
          'linear-gradient(45deg, #1e293b 25%, transparent 25%), linear-gradient(-45deg, #1e293b 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1e293b 75%), linear-gradient(-45deg, transparent 75%, #1e293b 75%)',
        backgroundSize: '12px 12px',
        backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0',
        backgroundColor: '#334155',
        border: '1px solid rgba(148,163,184,0.25)',
        borderRadius: '6px',
      },
    });
    const sizeLine = el('div', {
      textContent: 'Sprite size: loading…',
      style: { fontSize: '11px', color: '#cbd5e1', marginTop: '6px' },
    });
    previewImg.addEventListener('load', () => {
      const width = previewImg.naturalWidth;
      const height = previewImg.naturalHeight;
      sizeLine.textContent =
        width > 0 && height > 0 ? `Sprite size: ${width}x${height}px` : 'Sprite size: n/a';
    });
    previewImg.addEventListener('error', () => {
      sizeLine.textContent = 'Sprite size: n/a';
    });
    sidePanel.append(previewImg, sizeLine);

    const pipelineSection = el('div', {
      style: {
        margin: '10px 0 12px',
        padding: '8px',
        border: '1px solid rgba(148,163,184,0.2)',
        borderRadius: '6px',
        background: 'rgba(15,23,42,0.7)',
      },
    });
    pipelineSection.append(
      el('div', {
        textContent: 'Postprocess pipeline',
        style: { fontWeight: '600', fontSize: '12px', color: '#f1f5f9', marginBottom: '6px' },
      }),
    );
    const pipelineMeta = el('div', {
      textContent: 'Loading pipeline…',
      style: { fontSize: '11px', color: '#94a3b8', marginBottom: '6px' },
    });
    const pipelineButtons = el('div', {
      style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' },
    });
    const pipelineStepLabel = el('div', {
      textContent: 'Step: final',
      style: { fontSize: '11px', color: '#cbd5e1', marginBottom: '6px' },
    });
    const pipelineImg = el('img', {
      src: spriteUrl(run.briefId, run.runId, `${padded}.png`),
      alt: `${run.briefId} ${padded} pipeline`,
      style: {
        width: `${Math.max(16, Math.round(SPRITE_BASE_SIZE * state.previewScale))}px`,
        height: `${Math.max(16, Math.round(SPRITE_BASE_SIZE * state.previewScale))}px`,
        objectFit: 'contain',
        imageRendering: 'pixelated' as CSSStyleDeclaration['imageRendering'],
        background:
          'linear-gradient(45deg, #1e293b 25%, transparent 25%), linear-gradient(-45deg, #1e293b 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1e293b 75%), linear-gradient(-45deg, transparent 75%, #1e293b 75%)',
        backgroundSize: '12px 12px',
        backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0',
        backgroundColor: '#334155',
        border: '1px solid rgba(148,163,184,0.25)',
        borderRadius: '6px',
      },
    });
    pipelineSection.append(pipelineMeta, pipelineButtons, pipelineStepLabel, pipelineImg);
    sidePanel.append(pipelineSection);

    const setPipelineImage = (label: string, filename: string): void => {
      pipelineStepLabel.textContent = `Step: ${label}`;
      pipelineImg.src = spriteUrl(run.briefId, run.runId, filename);
    };
    const addPipelineButton = (label: string, filename: string): void => {
      const button = el('button', {
        textContent: label,
        style: {
          fontSize: '10px',
          color: '#e2e8f0',
          background: '#1e293b',
          border: '1px solid #475569',
          borderRadius: '4px',
          padding: '2px 6px',
          cursor: 'pointer',
        },
      });
      button.addEventListener('click', () => setPipelineImage(label, filename));
      pipelineButtons.append(button);
    };
    addPipelineButton('final', `${padded}.png`);
    fetchJson<PipelineManifest>(spriteUrl(run.briefId, run.runId, `${padded}.pipeline.json`))
      .then((manifest) => {
        if (!selectionSnapshot || !state.selected) return;
        if (
          state.selected.briefIndex !== selectionSnapshot.briefIndex ||
          state.selected.candidateIndex !== selectionSnapshot.candidateIndex
        ) {
          return;
        }
        const profile =
          typeof manifest.profile === 'string' && manifest.profile.length > 0
            ? manifest.profile
            : null;
        const steps = Array.isArray(manifest.steps) ? manifest.steps : [];
        pipelineMeta.textContent = profile ? `Profile: ${profile}` : 'Profile: n/a';
        for (const step of steps) {
          if (typeof step.file !== 'string' || step.file.length === 0) continue;
          const label =
            typeof step.label === 'string' && step.label.length > 0
              ? step.label
              : typeof step.id === 'string' && step.id.length > 0
                ? step.id
                : step.file;
          addPipelineButton(label, step.file);
        }
      })
      .catch(() => {
        if (!selectionSnapshot || !state.selected) return;
        if (
          state.selected.briefIndex !== selectionSnapshot.briefIndex ||
          state.selected.candidateIndex !== selectionSnapshot.candidateIndex
        ) {
          return;
        }
        pipelineMeta.textContent = 'No pipeline trace available for this run.';
      });

    const slicingSection = el('div', {
      style: {
        margin: '10px 0 12px',
        padding: '8px',
        border: '1px solid rgba(148,163,184,0.2)',
        borderRadius: '6px',
        background: 'rgba(15,23,42,0.7)',
      },
    });
    slicingSection.append(
      el('div', {
        textContent: 'Sheet slicing',
        style: { fontWeight: '600', fontSize: '12px', color: '#f1f5f9', marginBottom: '6px' },
      }),
    );
    const slicingMeta = el('div', {
      textContent: 'Loading sheet…',
      style: { fontSize: '11px', color: '#94a3b8', marginBottom: '6px' },
    });
    const slicingButtons = el('div', {
      style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' },
    });
    const sheetWrap = el('div', {
      style: {
        position: 'relative',
        display: 'inline-block',
        background:
          'linear-gradient(45deg, #1e293b 25%, transparent 25%), linear-gradient(-45deg, #1e293b 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1e293b 75%), linear-gradient(-45deg, transparent 75%, #1e293b 75%)',
        backgroundSize: '12px 12px',
        backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0',
        backgroundColor: '#334155',
        border: '1px solid rgba(148,163,184,0.25)',
        borderRadius: '6px',
        overflow: 'hidden',
      },
    });
    const sheetImg = el('img', {
      alt: `${run.briefId} source sheet`,
      style: {
        width: '256px',
        height: '256px',
        objectFit: 'contain',
        imageRendering: 'pixelated' as CSSStyleDeclaration['imageRendering'],
        display: 'block',
      },
    });
    const cellMarker = el('div', {
      style: {
        position: 'absolute',
        border: '2px solid #93c5fd',
        boxShadow: '0 0 0 1px rgba(15,23,42,0.95) inset',
        pointerEvents: 'none',
        display: 'none',
      },
    });
    sheetWrap.append(sheetImg, cellMarker);
    const slicingInfo = el('div', {
      textContent: 'Selected slice: loading…',
      style: { fontSize: '11px', color: '#cbd5e1', marginTop: '6px' },
    });
    slicingSection.append(slicingMeta, slicingButtons, sheetWrap, slicingInfo);
    sidePanel.append(slicingSection);

    const updateSliceMarker = (): void => {
      const sheetW = sheetImg.naturalWidth;
      const sheetH = sheetImg.naturalHeight;
      const spriteW = previewImg.naturalWidth;
      const spriteH = previewImg.naturalHeight;
      if (sheetW <= 0 || sheetH <= 0 || spriteW <= 0 || spriteH <= 0) {
        cellMarker.style.display = 'none';
        slicingInfo.textContent = 'Selected slice: unavailable';
        return;
      }
      const cols = Math.max(1, Math.floor(sheetW / spriteW));
      const rows = Math.max(1, Math.floor(sheetH / spriteH));
      const total = Math.max(1, cols * rows);
      const idx = Math.max(0, Math.min(total - 1, variantIndex));
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const scaleX = sheetImg.clientWidth / sheetW;
      const scaleY = sheetImg.clientHeight / sheetH;
      cellMarker.style.left = `${Math.round(col * spriteW * scaleX)}px`;
      cellMarker.style.top = `${Math.round(row * spriteH * scaleY)}px`;
      cellMarker.style.width = `${Math.max(1, Math.round(spriteW * scaleX))}px`;
      cellMarker.style.height = `${Math.max(1, Math.round(spriteH * scaleY))}px`;
      cellMarker.style.display = 'block';
      slicingInfo.textContent = `Selected slice: #${idx} (row ${row + 1}, col ${col + 1}) on ${cols}x${rows} grid`;
    };
    sheetImg.addEventListener('load', updateSliceMarker);
    previewImg.addEventListener('load', updateSliceMarker);
    let activeSheetRunId = run.runId;
    const setSheetImage = (filename: string, sheetRunId = activeSheetRunId): void => {
      activeSheetRunId = sheetRunId;
      sheetImg.src = sheetUrl(run.briefId, sheetRunId, filename);
      slicingMeta.textContent =
        sheetRunId === run.runId ? `Sheet: ${filename}` : `Sheet: ${filename} (from ${sheetRunId})`;
    };
    const addSheetButton = (filename: string, sheetRunId = activeSheetRunId): void => {
      const button = el('button', {
        textContent: filename.replace(/^sheet-/, 'attempt ').replace(/\.png$/i, ''),
        style: {
          fontSize: '10px',
          color: '#e2e8f0',
          background: '#1e293b',
          border: '1px solid #475569',
          borderRadius: '4px',
          padding: '2px 6px',
          cursor: 'pointer',
        },
      });
      button.addEventListener('click', () => setSheetImage(filename, sheetRunId));
      slicingButtons.append(button);
    };
    const normalizeSheetFiles = (response: SidecarSheetsResponse): string[] =>
      Array.isArray(response.files)
        ? response.files.filter(
            (file): file is string => typeof file === 'string' && /^sheet-\d+\.png$/i.test(file),
          )
        : [];
    const isSelectionCurrent = (): boolean => {
      if (!selectionSnapshot || !state.selected) return false;
      return (
        state.selected.briefIndex === selectionSnapshot.briefIndex &&
        state.selected.candidateIndex === selectionSnapshot.candidateIndex
      );
    };
    const setNoSheets = (): void => {
      slicingMeta.textContent = 'No source sheets found for this run.';
      cellMarker.style.display = 'none';
      slicingInfo.textContent = 'Selected slice: unavailable';
    };
    void (async () => {
      try {
        const primary = normalizeSheetFiles(
          await fetchJson<SidecarSheetsResponse>(sheetsUrl(run.briefId, run.runId)),
        );
        if (!isSelectionCurrent()) return;
        if (primary.length > 0) {
          activeSheetRunId = run.runId;
          for (const file of primary) addSheetButton(file, run.runId);
          setSheetImage(primary[primary.length - 1]!, run.runId);
          return;
        }
        let sourceRunId: string | null = null;
        try {
          const manifest = await fetchJson<{
            sourceRunId?: unknown;
          }>(spriteUrl(run.briefId, run.runId, `${padded}.pipeline.json`));
          if (typeof manifest.sourceRunId === 'string' && manifest.sourceRunId.length > 0) {
            sourceRunId = manifest.sourceRunId;
          }
        } catch {
          sourceRunId = null;
        }
        if (!sourceRunId) {
          setNoSheets();
          return;
        }
        const fallback = normalizeSheetFiles(
          await fetchJson<SidecarSheetsResponse>(sheetsUrl(run.briefId, sourceRunId)),
        );
        if (!isSelectionCurrent()) return;
        if (fallback.length === 0) {
          setNoSheets();
          return;
        }
        activeSheetRunId = sourceRunId;
        for (const file of fallback) addSheetButton(file, sourceRunId);
        setSheetImage(fallback[fallback.length - 1]!, sourceRunId);
      } catch {
        if (!selectionSnapshot || !state.selected) return;
        if (
          state.selected.briefIndex !== selectionSnapshot.briefIndex ||
          state.selected.candidateIndex !== selectionSnapshot.candidateIndex
        ) {
          return;
        }
        slicingMeta.textContent = 'Could not load source sheets for this run.';
        cellMarker.style.display = 'none';
        slicingInfo.textContent = 'Selected slice: unavailable';
      }
    })();

    sidePanel.append(
      el('div', {
        textContent:
          'Approval moved to DevTools asset-plan workflow. Use devtools.html to approve winners and run metadata.',
        style: { fontSize: '11px', color: '#93c5fd', margin: '10px 0' },
      }),
    );
    const failedSensors = extractSensorFailures(cand);
    const sensorPassed = cand.passed === true;
    const sensorSection = el('div', {
      style: {
        margin: '10px 0 12px',
        padding: '8px',
        border: '1px solid rgba(148,163,184,0.2)',
        borderRadius: '6px',
        background: 'rgba(15,23,42,0.7)',
      },
    });
    sensorSection.append(
      el('div', {
        textContent: 'Sensor failures',
        style: { fontWeight: '600', fontSize: '12px', color: '#f1f5f9', marginBottom: '6px' },
      }),
    );
    if (failedSensors.length === 0) {
      sensorSection.append(
        el('div', {
          textContent: sensorPassed
            ? 'None — all sensors passed.'
            : 'Sensor failed, but no per-sensor reasons were recorded for this run.',
          style: { fontSize: '11px', color: sensorPassed ? '#86efac' : '#fecaca' },
        }),
      );
    } else {
      for (const failure of failedSensors) {
        sensorSection.append(
          el('div', {
            textContent: `${failure.sensor}: ${failure.reason}`,
            style: { fontSize: '11px', color: '#fecaca', marginBottom: '4px' },
          }),
        );
      }
    }
    sidePanel.append(sensorSection);

    sidePanel.append(renderJsonTree(cand, 'candidate'));

    // Fetch and display brief YAML + prompt below the scorecard.
    const briefSection = el('div', {
      style: { marginTop: '14px' },
    });
    briefSection.append(
      el('div', {
        textContent: 'Loading brief…',
        style: { fontSize: '11px', color: '#64748b' },
      }),
    );
    sidePanel.append(briefSection);

    fetchJson<{ briefYaml: string | null; promptText: string | null }>(
      `${SIDECAR_BASE}/api/runs/${encodeURIComponent(run.briefId)}/${encodeURIComponent(run.runId)}/brief`,
    )
      .then((data) => {
        // Guard against stale fetch if user changed selection.
        if (!selectionSnapshot || !state.selected) return;
        if (
          state.selected.briefIndex !== selectionSnapshot.briefIndex ||
          state.selected.candidateIndex !== selectionSnapshot.candidateIndex
        ) {
          return;
        }

        briefSection.replaceChildren();
        if (data.briefYaml) {
          briefSection.append(
            el('div', {
              textContent: 'Brief YAML',
              style: { fontWeight: '600', fontSize: '12px', color: '#e2e8f0', marginBottom: '4px' },
            }),
            el('pre', {
              textContent: data.briefYaml,
              style: {
                fontSize: '10px',
                lineHeight: '1.4',
                background: 'rgba(15,23,42,0.8)',
                border: '1px solid rgba(148,163,184,0.2)',
                borderRadius: '4px',
                padding: '8px',
                overflow: 'auto',
                maxHeight: '200px',
                color: '#cbd5e1',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              },
            }),
          );
        }
        if (data.promptText) {
          briefSection.append(
            el('div', {
              textContent: 'Assembled Prompt',
              style: {
                fontWeight: '600',
                fontSize: '12px',
                color: '#e2e8f0',
                marginTop: '10px',
                marginBottom: '4px',
              },
            }),
            el('pre', {
              textContent: data.promptText,
              style: {
                fontSize: '10px',
                lineHeight: '1.4',
                background: 'rgba(15,23,42,0.8)',
                border: '1px solid rgba(148,163,184,0.2)',
                borderRadius: '4px',
                padding: '8px',
                overflow: 'auto',
                maxHeight: '300px',
                color: '#cbd5e1',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              },
            }),
          );
        }
        if (!data.briefYaml && !data.promptText) {
          briefSection.append(
            el('div', {
              textContent: 'Brief file not found or prompt not stored in this run.',
              style: { fontSize: '11px', color: '#64748b' },
            }),
          );
        }
      })
      .catch(() => {
        briefSection.replaceChildren(
          el('div', {
            textContent: 'Could not load brief (sidecar route unavailable).',
            style: { fontSize: '11px', color: '#64748b' },
          }),
        );
      });
  }

  function selectCandidate(ref: CandidateRef): void {
    state.selected = ref;
    renderSidePanel(ref);
    state.grid?.focus(ref);
  }

  async function dismissRun(briefId: string, runId: string): Promise<void> {
    if (!confirm(`Delete run ${briefId}/${runId}? This cannot be undone.`)) return;
    try {
      const res = await fetch(
        `${SIDECAR_BASE}/api/runs/${encodeURIComponent(briefId)}/${encodeURIComponent(runId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Remove from local state and re-render.
      state.runs = state.runs.filter((r) => !(r.briefId === briefId && r.runId === runId));
      state.details.delete(`${briefId}/${runId}`);
      state.selected = null;
      sidePanel.replaceChildren();
      rerenderGrid();
    } catch (err) {
      alert(`Failed to dismiss: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function rerenderGrid(): void {
    state.grid = createGalleryGrid(gridHost, state.runs, state.details, {
      showOverlay: state.showOverlay,
      previewScale: state.previewScale,
      onSelect: selectCandidate,
      onDismiss: dismissRun,
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
      state.healthy = true;
    } catch (err) {
      if (!state.sidecarAutostartAttempted) {
        state.sidecarAutostartAttempted = true;
        gridHost.replaceChildren(
          el('div', {
            textContent: 'Starting sprite sidecar + lab stack…',
            style: { color: '#94a3b8', padding: '24px' },
          }),
        );
        try {
          await requestGalleryStart();
          for (let i = 0; i < 20; i++) {
            await delay(500);
            try {
              health = await fetchJson<SidecarHealth>(`${SIDECAR_BASE}/api/health`);
              state.healthy = true;
              return await load();
            } catch {
              // Keep polling until timeout.
            }
          }
        } catch {
          // Fall through to the existing fallback banner.
        }
      }
      state.healthy = false;
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
      // Constrain horizontal nav to the current brief so ←/→ never jumps
      // to a sibling brief — the documented contract is "candidates within
      // the focused brief". Vertical nav (↓/↑) handles brief switching.
      const withinBrief = state.grid.candidates.filter((c) => c.briefIndex === cur.briefIndex);
      const localIndex = withinBrief.findIndex((c) => c.candidateIndex === cur.candidateIndex);
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const target = Math.max(0, Math.min(withinBrief.length - 1, localIndex + delta));
      next = withinBrief[target] ?? null;
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
    if (controlsToggle instanceof HTMLElement) {
      controlsToggle.style.display = '';
    }
    if (controlsToggle instanceof HTMLButtonElement) {
      controlsToggle.hidden = false;
    }
    controls.style.display = '';
    canvasHost.replaceChildren();
  };
}

registerLab('sprite-gallery', {
  name: 'Sprite Generation Pipeline Review',
  description:
    'Review and approve sprite-pipeline candidates. Renders thumbnails, anchor overlays, sensor + judge badges. Requires the sprites sidecar (`npm run sprites:gallery`).',
  category: 'Meta',
  create: createGalleryLab,
});
