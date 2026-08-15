// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunSurveyUI } from '../../src/engine/RunSurveyUI.js';

describe('RunSurveyUI', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders as a labelled, modal dialog and focuses the first control on show', () => {
    const ui = createRunSurveyUI({ onSubmit: () => true });
    ui.show();

    const panel = document.body.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('aria-modal')).toBe('true');
    expect(panel?.getAttribute('aria-labelledby')).toBeTruthy();

    const firstSlider = document.body.querySelector<HTMLInputElement>(
      'input[data-field="enjoyment"]',
    );
    expect(document.activeElement).toBe(firstSlider);

    ui.destroy();
  });

  it('updates the displayed score output when a slider is moved', () => {
    const ui = createRunSurveyUI({ onSubmit: () => true });
    ui.show();

    const slider = document.body.querySelector<HTMLInputElement>('input[data-field="tension"]')!;
    const output = document.body.querySelector<HTMLOutputElement>('output[data-field="tension"]')!;
    expect(output.textContent).toBe('3');

    slider.value = '5';
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    expect(output.textContent).toBe('5');

    ui.destroy();
  });

  it('shows a disclosure that submitting files a public GitHub issue', () => {
    const ui = createRunSurveyUI({ onSubmit: () => true });
    ui.show();

    expect(document.body.textContent).toContain('creates a public GitHub issue');

    ui.destroy();
  });

  it('submits the slider values and comment, then hides on success', async () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const ui = createRunSurveyUI({ onSubmit });
    ui.show();

    const enjoymentSlider = document.body.querySelector<HTMLInputElement>(
      'input[data-field="enjoyment"]',
    )!;
    enjoymentSlider.value = '5';
    enjoymentSlider.dispatchEvent(new Event('input', { bubbles: true }));

    const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = 'Great run';

    const submitBtn = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Submit feedback',
    )!;
    submitBtn.click();

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ enjoyment: 5, comment: 'Great run' }),
    );

    await vi.waitFor(() => expect(ui.isVisible()).toBe(false));

    ui.destroy();
  });

  it('keeps the dialog open and shows a retryable error when submission fails', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    const ui = createRunSurveyUI({ onSubmit });
    ui.show();

    const submitBtn = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Submit feedback',
    )!;
    submitBtn.click();

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(ui.isVisible()).toBe(true);
    expect(document.body.textContent).toContain('Submission failed');

    ui.destroy();
  });

  it('invokes onSkip and hides without submitting', () => {
    const onSubmit = vi.fn();
    const onSkip = vi.fn();
    const ui = createRunSurveyUI({ onSubmit, onSkip });
    ui.show();

    const skipBtn = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Skip',
    )!;
    skipBtn.click();

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(ui.isVisible()).toBe(false);

    ui.destroy();
  });

  it('removes the dialog from the DOM on destroy', () => {
    const ui = createRunSurveyUI({ onSubmit: () => true });
    ui.show();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    ui.destroy();

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
