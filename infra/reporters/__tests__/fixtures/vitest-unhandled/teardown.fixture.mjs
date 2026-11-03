import { describe, expect, it } from 'vitest';

describe('a page', () => {
  it('leaves a timer behind', async () => {
    const error = new ReferenceError('window is not defined');
    error.stack = 'ReferenceError: window is not defined\n    at flush (/repo/node_modules/react-dom/cjs/react-dom.development.js:10:5)\n    at Timeout._onTimeout (/repo/node_modules/scheduler/index.js:3:1)';
    setTimeout(() => {
      throw error;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(true).toBe(true);
  });
});
