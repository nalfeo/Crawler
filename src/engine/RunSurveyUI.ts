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
  /**
   * Submit handler. Must resolve to `true` only once the survey has actually
   * been delivered — the dialog stays open and shows a retryable error state
   * whenever this resolves `false` (network/HTTP failure), so player feedback
   * is never silently discarded.
   */
  readonly onSubmit: (survey: RunSurveyLike) => Promise<boolean> | boolean;
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
  let lastFocused: HTMLElement | null = null;
  let submitBtnRef: HTMLButtonElement | null = null;
  let skipBtnRef: HTMLButtonElement | null = null;
  let errorTextRef: HTMLParagraphElement | null = null;
  let firstSliderRef: HTMLInputElement | null = null;

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

  const getFocusableElements = (): HTMLElement[] => {
    if (!element) {
      return [];
    }
    return Array.from(
      element.querySelectorAll<HTMLElement>(
        'input, textarea, button, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled'));
  };

  const trapFocus = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = getFocusableElements();
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey) {
      if (active === first || !element?.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !element?.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  const setSubmitting = (submitting: boolean): void => {
    if (submitBtnRef) {
      submitBtnRef.disabled = submitting;
      submitBtnRef.textContent = submitting ? 'Submitting…' : 'Submit feedback';
    }
    if (skipBtnRef) {
      skipBtnRef.disabled = submitting;
    }
  };

  const setError = (message: string | null): void => {
    if (!errorTextRef) {
      return;
    }
    errorTextRef.textContent = message ?? '';
    errorTextRef.style.display = message ? 'block' : 'none';
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
    dialog.addEventListener('keydown', trapFocus);

    const panel = document.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.style.width = 'min(680px, calc(100vw - 32px))';
    panel.style.background = '#0f172a';
    panel.style.border = '1px solid #334155';
    panel.style.borderRadius = '12px';
    panel.style.padding = '18px 18px 14px';
    panel.style.boxShadow = '0 24px 80px rgba(15, 23, 42, 0.8)';
    panel.style.color = '#e2e8f0';

    const titleId = 'crawler-run-survey-title';
    const title = document.createElement('h3');
    title.id = titleId;
    title.textContent = 'Run feedback';
    title.style.margin = '0 0 6px';
    title.style.color = '#f8fafc';
    title.style.fontSize = '28px';
    panel.setAttribute('aria-labelledby', titleId);

    const subtitle = document.createElement('p');
    subtitle.textContent = 'Tell us how the run felt and what stood out.';
    subtitle.style.margin = '0 0 16px';
    subtitle.style.color = '#cbd5e1';

    const rows = document.createElement('div');
    rows.style.display = 'grid';
    rows.style.gap = '10px';

    QUESTION_FIELDS.forEach((question, index) => {
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
      slider.setAttribute('aria-label', question.label);
      slider.style.width = '100%';
      slider.style.accentColor = '#fbbf24';

      const value = document.createElement('output');
      value.setAttribute('data-field', question.key);
      value.textContent = slider.value;
      value.style.color = '#f8fafc';
      value.style.fontWeight = '700';
      value.style.textAlign = 'right';

      slider.addEventListener('input', () => {
        value.textContent = slider.value;
      });

      if (index === 0) {
        firstSliderRef = slider;
      }

      row.append(label, slider, value);
      rows.appendChild(row);
    });

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

    const disclosure = document.createElement('p');
    disclosure.textContent =
      'Submitting creates a public GitHub issue containing your answers, comment, and a temporary link to this run.';
    disclosure.style.margin = '14px 0 0';
    disclosure.style.color = '#94a3b8';
    disclosure.style.fontSize = '12px';

    const errorText = document.createElement('p');
    errorText.textContent = '';
    errorText.style.display = 'none';
    errorText.style.margin = '10px 0 0';
    errorText.style.color = '#fca5a5';
    errorText.style.fontSize = '13px';
    errorText.setAttribute('role', 'alert');
    errorTextRef = errorText;

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
    skipBtnRef = skipBtn;

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
      setError(null);
      setSubmitting(true);
      void Promise.resolve(hooks.onSubmit(payload as unknown as PlaytestSurvey))
        .then((ok) => {
          setSubmitting(false);
          if (ok) {
            hide();
          } else {
            setError('Submission failed. Please try again.');
          }
        })
        .catch(() => {
          setSubmitting(false);
          setError('Submission failed. Please try again.');
        });
    });
    submitBtnRef = submitBtn;

    actions.append(skipBtn, submitBtn);
    panel.append(title, subtitle, rows, textareaWrap, disclosure, errorText, actions);
    dialog.appendChild(panel);
    return dialog;
  };

  const show = (): void => {
    if (typeof document === 'undefined') {
      return;
    }
    lastFocused = (document.activeElement as HTMLElement | null) ?? null;
    if (!element) {
      element = createElement();
      document.body.appendChild(element);
    }
    for (const key of QUESTION_FIELDS) {
      setValue(key.key, 3);
    }
    setError(null);
    setSubmitting(false);
    visible = true;
    element.style.display = 'flex';
    firstSliderRef?.focus();
  };

  const hide = (): void => {
    if (!element) {
      return;
    }
    element.style.display = 'none';
    visible = false;
    lastFocused?.focus();
    lastFocused = null;
  };

  const destroy = (): void => {
    if (element && element.parentNode) {
      element.removeEventListener('keydown', trapFocus);
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
