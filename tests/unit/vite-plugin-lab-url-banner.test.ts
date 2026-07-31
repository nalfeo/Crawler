import { describe, expect, it } from 'vitest';
import { formatLabUrl } from '../../tools/vite-plugin-lab-url-banner';

describe('formatLabUrl', () => {
  it('always includes the lab.html entry point', () => {
    // Regression: the bare origin serves index.html (the game), not the lab shell.
    expect(formatLabUrl(15281, 'ai-runner')).toBe('http://localhost:15281/lab.html?lab=ai-runner');
  });

  it('omits the query string when no lab id is given', () => {
    expect(formatLabUrl(15281)).toBe('http://localhost:15281/lab.html');
  });
});
