import { test as base } from '@playwright/test';

import { domExcerpts } from './failure-dom';

export * from '@playwright/test';

export const test = base.extend<{ failureDom: undefined }>({
  failureDom: [
    async ({ browser, context }, provide, testInfo) => {
      await provide(undefined);
      if (testInfo.status === testInfo.expectedStatus) return;
      const message = testInfo.errors
        .map((error) => `${error.message ?? ''}\n${error.stack ?? ''}`)
        .join('\n');
      const pages = [context, ...browser.contexts().filter((other) => other !== context)].flatMap(
        (each) => each.pages(),
      );
      const lines = await domExcerpts(pages, message).catch(() => []);
      if (lines.length > 0)
        await testInfo.attach('dom-excerpt', { body: lines.join('\n'), contentType: 'text/plain' });
    },
    { auto: true },
  ],
});
