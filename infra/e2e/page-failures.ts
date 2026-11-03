import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';

import { watchConsole, type ConsoleWatch } from '../verify/interaction-checks.mjs';

const FAILED_STATUS = 400;
const LOAD_FAILURE = /^Failed to load resource: the server responded with a status of \d{3}\b/;

interface Failure {
  status: number;
  url: RegExp;
}

interface FailedResponse {
  status: number;
  method: string;
  url: string;
}

export interface PageFailures {
  expect: (url: RegExp, status: number) => void;
  watch: (context: BrowserContext) => void;
}

export function journeyConsole(page: Page): ConsoleWatch {
  const watch = watchConsole(page);
  return { take: () => watch.take().filter((entry) => !LOAD_FAILURE.test(entry.detail)) };
}

const declares = (failed: FailedResponse) => (expected: Failure) =>
  expected.status === failed.status && expected.url.test(failed.url);

export const test = base.extend<{ pageFailures: PageFailures }>({
  pageFailures: [
    async ({ context }, provide) => {
      const expected: Failure[] = [];
      const failed: FailedResponse[] = [];
      const watch = (each: BrowserContext) => {
        each.on('response', (response) => {
          if (response.status() < FAILED_STATUS) return;
          failed.push({ status: response.status(), method: response.request().method(), url: response.url() });
        });
      };
      watch(context);
      await provide({ expect: (url, status) => expected.push({ url, status }), watch });
      const undeclared = failed.filter((response) => !expected.some(declares(response)));
      expect(
        undeclared.map(({ status, method, url }) => `${String(status)} ${method} ${url}`),
        'responses of status 400 or more the journey did not expect with pageFailures.expect',
      ).toEqual([]);
    },
    { auto: true },
  ],
});
