#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';

import { SCREEN_TAG } from '../verify/journeys.mjs';
import { SURFACES } from '../verify/surfaces.mjs';

export const SETUP_PROJECT = 'setup';

const firstLine = (text) =>
  stripVTControlCharacters(String(text ?? ''))
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? 'failed with no error message';

function specsOf(suite) {
  return [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specsOf)];
}

export function readReport(report, surface) {
  const dir = SURFACES[surface].journeys;
  const infrastructure = (report.errors ?? []).map((error) => firstLine(error.message));
  const findings = [];
  let ran = 0;
  for (const spec of (report.suites ?? []).flatMap(specsOf)) {
    for (const test of spec.tests ?? []) {
      if (test.status === 'skipped') continue;
      const failed = test.status === 'unexpected';
      const error = test.results?.flatMap((result) => result.errors ?? (result.error ? [result.error] : []))[0];
      if (test.projectName === SETUP_PROJECT) {
        if (failed) infrastructure.push(`sign-in setup failed: ${firstLine(error?.message)}`);
        continue;
      }
      ran += 1;
      if (!failed) continue;
      const screens = (spec.tags ?? []).map((tag) => tag.replace(/^@?/, '@')).filter((tag) => tag.startsWith(SCREEN_TAG)).map((tag) => tag.slice(SCREEN_TAG.length));
      const file = spec.file.startsWith(dir) ? spec.file : `${dir}${spec.file}`;
      findings.push({ severity: 'blocking', screen: screens.join(', ') || '(no screen)', what: firstLine(error?.message), source: `e2e ${file} › ${spec.title}` });
    }
  }
  return { ran, findings, infrastructure };
}

export function run(argv, { read = (path) => readFileSync(path, 'utf8'), write = writeFileSync, out = console.log, err = console.error } = {}) {
  let options = {};
  try {
    ({ values: options } = parseArgs({ args: argv, options: { surface: { type: 'string' }, report: { type: 'string' }, out: { type: 'string' } } }));
  } catch (error) {
    if (!String(error.code).startsWith('ERR_PARSE_ARGS')) throw error;
    options = {};
  }
  if (!SURFACES[options.surface] || !options.report || !options.out) {
    err('qa-e2e: usage: --surface app|admin --report <report.json> --out <result.json>');
    return 2;
  }
  let report;
  try {
    report = JSON.parse(read(options.report));
  } catch (error) {
    err(`qa-e2e: no readable report at ${options.report} (${error.message})`);
    return 2;
  }
  const { ran, findings, infrastructure } = readReport(report, options.surface);
  const filed = infrastructure.length > 0 ? [] : findings;
  write(options.out, `${JSON.stringify({ ran, findings: filed, infrastructure }, null, 2)}\n`);
  for (const line of infrastructure) err(`qa-e2e: ${options.surface}: ${line}`);
  out(`qa-e2e: ${options.surface}: ${ran} journey(s) ran, ${filed.length} failed${infrastructure.length > 0 ? ', and the run itself failed' : ''}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
