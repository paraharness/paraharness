import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_LINES, countsLine, duration, failureBlock, firstAppFrame, messageLines, stripAnsi } from './compact-lib.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TRAIL_CATEGORIES = new Set(['test.step', 'pw:api', 'expect']);
const TRAIL_LENGTH = 5;

function flatten(steps, out = []) {
  for (const step of steps) {
    if (TRAIL_CATEGORIES.has(step.category)) out.push(step);
    if (step.category !== 'expect' && step.category !== 'pw:api') flatten(step.steps ?? [], out);
  }
  return out;
}

export function stepTrail(steps) {
  const flat = flatten(steps);
  if (flat.length === 0) return null;
  const failed = flat.findIndex((step) => step.error !== undefined);
  const end = failed === -1 ? flat.length : failed + 1;
  const shown = flat.slice(Math.max(0, end - TRAIL_LENGTH), end);
  return shown
    .map((step) => `${step.error === undefined ? '' : '✗ '}${step.title.replace(/\s+/g, ' ').slice(0, 70)}`)
    .join(' → ');
}

export default class CompactPlaywrightReporter {
  constructor(options = {}) {
    this.name = options.name ?? 'playwright';
    this.root = options.root ?? REPO_ROOT;
    this.failuresFile = options.failuresFile;
  }

  printsToStdio() {
    return true;
  }

  onBegin(config, suite) {
    this.config = config;
    this.suite = suite;
    this.started = Date.now();
    this.errors = [];
    this.failuresFile ??= join(config.projects[0]?.outputDir ?? join(config.rootDir, 'test-results'), 'failures.txt');
  }

  onError(error) {
    this.errors.push(error);
  }

  describe(_test, result) {
    const lines = [];
    for (const error of result.errors) lines.push(...messageLines(error.message ?? error.value ?? ''));
    return [...lines, ...this.evidence(result)];
  }

  evidence(result) {
    const lines = [];
    const trail = stepTrail(result.steps ?? []);
    if (trail !== null) lines.push(`steps: ${trail}`);
    for (const attachment of result.attachments ?? []) {
      if (attachment.name !== 'dom-excerpt' || attachment.body === undefined) continue;
      for (const line of attachment.body.toString('utf8').split('\n')) lines.push(`dom: ${line}`);
    }
    return lines;
  }

  where(test, result) {
    for (const error of result.errors) {
      const frame = firstAppFrame(error.stack ?? '', this.root);
      if (frame !== null) return frame;
    }
    return `${relative(this.root, test.location.file)}:${String(test.location.line)}`;
  }

  title(test) {
    return test.titlePath().slice(3).join(' › ') || test.title;
  }

  summaryExtras() {
    return [];
  }

  async onEnd(result) {
    const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
    const failures = [];
    const full = [];
    for (const test of this.suite.allTests()) {
      const outcome = test.outcome();
      if (outcome === 'expected') counts.passed += 1;
      else if (outcome === 'skipped') counts.skipped += 1;
      else if (outcome === 'flaky') counts.flaky += 1;
      else {
        counts.failed += 1;
        const last = test.results[test.results.length - 1];
        if (last === undefined) continue;
        const lines = await this.describe(test, last);
        const where = this.where(test, last);
        failures.push({ title: this.title(test), where, lines });
        full.push(`✗ ${this.title(test)}  ${where}`, ...last.errors.map((error) => stripAnsi(error.message ?? error.value ?? '')), '');
      }
    }
    for (const error of this.errors) {
      const lines = messageLines(error.message ?? error.value ?? '');
      failures.push({ title: 'outside any test', where: firstAppFrame(error.stack ?? '', this.root), lines });
      full.push('✗ outside any test', stripAnsi(error.stack ?? error.message ?? ''), '');
    }
    let summed = 0;
    for (const test of this.suite.allTests()) for (const run of test.results) summed += run.duration;
    const workers = this.config.workers ?? 1;
    const extras = [
      ...(workers > 1 || summed > 60_000
        ? [`time: tests summed ${duration(summed)} over ${String(workers)} worker(s)`]
        : []),
      ...this.summaryExtras(),
    ];
    const head = countsLine(this.name, counts, Date.now() - this.started);
    const out = [head, ...extras];
    if (failures.length > 0) {
      out.push(...failureBlock(failures, MAX_LINES - out.length - 1));
      try {
        mkdirSync(dirname(this.failuresFile), { recursive: true });
        writeFileSync(this.failuresFile, `${full.join('\n')}\n`);
        out.push(`whole messages: ${relative(this.root, this.failuresFile)}`);
      } catch {
        out.push('whole messages: not written');
      }
    }
    if (result.status === 'interrupted') out.push(`${this.name}: interrupted`);
    if (result.status === 'timedout') out.push(`${this.name}: the run hit its global timeout`);
    process.stdout.write(`${out.join('\n')}\n`);
  }
}
