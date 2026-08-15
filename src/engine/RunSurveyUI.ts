import type { PlaytestSurvey } from '../shared/playtest-survey.js';

const QUESTION_FIELDS = [
  { key: 'enjoyment', label: 'Enjoyment' },
  { key: 'immersion', label: 'Immersion' },
  { key: 'mastery', label: 'Mastery' },
  { key: 'control', label: 'Control' },
  { key: 'tension', label: 'Tension' },
] as const;

export type RunSurveyLike = PlaytestSurvey;

export interface RunSurveyUIHooks {
  readonly onSubmit: (survey: RunSurveyLike) => void;
  readonly onSkip?: () => void;
}

export function createRunSurveyUI(hooks: RunSurveyUIHooks): {
  isVisible(): boolean;
  show(): void;
  hide(): void;
  destroy(): void;
} {
  let element: HTMLDivElement | null = null;
  let visible = false;

  const setValue = (field: keyof PlaytestSurvey, value: number): void => {
    if (!element) {
      return;
    }
    const slider = element.querySelector<HTMLInputElement>(`input[data-field="${field}"]`);
    const label = element.querySelector<HTMLElement>(`output[data-field="${field}"]`);
    if (slider) {
      slider.value = String(value);
    }
    if (label) {
      label.textContent = String(value);
    }
  };

  const createElement = (): HTMLDivElement => {
    const dialog = document.createElement('div');
    dialog.style.position = 'fixed';
    dialog.style.inset = '0';
    dialog.style.display = 'flex';
    dialog.style.alignItems = 'center';
    dialog.style.justifyContent = 'center';
    dialog.style.background = 'rgba(2, 6, 23, 0.72)';
    dialog.style.zIndex = '5000';
    dialog.style.fontFamily = 'Segoe UI, Arial, sans-serif';
    dialog.style.pointerEvents = 'auto';

    const panel = document.createElement('div');
    panel.style.width = 'min(680px, calc(100vw - 32px))';
    panel.style.background = '#0f172a';
    panel.style.border = '1px solid #334155';
    panel.style.borderRadius = '12px';
    panel.style.padding = '18px 18px 14px';
    panel.style.boxShadow = '0 24px 80px rgba(15, 23, 42, 0.8)';
    panel.style.color = '#e2e8f0';

    const title = document.createElement('h3');
    title.textContent = 'Run feedback';
    title.style.margin = '0 0 6px';
    title.style.color = '#f8fafc';
    title.style.fontSize = '28px';

    const subtitle = document.createElement('p');
    subtitle.textContent = 'Tell us how the run felt and what stood out.';
    subtitle.style.margin = '0 0 16px';
    subtitle.style.color = '#cbd5e1';

    const rows = document.createElement('div');
    rows.style.display = 'grid';
    rows.style.gap = '10px';

    for (const question of QUESTION_FIELDS) {
      const row = document.createElement('div');
      row.style.display = 'grid';
      row.style.gridTemplateColumns = '170px 1fr 38px';
      row.style.alignItems = 'center';
      row.style.gap = '12px';
      row.style.padding = '6px 8px';
      row.style.border = '1px solid rgba(148, 163, 184, 0.18)';
      row.style.borderRadius = '8px';

      const label = document.createElement('label');
      label.textContent = `${question.label}:`;
      label.style.color = '#e2e8f0';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '1';
      slider.max = '5';
      slider.step = '1';
      slider.value = '3';
      slider.setAttribute('data-field', question.key);
      slider.style.width = '100%';
      slider.style.accentColor = '#fbbf24';

      const value = document.createElement('output');
      value.setAttribute('data-field', question.key);
      value.textContent = slider.value;
      value.style.color = '#f8fafc';
      value.style.fontWeight = '700';
      value.style.textAlign = 'right';

      row.append(label, slider, value);
      rows.appendChild(row);
    }

    const textareaWrap = document.createElement('div');
    textareaWrap.style.marginTop = '18px';

    const areaLabel = document.createElement('label');
    areaLabel.textContent = 'Comment';
    areaLabel.style.display = 'block';
    areaLabel.style.marginBottom = '6px';
    areaLabel.style.color = '#cbd5e1';

    const textarea = document.createElement('textarea');
    textarea.rows = 4;
    textarea.placeholder = 'What made this run feel great, frustrating, or memorable?';
    textarea.style.width = '100%';
    textarea.style.boxSizing = 'border-box';
    textarea.style.resize = 'vertical';
    textarea.style.padding = '10px 12px';
    textarea.style.borderRadius = '8px';
    textarea.style.border = '1px solid #475569';
    textarea.style.background = '#020817';
    textarea.style.color = '#f8fafc';

    textareaWrap.append(areaLabel, textarea);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '10px';
    actions.style.marginTop = '18px';

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.textContent = 'Skip';
    skipBtn.style.background = 'transparent';
    skipBtn.style.color = '#cbd5e1';
    skipBtn.style.border = '1px solid #475569';
    skipBtn.style.borderRadius = '8px';
    skipBtn.style.padding = '10px 16px';
    skipBtn.addEventListener('click', () => {
      hide();
      hooks.onSkip?.();
    });

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.textContent = 'Submit feedback';
    submitBtn.style.background = '#1d4ed8';
    submitBtn.style.color = '#f8fafc';
    submitBtn.style.border = 'none';
    submitBtn.style.borderRadius = '8px';
    submitBtn.style.padding = '10px 18px';
    submitBtn.style.cursor = 'pointer';
    submitBtn.addEventListener('click', () => {
      const payload: Record<string, unknown> = {};
      for (const question of QUESTION_FIELDS) {
        const slider = dialog.querySelector<HTMLInputElement>(
          `input[data-field="${question.key}"]`,
        );
        const numeric = slider ? Number.parseInt(slider.value, 10) : 3;
        payload[question.key] = numeric;
      }
      const comment = textarea.value.trim();
      if (comment.length > 0) {
        payload.comment = comment;
      }
      hide();
      hooks.onSubmit(payload as PlaytestSurvey);
    });

    actions.append(skipBtn, submitBtn);
    panel.append(title, subtitle, rows, textareaWrap, actions);
    dialog.appendChild(panel);
    return dialog;
  };

  const show = (): void => {
    if (typeof document === 'undefined') {
      return;
    }
    if (!element) {
      element = createElement();
      document.body.appendChild(element);
    }
    for (const key of QUESTION_FIELDS) {
      setValue(key.key, 3);
    }
    visible = true;
    element.style.display = 'flex';
  };

  const hide = (): void => {
    if (!element) {
      return;
    }
    element.style.display = 'none';
    visible = false;
  };

  const destroy = (): void => {
    if (element && element.parentNode) {
      element.parentNode.removeChild(element);
    }
    element = null;
    visible = false;
  };

  return {
    isVisible: () => visible,
    show,
    hide,
    destroy,
  };
}
