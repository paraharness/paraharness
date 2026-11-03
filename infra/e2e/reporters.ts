import type { ReporterDescription } from '@playwright/test';

type Env = Record<string, string | undefined>;

export function liveReporters(env: Env): ReporterDescription[] {
  const report = env['LIVE_REPORT']?.trim();
  return report ? [['list'], ['json', { outputFile: report }]] : [['list']];
}
