import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { schedule, manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';
import type { Runner } from 'harness-dsl/kernel';

const due = H.state('due').pending();
const up = H.state('up').terminal('success');
const down = H.state('down').terminal('failure');
const backedUp = H.state('backed-up').terminal('success');
const backupFailed = H.state('backup-failed').terminal('failure');
const renewed = H.state('renewed').terminal('success');
const current = H.state('current').terminal('success');
const renewalFailed = H.state('renewal-failed').terminal('failure');
const open = H.state('open').pending();
const resolved = H.state('resolved').terminal('success');
const abandoned = H.state('abandoned').terminal('failure');

const heartbeatData = z.object({ service: z.string() });
const backupData = z.object({ database: z.string(), host: z.string() });
const renewalData = z.object({ domain: z.string(), host: z.string() });
const incidentData = z.object({ title: z.string(), source: z.string() });

const Heartbeat = H.work('Heartbeat').schema(heartbeatData).states(due, up, down);
const Backup = H.work('Backup').schema(backupData).states(due, backedUp, backupFailed);
const CertificateRenewal = H.work('CertificateRenewal').schema(renewalData).states(due, renewed, current, renewalFailed);
const Incident = H.work('Incident').schema(incidentData).states(open, resolved, abandoned);

const operationalExperience = H.memory('operational-experience')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');

const local = runners.local({ name: 'local', slots: 8 });

const diskSpace = async (runner: Runner) => {
  const result = await runner.exec(['df', '--output=pcent', '/var/backups'], {}, AbortSignal.timeout(30_000));
  const usedPercent = Number.parseInt(result.stdout.trim().split('\n').slice(-1).join('').replace('%', ''), 10);
  return usedPercent < 85 ? { ok: true } : { ok: false, reason: `backup volume is ${usedPercent}% full` };
};

const dbHostOne = runners.ssh({ name: 'db-1', host: H.env('DB_HOST_1'), user: 'ops', identity: H.env('OPS_SSH_KEY'), slots: 1 })
  .preflight('disk-space', diskSpace);
const dbHostTwo = runners.ssh({ name: 'db-2', host: H.env('DB_HOST_2'), user: 'ops', identity: H.env('OPS_SSH_KEY'), slots: 1 })
  .preflight('disk-space', diskSpace);
const hostRunner = (host: string) => (host === dbHostOne.name ? dbHostOne : dbHostTwo);

const probe = H.command('probe-service')
  .input(heartbeatData)
  .output(z.object({ ok: z.boolean() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['curl', '-fsS', `https://${input.service}.internal/health`], { timeoutMs: 10_000 });
    return { ok: result.code === 0 };
  });

const backup = H.command('backup-database')
  .input(backupData)
  .output(z.object({ archive: z.string() }))
  .runner(input => hostRunner(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/ops/backup', input.database]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { archive: result.stdout.trim() };
  });

const checkCertificate = H.command('check-certificate')
  .input(renewalData)
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => hostRunner(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/ops/cert-days-left', input.domain]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { daysLeft: Number.parseInt(result.stdout.trim(), 10) };
  });

const renewCertificate = H.command('renew-certificate')
  .input(renewalData)
  .output(z.object({ expires: z.string() }))
  .runner(input => hostRunner(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/ops/renew-cert', input.domain]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { expires: result.stdout.trim() };
  });

const runbook = H.command('run-runbook')
  .input(z.object({ title: z.string(), source: z.string() }))
  .output(z.object({ log: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['/opt/ops/runbook', input.source, input.title]);
    return { log: result.stdout + result.stderr };
  });

const acknowledgement = H.halt('incident-acknowledgement')
  .context(z.object({ title: z.string(), source: z.string() }))
  .decision(z.object({ acknowledgedBy: z.string() }))
  .ask(context => `Acknowledge incident: ${context.title} (from ${context.source})`);
const resolutionCheck = H.halt('incident-resolution')
  .context(z.object({ title: z.string(), runbookLog: z.string() }))
  .decision(z.object({ resolved: z.boolean(), note: z.string() }))
  .ask(context => `Is "${context.title}" resolved?\n\n${context.runbookLog}`);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatData)
  .step('probe', probe, state => ({ service: state.input.service }))
  .when(state => !state.probe.ok, failing => failing.exit('down'))
  .exit('up');

const backupFlow = H.flow('backup')
  .input(backupData)
  .step('backup', backup, state => ({ database: state.input.database, host: state.input.host }))
  .exit('backedUp');

const renewalThresholdDays = 14;

const renewalFlow = H.flow('certificate-renewal')
  .input(renewalData)
  .step('check', checkCertificate, state => ({ domain: state.input.domain, host: state.input.host }))
  .when(state => state.check.daysLeft < renewalThresholdDays, expiring => expiring
    .step('renew', renewCertificate, state => ({ domain: state.input.domain, host: state.input.host }))
    .exit('renewed'))
  .exit('current');

const incidentFlow = H.flow('incident-runbook')
  .input(incidentData)
  .halt('acknowledge', acknowledgement, state => ({ title: state.input.title, source: state.input.source }))
  .step('runbook', runbook, state => ({ title: state.input.title, source: state.input.source }))
  .halt('confirm', resolutionCheck, state => ({ title: state.input.title, runbookLog: state.runbook.log }))
  .when(state => !state.confirm.resolved, unresolved => unresolved.exit('unresolved'))
  .exit('resolved');

const services = ['api', 'web', 'worker'];
const databases = [{ database: 'orders', host: 'db-1' }, { database: 'analytics', host: 'db-2' }];
const certificates = [{ domain: 'example.com', host: 'db-1' }, { domain: 'internal.example.com', host: 'db-2' }];

const heartbeats = H.lane('heartbeats').of(Heartbeat)
  .from(schedule.cron({
    name: 'heartbeat-every-five-minutes',
    cron: '*/5 * * * *',
    children: at => services.map(service => ({ key: `${service}-${at.toISOString()}`, data: { service } })),
  }))
  .handle(heartbeatFlow, { exits: { up, down }, retry: { retries: 0, exhausted: down } });

const backups = H.lane('backups').of(Backup)
  .from(schedule.cron({
    name: 'nightly-backups',
    cron: '0 1 * * *',
    children: at => databases.map(entry => ({ key: `${entry.database}-${at.toISOString().slice(0, 10)}`, data: entry })),
  }))
  .handle(backupFlow, { exits: { backedUp }, retry: { retries: 0, exhausted: backupFailed } });

const renewals = H.lane('certificate-renewals').of(CertificateRenewal)
  .from(schedule.cron({
    name: 'weekly-certificate-check',
    cron: '0 4 * * 1',
    children: at => certificates.map(entry => ({ key: `${entry.domain}-${at.toISOString().slice(0, 10)}`, data: entry })),
  }))
  .handle(renewalFlow, { exits: { renewed, current }, retry: { retries: 2, backoff: { initial: '15m', factor: 2 }, exhausted: renewalFailed } });

const incidents = H.lane('incidents').of(Incident)
  .from(manual('operator-incidents'))
  .store(sqlite.store('.harness/incidents.db'))
  .handle(incidentFlow, {
    exits: { resolved, unresolved: { to: open, atMost: 3, then: abandoned } },
    retry: { retries: 1, exhausted: abandoned },
  });

const threeFailedHeartbeats = H.trigger('three-failed-heartbeats-open-incident')
  .on(H.events.transitions(heartbeats, { terminal: true }).streak(3, {
    group: event => event.unit.data.service,
    matches: event => event.verdict === 'failure',
  }))
  .do(incidents.create(event => ({
    key: `heartbeat-${event.group}-${event.events.map(failure => failure.unit.key).join('+')}`,
    data: { title: `Service ${event.group} failed three consecutive heartbeats`, source: 'heartbeat' },
  })));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident')
  .on(H.events.transitions(backups, { to: backupFailed }))
  .do(incidents.create(event => ({
    key: `backup-${event.unit.key}`,
    data: { title: `Backup of ${event.unit.data.database} on ${event.unit.data.host} failed`, source: 'backup' },
  })));

const slowBackupMs = 2 * 60 * 60 * 1000;

const opsJournal = H.journal('operational-experience').of(operationalExperience)
  .store(jsonl.memory('.harness/operational-experience.jsonl'))
  .recall(policies.specificity({ limit: 20 }));

const slowBackupNoted = H.trigger('slow-backup-noted')
  .on(H.events.attempts(backups).where(event => event.outcome === 'succeeded' && event.durationMs > slowBackupMs))
  .do(opsJournal.record(event => ({
    content: {
      do: 'schedule it earlier or check volume throughput first',
      when: `the nightly backup ${event.unit.key} runs`,
      because: `it took ${Math.round(event.durationMs / 60_000)} minutes, over the two-hour budget`,
    },
    when: { kinds: [Backup] },
  })));

const incidentsPreempt = H.policy.units('incidents-preempt', choice => {
  const incidentOpen =
    choice.active.some(unit => unit.lane === incidents.name) || choice.candidates.some(candidate => candidate.lane === incidents.name);
  const rank = (lane: string): number =>
    lane === incidents.name ? 0 : lane === heartbeats.name ? 1 : lane === renewals.name ? 2 : 3;
  return choice.candidates
    .filter(candidate => !(incidentOpen && candidate.lane === backups.name))
    .sort((a, b) => rank(a.lane) - rank(b.lane) || a.queuedAt.getTime() - b.queuedAt.getTime());
});

const opsConsole = http.client({ name: 'ops-console', port: 8080, token: H.env('OPS_API_TOKEN') });

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .journals(opsJournal)
  .triggers(threeFailedHeartbeats, failedBackupOpensIncident, slowBackupNoted)
  .scheduler(incidentsPreempt)
  .grants(H.grant(
    opsConsole,
    H.ops.work.read,
    H.ops.work.write,
    H.ops.resolve(acknowledgement),
    H.ops.resolve(resolutionCheck),
    H.ops.attempts.manage,
    H.ops.memory.read(operationalExperience),
    H.ops.telemetry.read,
  ))
  .observe(
    observers.slack({
      webhookUrl: H.env('SLACK_WEBHOOK_URL'),
      on: H.events.transitions(incidents),
      text: event => `Incident ${event.unit.key} "${event.unit.data.title}": ${event.from ?? 'new'} → ${event.to}`,
    }),
    observers.board({ path: 'BOARD.md' }),
  );

void operations.start();
