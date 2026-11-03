import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LINES_PER_FAILURE, MAX_LINES, countsLine, failureBlock, firstAppFrame, messageLines, stripAnsi } from './compact-lib.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function errorLines(error) {
  const head = [error.name && error.name !== 'Error' && error.name !== 'AssertionError' ? `${error.name}: ${error.message ?? ''}` : (error.message ?? String(error))];
  if (error.diff) {
    head.push(
      ...stripAnsi(error.diff)
        .split('\n')
        .filter((line) => /^\s*[-+]\s/.test(line) && !/^\s*[-+] (Expected|Received)\s*$/.test(line)),
    );
  }
  return messageLines(head.join('\n'));
}

function stackLines(stack, root) {
  return stripAnsi(stack)
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 3)
    .map((line) => line.trim().replace(`${root}/`, ''));
}

function wholeError(error) {
  return [stripAnsi(error.stack ?? `${error.name ?? 'Error'}: ${error.message ?? String(error)}`), ...(error.diff ? [stripAnsi(error.diff)] : [])].join('\n');
}

function frameOf(error, root) {
  for (const frame of error.stacks ?? []) {
    if (frame.file && !frame.file.includes('/node_modules/')) return `${relative(root, frame.file)}:${String(frame.line)}`;
  }
  return firstAppFrame(error.stack ?? '', root);
}

export default class CompactVitestReporter {
  constructor(options = {}) {
    this.root = options.root ?? REPO_ROOT;
    this.failuresFile = options.failuresFile;
  }

  onInit(vitest) {
    this.vitest = vitest;
    this.started = Date.now();
    this.name = `vitest ${basename(vitest.config.root)}`;
    this.failuresFile ??= join(vitest.config.root, 'test-results', 'vitest-failures.txt');
  }

  onTestRunStart() {
    this.started = Date.now();
  }

  onTestRunEnd(testModules, unhandledErrors = [], reason) {
    const counts = { files: testModules.length, passed: 0, failed: 0, flaky: 0, skipped: 0, errors: unhandledErrors.length };
    const failures = [];
    const full = [];
    for (const module of testModules) {
      const file = relative(this.root, module.moduleId);
      for (const error of module.errors?.() ?? []) {
        failures.push({ title: `${file} (the file itself)`, where: frameOf(error, this.root), lines: errorLines(error) });
        full.push(`✗ ${file} (the file itself)`, wholeError(error), '');
      }
      for (const test of module.children.allTests()) {
        const result = test.result();
        if (result.state === 'passed') {
          counts.passed += 1;
          if (test.diagnostic?.()?.flaky) counts.flaky += 1;
        } else if (result.state === 'failed') {
          counts.failed += 1;
          const errors = result.errors ?? [];
          failures.push({
            title: `${file} › ${test.fullName}`,
            where: errors.map((error) => frameOf(error, this.root)).find((frame) => frame !== null) ?? file,
            lines: errors.flatMap(errorLines).slice(0, 6),
          });
          full.push(`✗ ${file} › ${test.fullName}`, ...errors.map(wholeError), '');
        } else counts.skipped += 1;
      }
    }
    for (const error of unhandledErrors) {
      const where = frameOf(error, this.root);
      const origin = [error.VITEST_TEST_PATH ? relative(this.root, error.VITEST_TEST_PATH) : null, error.VITEST_TEST_NAME].filter(Boolean);
      failures.push({
        title: ['unhandled error', ...origin].join(' › '),
        where,
        lines: [...errorLines(error), ...(where === null ? stackLines(error.stack ?? '', this.root) : [])].slice(0, LINES_PER_FAILURE),
      });
      full.push(`✗ ${['unhandled error', ...origin].join(' › ')}`, wholeError(error), '');
    }
    const out = [countsLine(this.name, counts, Date.now() - this.started)];
    if (failures.length > 0) {
      out.push(...failureBlock(failures, MAX_LINES - 2));
      try {
        mkdirSync(dirname(this.failuresFile), { recursive: true });
        writeFileSync(this.failuresFile, `${full.join('\n')}\n`);
        out.push(`whole messages: ${relative(this.root, this.failuresFile)}`);
      } catch {
        out.push('whole messages: not written');
      }
    }
    if (reason === 'interrupted') out.push(`${this.name}: interrupted`);
    const seed = this.vitest?.getSeed?.() ?? null;
    if (seed !== null) out.push(`${this.name}: shuffled with seed ${String(seed)}, rerun with --sequence.seed=${String(seed)}`);
    process.stdout.write(`${out.join('\n')}\n`);
  }
}
