import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { manual, schedule } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { observers } from 'harness-dsl/observers';

const due = H.state('due').pending();
const up = H.state('up').terminal('success');
const down = H.state('down').terminal('failure');
const scheduled = H.state('scheduled').pending();
const backedUp = H.state('backed-up').terminal('success');
const backupFailed = H.state('backup-failed').terminal('failure');
const stillValid = H.state('still-valid').terminal('success');
const renewed = H.state('renewed').terminal('success');
const renewalFailed = H.state('renewal-failed').terminal('failure');
const open = H.state('open').pending();
const resolved = H.state('resolved').terminal('success');
const handedOver = H.state('handed-over').terminal('failure');

const heartbeatSchema = z.object({ service: z.string(), url: z.string() });
const backupSchema = z.object({ database: z.string(), host: z.string() });
const renewalSchema = z.object({ domain: z.string(), host: z.string() });
const incidentSchema = z.object({ title: z.string(), service: z.string(), origin: z.string() });

const heartbeat = H.work('Heartbeat').schema(heartbeatSchema).states(due, up, down);
const backup = H.work('Backup').schema(backupSchema).states(scheduled, backedUp, backupFailed);
const renewal = H.work('CertificateRenewal').schema(renewalSchema).states(scheduled, stillValid, renewed, renewalFailed);
const incident = H.work('Incident').schema(incidentSchema).states(open, resolved, handedOver);

const database = H.resource('database');

const operational = H.memory('operational-experience').content(z.object({ rule: z.string() })).trust('experience');
const operationalJournal = H.journal('operational-experience').of(operational).store(jsonl.memory('.harness/operations.jsonl'));

const local = runners.local({ name: 'local', slots: 8 });
const freeDisk = (path: string) => async (runner: { exec: typeof local.exec }) => {
  const result = await runner.exec(['df', '--output=pcent', path], {}, new AbortController().signal);
  const used = Number(result.stdout.trim().split('\n').pop()?.replace('%', '') ?? '100');
  return used < 85 ? { ok: true } : { ok: false, reason: `${path} is ${used}% full` };
};
const hostA = runners.ssh({ name: 'db-a', host: H.env('DB_A_HOST'), user: 'ops', identity: H.env('OPS_SSH_KEY'), slots: 1 }).preflight('disk-space', freeDisk('/var/backups'));
const hostB = runners.ssh({ name: 'db-b', host: H.env('DB_B_HOST'), user: 'ops', identity: H.env('OPS_SSH_KEY'), slots: 1 }).preflight('disk-space', freeDisk('/var/backups'));
const hostFor = (host: string) => (host === hostB.name ? hostB : hostA);

const probe = H.command('probe-service')
  .input(heartbeatSchema)
  .output(z.object({ status: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async input => {
    const response = await fetch(input.url);
    if (!response.ok) throw new Error(`${input.service} answered ${response.status}`);
    return { status: response.status };
  });

const dumpDatabase = H.command('dump-database')
  .input(backupSchema)
  .output(z.object({ bytes: z.number() }))
  .runner(input => hostFor(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/ops/backup', input.database]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { bytes: Number(result.stdout.trim()) };
  });

const checkCertificate = H.command('check-certificate')
  .input(renewalSchema)
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => hostFor(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/ops/cert-days-left', input.domain]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { daysLeft: Number(result.stdout.trim()) };
  });

const renewCertificate = H.command('renew-certificate')
  .input(renewalSchema)
  .output(z.object({ expires: z.string() }))
  .runner(input => hostFor(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/ops/renew-cert', input.domain]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { expires: result.stdout.trim() };
  });

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string(), service: z.string() }))
  .output(z.object({ pageId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/ops/page', input.service], { stdin: input.title });
    if (result.code !== 0) throw new Error(result.stderr);
    return { pageId: result.stdout.trim() };
  });

const runRunbook = H.command('run-runbook')
  .input(z.object({ service: z.string() }))
  .output(z.object({ output: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/ops/runbook', input.service]);
    return { output: result.stdout + result.stderr };
  });

const incidentAck = H.halt('incident-acknowledgement')
  .context(z.object({ title: z.string(), pageId: z.string() }))
  .decision(z.object({ acknowledgedBy: z.string() }))
  .ask(c => `Acknowledge incident: ${c.title}`);
const incidentResolution = H.halt('incident-resolution')
  .context(z.object({ title: z.string(), runbookOutput: z.string() }))
  .decision(z.object({ resolved: z.boolean(), note: z.string() }))
  .ask(c => `Is "${c.title}" resolved after the runbook?`);

const heartbeatFlow = H.flow('heartbeat').input(heartbeatSchema).step('probe', probe, s => s.input).exit('up');

const backupFlow = H.flow('backup')
  .input(backupSchema)
  .tag(database, s => s.input.database)
  .step('dump', dumpDatabase, s => s.input)
  .exit('backedUp');

const renewalFlow = H.flow('certificate-renewal')
  .input(renewalSchema)
  .step('check', checkCertificate, s => s.input)
  .when(s => s.check.daysLeft >= 14, f => f.exit('stillValid'))
  .step('renew', renewCertificate, s => s.input)
  .exit('renewed');

const runbookFlow = H.flow('incident-runbook')
  .input(incidentSchema)
  .step('page', pageOnCall, s => ({ title: s.input.title, service: s.input.service }))
  .halt('acknowledged', incidentAck, s => ({ title: s.input.title, pageId: s.page.pageId }))
  .step('runbook', runRunbook, s => ({ service: s.input.service }))
  .halt('confirmed', incidentResolution, s => ({ title: s.input.title, runbookOutput: s.runbook.output }))
  .when(s => s.confirmed.resolved, f => f.exit('resolved'))
  .exit('unresolved');

const services = [
  { service: 'api', url: 'https://api.internal/health' },
  { service: 'auth', url: 'https://auth.internal/health' },
];
const databases = [
  { database: 'orders', host: hostA.name },
  { database: 'billing', host: hostB.name },
];
const domains = [
  { domain: 'example.com', host: hostA.name },
  { domain: 'api.example.com', host: hostB.name },
];

const heartbeats = H.lane('heartbeats').of(heartbeat);
const backups = H.lane('backups').of(backup);
const renewals = H.lane('certificate-renewals').of(renewal);
const incidents = H.lane('incidents').of(incident);

const heartbeatLane = heartbeats
  .from(schedule.cron({ name: 'every-5m', cron: '*/5 * * * *', children: at => services.map(s => ({ key: `${s.service}-${at.toISOString()}`, data: s })) }))
  .handle(heartbeatFlow, { exits: { up }, retry: { retries: 0, backoff: 'none', exhausted: down } });

const backupLane = backups
  .from(schedule.cron({ name: 'nightly', cron: '0 1 * * *', children: at => databases.map(d => ({ key: `${d.database}-${at.toISOString().slice(0, 10)}`, data: d })) }))
  .handle(backupFlow, { exits: { backedUp }, retry: { retries: 1, backoff: { initial: '15m', factor: 2 }, exhausted: backupFailed } });

const renewalLane = renewals
  .from(schedule.cron({ name: 'weekly', cron: '0 4 * * 1', children: at => domains.map(d => ({ key: `${d.domain}-${at.toISOString().slice(0, 10)}`, data: d })) }))
  .handle(renewalFlow, { exits: { stillValid, renewed }, retry: { retries: 2, backoff: { initial: '1h', factor: 2 }, exhausted: renewalFailed } });

const incidentLane = incidents
  .from(manual('operator'))
  .handle(runbookFlow, {
    exits: { resolved, unresolved: { to: open, atMost: 3, then: handedOver } },
    retry: { retries: 2, backoff: { initial: '1m', factor: 2 }, exhausted: handedOver },
  });

const threeDownOpensIncident = H.trigger('three-failed-heartbeats-open-incident')
  .on(H.events.transitions(heartbeats, { terminal: true }).streak(3, { group: e => e.unit.data.service, matches: e => e.verdict === 'failure' }))
  .do(incidents.create(e => ({
    key: `heartbeat-${e.group}-${e.events[e.events.length - 1].at.toISOString()}`,
    data: { title: `${e.group} failed three heartbeats in a row`, service: e.group, origin: 'heartbeat' },
  })));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident')
  .on(H.events.transitions(backups, { to: backupFailed }))
  .do(incidents.create(e => ({
    key: `backup-${e.unit.key}`,
    data: { title: `Backup of ${e.unit.data.database} failed`, service: e.unit.data.database, origin: 'backup' },
  })));

const slowBackupMs = 2 * 60 * 60 * 1000;
const slowBackupNote = H.trigger('slow-backup-note')
  .on(H.events.attempts(backups).where(a => a.outcome === 'succeeded' && a.durationMs > slowBackupMs))
  .do(operationalJournal.record(a => ({
    content: { rule: `When backing up ${a.unit.resources[database.name]}, start it earlier or split it, because it took ${(a.durationMs / 3600000).toFixed(1)} hours on ${a.at.toISOString().slice(0, 10)}.` },
    when: { kinds: [backup], resources: [database.is(a.unit.resources[database.name])] },
  })));

const openIncidents = H.metric('open-incidents', H.events.transitions(incidents))
  .sum(e => (e.from === undefined ? 1 : e.position === 'terminal' ? -1 : 0))
  .window('365d');

const laneOrder: readonly string[] = [incidents.name, heartbeats.name, renewals.name, backups.name];
const rank = (candidate: Candidate): number => laneOrder.indexOf(candidate.lane);

const incidentsFirst = H.policy.units('incidents-first', c => {
  const incidentOpen = (c.metrics.read(openIncidents).value ?? 0) > 0;
  return [...c.candidates]
    .filter(candidate => !(incidentOpen && candidate.lane === backups.name))
    .sort((a, b) => rank(a) - rank(b) || a.queuedAt.getTime() - b.queuedAt.getTime());
});

const console = H.grant(
  http.client({ name: 'ops-console', port: H.slot.port(0), token: H.env('OPS_CONSOLE_TOKEN') }),
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(incidentAck),
  H.ops.resolve(incidentResolution),
  H.ops.memory.read(operational),
  H.ops.telemetry.read,
);

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidentLane, heartbeatLane, backupLane, renewalLane)
  .journals(operationalJournal)
  .triggers(threeDownOpensIncident, failedBackupOpensIncident, slowBackupNote)
  .scheduler(incidentsFirst)
  .grants(console)
  .observe(
    observers.slack({ webhookUrl: H.env('SLACK_WEBHOOK_URL'), on: H.events.transitions(incidents), text: e => `Incident ${e.unit.data.title}: ${e.from ?? 'new'} → ${e.to}` }),
    observers.board({ path: 'BOARD.md' }),
  );

void operations.start();
