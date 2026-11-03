#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseFlags } from 'node:util';

import { SURFACES } from '../verify/surfaces.mjs';

import { Refused, linearAsk } from './linear-api.mjs';

export const TEAM_KEY = 'CD';
export const SEVERITIES = ['blocking', 'polish'];
const HEADER = 'Findings on dev, one item per finding. Tick an item when its fix is released; bugs are fixed in batches.';
export const BATCHES = {
  'mvp-debt': {
    title: 'MVP debt',
    project: null,
    header: 'Failures of the nightly full journeys on main (`.github/workflows/nightly.yml`) while CI runs the smoke journeys only, one item per failure. Tick an item when its fix merges; the stabilisation ticket clears the rest.',
  },
};
const VERSION = /^(v\d+\.\d+|[0-9a-f]{7,40})$/;

export class Usage extends Error {}

const normalised = (text) => String(text).toLowerCase().replace(/[^a-z0-9/$[\]]+/g, ' ').trim();

export const keyOf = (surface, finding) => {
  const identity = [surface, 'verifier', finding.screen, normalised(finding.what)];
  return `qa:${createHash('sha1').update(identity.join('\0')).digest('hex').slice(0, 8)}`;
};

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();

export const itemFor = (surface, version, finding) =>
  `- [ ] ${finding.severity} · ${oneLine(finding.screen)} · ${oneLine(finding.what)} · ${version} · ${oneLine(finding.source)}${finding.link ? ` · ${finding.link}` : ''} · ${keyOf(surface, finding)}`;

export function newItems(description, surface, version, findings) {
  const lines = String(description ?? '').split('\n');
  const open = (key) => lines.some((line) => /^- \[ \] /.test(line) && line.trimEnd().endsWith(key));
  const items = [];
  const seen = new Set();
  for (const finding of findings) {
    const key = keyOf(surface, finding);
    if (open(key) || seen.has(key)) continue;
    seen.add(key);
    items.push(itemFor(surface, version, finding));
  }
  return items;
}

export function parseFindings(text) {
  const findings = JSON.parse(text);
  if (!Array.isArray(findings)) throw new Usage('the findings file holds a JSON array');
  for (const finding of findings) {
    if (!SEVERITIES.includes(finding?.severity) || !finding.screen || !finding.what || !finding.source)
      throw new Usage(`a finding needs severity (${SEVERITIES.join('|')}), screen, what and source: ${JSON.stringify(finding)}`);
  }
  return findings;
}

export function parseArgs(argv) {
  let options;
  try {
    ({ values: options } = parseFlags({ args: argv, options: { surface: { type: 'string' }, version: { type: 'string' }, findings: { type: 'string' }, batch: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } }));
  } catch (error) {
    throw new Usage(error.message);
  }
  if (!SURFACES[options.surface]) throw new Usage(`--surface is ${Object.keys(SURFACES).join(' or ')}`);
  if (!VERSION.test(options.version ?? '')) throw new Usage('--version is v<major>.<minor> or a commit sha');
  if (!options.findings) throw new Usage('--findings <file.json> is required');
  if (options.batch !== undefined && !BATCHES[options.batch]) throw new Usage(`--batch is ${Object.keys(BATCHES).join(' or ')}, or left out for the surface's QA batch`);
  return { ...options, dryRun: options['dry-run'] };
}

async function openBatch(ask, title) {
  const found = await ask(
    `query QaBatch($team: String!, $title: String!) { issues(first: 5, filter: { team: { key: { eq: $team } }, title: { eq: $title }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id identifier description } } }`,
    { team: TEAM_KEY, title },
  );
  return found.issues.nodes[0] ?? null;
}

async function createBatch(ask, { title, project, header = HEADER }, items) {
  const team = (await ask(`query QaTeam($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`, { key: TEAM_KEY })).teams.nodes[0];
  if (!team) throw new Refused(`Linear has no team ${TEAM_KEY}`);
  const projectId = project
    ? (await ask(`query QaProject($name: String!) { projects(filter: { name: { eq: $name } }) { nodes { id } } }`, { name: project })).projects.nodes[0]?.id
    : undefined;
  if (project && !projectId) throw new Refused(`Linear has no project "${project}"`);
  const created = await ask(`mutation QaBatchNew($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`, {
    input: { teamId: team.id, title, description: `${header}\n\n${items.join('\n')}`, ...(projectId ? { projectId } : {}) },
  });
  return { id: created.issueCreate.issue?.id, identifier: created.issueCreate.issue?.identifier ?? title };
}

export async function file({ ask, surface, version, findings, batch: target, dryRun = false, out = console.log }) {
  if (findings.length === 0) {
    out(`qa-linear: ${surface}: no findings`);
    return null;
  }
  const where = target ? BATCHES[target] : SURFACES[surface].linear;
  const { title } = where;
  let batch = await openBatch(ask, title);
  const items = newItems(batch?.description, surface, version, findings);
  if (dryRun) {
    out(`qa-linear: ${surface}: would add ${items.length} item(s) to ${batch?.identifier ?? `a new "${title}"`} (dry run)`);
    return batch?.identifier ?? null;
  }
  if (items.length === 0) out(`qa-linear: ${surface}: every finding is already open in ${batch.identifier}`);
  if (items.length > 0 && batch) {
    await ask(`mutation QaBatchAdd($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, {
      id: batch.id,
      input: { description: `${String(batch.description ?? '').trimEnd()}\n${items.join('\n')}` },
    });
    out(`qa-linear: ${surface}: added ${items.length} item(s) to ${batch.identifier}`);
  }
  if (items.length > 0 && !batch) {
    batch = await createBatch(ask, where, items);
    out(`qa-linear: ${surface}: opened ${batch.identifier} with ${items.length} item(s)`);
  }
  return batch?.identifier ?? null;
}

export async function run(argv, env, { fetchImpl = fetch, out = console.log, err = console.error, read = (path) => readFileSync(path, 'utf8') } = {}) {
  try {
    const options = parseArgs(argv);
    const findings = parseFindings(read(options.findings));
    if (!env.LINEAR_API_KEY) throw new Refused('LINEAR_API_KEY is not set, so the findings were not filed');
    await file({ ask: linearAsk({ apiKey: env.LINEAR_API_KEY, fetchImpl }), surface: options.surface, version: options.version, findings, batch: options.batch, dryRun: options.dryRun, out });
    return 0;
  } catch (error) {
    if (error instanceof Usage || error instanceof SyntaxError) {
      err(`qa-linear: usage: ${error.message}`);
      return 2;
    }
    if (error instanceof Refused) {
      err(`qa-linear: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
