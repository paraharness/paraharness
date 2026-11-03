#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { SURFACE_NAMES } from '../verify/surfaces.mjs';

import { SUMMARY_FILE } from './journeys-summary.mjs';

export const JOURNEYS_ARTIFACT = 'journeys-summary';
export const CATALOGUE_ARTIFACT = 'catalogue-scan';
export const CATALOGUE_FILE = 'findings.json';
const USAGE = 'nightly-findings: usage: --dir <downloaded artifacts> --run <run url>';

const journeyFinding = (failure, run) => ({ severity: 'blocking', screen: failure.file, what: `${failure.title} (${failure.project})`, source: 'nightly journeys', link: run });
const describe = ({ check, element, detail }) => `${check} ${element}: ${detail}`;
const shotFindings = (shot, run) =>
  [...(shot.error ? [`the shot failed: ${shot.error}`] : []), ...shot.scan.map(describe)].map((what) => ({ severity: 'blocking', screen: `${shot.surface}:${shot.screen}`, what, source: 'nightly scan', link: run }));
const unread = (run) => ({ severity: 'blocking', screen: 'nightly', what: 'the nightly run failed without a failure it could read', source: 'nightly', link: run });

export function nightlyFindings({ summary, scanned = [], run }) {
  const found = Object.fromEntries(SURFACE_NAMES.map((name) => [name, []]));
  for (const failure of summary?.failures ?? []) found[failure.surface].push(journeyFinding(failure, run));
  for (const shot of scanned)
    for (const finding of shotFindings(shot, run))
      if (!found[shot.surface].some((known) => known.screen === finding.screen && known.what === finding.what)) found[shot.surface].push(finding);
  if (Object.values(found).every((findings) => findings.length === 0)) found[SURFACE_NAMES[0]].push(unread(run));
  return found;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function run(argv, { err = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const { values } = parseArgs({ args: argv, options: { dir: { type: 'string' }, run: { type: 'string' } } });
  if (!values.dir || !values.run) {
    err(USAGE);
    return 2;
  }
  const found = nightlyFindings({
    summary: readJson(join(values.dir, JOURNEYS_ARTIFACT, SUMMARY_FILE)),
    scanned: readJson(join(values.dir, CATALOGUE_ARTIFACT, CATALOGUE_FILE)) ?? [],
    run: values.run,
  });
  for (const [surface, findings] of Object.entries(found)) writeFileSync(join(values.dir, `${surface}-file.json`), `${JSON.stringify(findings, null, 2)}\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = run(process.argv.slice(2));
