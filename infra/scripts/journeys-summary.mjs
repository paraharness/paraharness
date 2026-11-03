#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';

import { SURFACES, SURFACE_NAMES } from '../verify/surfaces.mjs';

export const MESSAGE_LINES = 6;
export const SUMMARY_FILE = 'journeys-summary.json';
const LINE_CHARS = 300;
const STATUS = { expected: 'passed', flaky: 'passed', unexpected: 'failed', skipped: 'skipped' };
const NO_REPORT = 'the journeys did not report';
const NOT_RUN = 'not run';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const resultsDir = (root, surface) => join(root, SURFACES[surface].dir, 'test-results');
export const uploadedResults = (surface) => `${surface}-test-results`;

const firstLines = (message) =>
  stripVTControlCharacters(String(message ?? ''))
    .split('\n')
    .map((line) => line.trimEnd().slice(0, LINE_CHARS))
    .filter((line) => line.trim())
    .slice(0, MESSAGE_LINES);

function specsOf(suite, titles) {
  return [...(suite.specs ?? []).map((spec) => ({ spec, titles })), ...(suite.suites ?? []).flatMap((child) => specsOf(child, [...titles, child.title]))];
}

const specsIn = (report) => (report.suites ?? []).flatMap((file) => specsOf(file, []));

function uploadedPath(path, root, surface) {
  if (!path) return null;
  const inside = relative(resultsDir(root, surface), path);
  if (inside.startsWith('..') || inside.startsWith(sep) || inside === '') return null;
  return `${uploadedResults(surface)}/${inside.split(sep).join('/')}`;
}

function failureOf(surface, root, spec, titles, test) {
  const results = test.results ?? [];
  const errors = results.flatMap((result) => result.errors ?? (result.error ? [result.error] : []));
  const attachments = results.flatMap((result) => result.attachments ?? []).map((attachment) => ({ name: attachment.name, path: uploadedPath(attachment.path, root, surface) })).filter((attachment) => attachment.path);
  const dir = SURFACES[surface].journeys;
  return {
    surface,
    file: spec.file.startsWith(dir) ? spec.file : `${dir}${spec.file}`,
    title: [...titles, spec.title].join(' › '),
    project: test.projectName,
    message: firstLines(errors.map((error) => error.message).join('\n')),
    trace: attachments.find((attachment) => attachment.name === 'trace')?.path ?? null,
    screenshots: attachments.filter((attachment) => attachment.name === 'screenshot').map((attachment) => attachment.path),
    attachments: attachments.filter((attachment) => attachment.name !== 'trace' && attachment.name !== 'screenshot'),
  };
}

function readSurface(surface, report, root) {
  const totals = { passed: 0, failed: 0, skipped: 0 };
  const failures = [];
  for (const { spec, titles } of specsIn(report)) {
    for (const test of spec.tests ?? []) {
      const status = STATUS[test.status] ?? 'failed';
      totals[status] += 1;
      if (status === 'failed') failures.push(failureOf(surface, root, spec, titles, test));
    }
  }
  const errors = (report.errors ?? []).map((error) => firstLines(error.message)[0] ?? 'failed with no error message');
  return { totals, failures, errors };
}

export function summarise({ root, reports, notes }) {
  const totals = { passed: 0, failed: 0, skipped: 0 };
  const surfaces = {};
  const failures = [];
  for (const surface of SURFACE_NAMES) {
    const report = reports[surface];
    if (!report) {
      surfaces[surface] = { ran: false, note: notes[surface] ?? NOT_RUN };
      continue;
    }
    const read = readSurface(surface, report, root);
    surfaces[surface] = { ran: true, totals: read.totals, ...(read.errors.length > 0 ? { errors: read.errors } : {}) };
    for (const key of Object.keys(totals)) totals[key] += read.totals[key];
    failures.push(...read.failures);
  }
  return { totals, surfaces, failures };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function fromDir(dir, root) {
  const reports = {};
  const notes = {};
  for (const surface of SURFACE_NAMES) {
    const reportPath = join(dir, `${surface}-report.json`);
    if (existsSync(reportPath)) {
      const report = readJson(reportPath);
      if (report) reports[surface] = report;
      else notes[surface] = NO_REPORT;
      continue;
    }
    const result = readJson(join(dir, `${surface}-e2e.json`));
    if (result) notes[surface] = result.note ?? result.infrastructure?.[0] ?? NO_REPORT;
  }
  return summarise({ root, reports, notes });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { dir: { type: 'string' }, root: { type: 'string' } } });
  if (!values.dir) {
    process.stderr.write('journeys-summary: usage: --dir <run folder> [--root <checkout>]\n');
    process.exit(2);
  }
  const summary = fromDir(values.dir, values.root ?? REPO_ROOT);
  writeFileSync(join(values.dir, SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`);
  const { passed, failed, skipped } = summary.totals;
  process.stdout.write(`journeys: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
}
