import { describe, expect, it } from 'vitest';

import { vitestReporters } from '../vitest-reporters.mjs';

describe('vitestReporters', () => {
  it('adds the github-actions reporter, which annotates each failed test, only on GitHub Actions, beside the compact one or the default under VERBOSE=1', () => {
    expect(vitestReporters({})).toEqual([expect.stringMatching(/compact-vitest\.mjs$/)]);
    expect(vitestReporters({ GITHUB_ACTIONS: 'true' })).toEqual([expect.stringMatching(/compact-vitest\.mjs$/), 'github-actions']);
    expect(vitestReporters({ VERBOSE: '1', GITHUB_ACTIONS: 'true' })).toEqual(['default', 'github-actions']);
  });
});
