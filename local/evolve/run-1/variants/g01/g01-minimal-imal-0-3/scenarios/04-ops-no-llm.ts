import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, ActiveView } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';

const Due = H.state('due', 'pending');
const Running = H.state('running', 'active');
const Healthy = H.state('healthy', 'terminal', 'success');
const Unhealthy = H.state('unhealthy', 'terminal', 'failure');
const BackedUp = H.state('backed-up', 'terminal', 'success');
const Valid = H.state('valid', 'terminal', 'success');
const Renewed = H.state('renewed', 'terminal', 'success');
const Failed = H.state('failed', 'terminal', 'failure');
const Skipped = H.state('skipped', 'terminal', 'neutral');

const Open = H.state('open', 'pending');
const Acknowledging = H.state('acknowledging', 'active');
const Remediating = H.state('remediating', 'active');
const Confirming = H.state('confirming', 'active');
const Resolved = H.state('resolved', 'terminal', 'success');
const Unresolved = H.state('unresolved', 'terminal', 'failure');
const Dismissed = H.state('dismissed', 'terminal', 'neutral');

const Heartbeat = H.kind('Heartbeat')
  .data(z.object({ service: z.string(), url: z.string() }))
  .states([Due, Running, Healthy, Unhealthy, Skipped], { initial: 'due', afterFailure: 'unhealthy', afterCancel: 'skipped' });

const Backup = H.kind('Backup')
  .data(z.object({ database: z.string(), host: z.string() }))
  .states([Due, Running, BackedUp, Failed, Skipped], { initial: 'due', afterFailure: 'failed', afterCancel: 'skipped' });

const CertificateRenewal = H.kind('CertificateRenewal')
  .data(z.object({ domain: z.string(), host: z.string() }))
  .states([Due, Running, Valid, Renewed, Failed, Skipped], { initial: 'due', afterFailure: 'failed', afterCancel: 'skipped' });

const Incident = H.kind('Incident')
  .data(z.object({ title: z.string(), detail: z.string(), runbook: z.string() }))
  .states([Open, Acknowledging, Remediating, Confirming, Resolved, Unresolved, Dismissed], {
    initial: 'open',
    afterFailure: 'unresolved',
    afterCancel: 'dismissed',
  });

const local = shell.local('local', { slots: 4 });
const diskPreflight = ['test "$(df --output=avail -k /var/backups | tail -1)" -gt 52428800'];
const db1 = ssh.host('db-1', {
  address: 'db-1.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskPreflight,
});
const db2 = ssh.host('db-2', {
  address: 'db-2.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskPreflight,
});
const hostFor = (input: { host: string }) => input.host === db1.name ? db1 : db2;

const probe = H.command('probe')
  .input(z.object({ url: z.string() }))
  .argv(input => ['curl', '--fail', '--silent', '--max-time', '10', input.url])
  .on(local)
  .restart('rerun');

const backupDatabase = H.command('backup-database')
  .input(z.object({ database: z.string(), host: z.string() }))
  .argv(input => ['/opt/ops/backup.sh', input.database])
  .on(hostFor);

const certificateDaysLeft = H.command('certificate-days-left')
  .input(z.object({ domain: z.string(), host: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['/opt/ops/cert-days-left.sh', input.domain])
  .on(hostFor)
  .restart('rerun');

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string(), host: z.string() }))
  .argv(input => ['/opt/ops/renew-cert.sh', input.domain])
  .on(hostFor)
  .restart('rerun');

const runRunbook = H.command('run-runbook')
  .input(z.object({ runbook: z.string(), title: z.string() }))
  .argv(input => ['/opt/ops/runbooks/run.sh', input.runbook, input.title])
  .on(local);

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async ctx => {
    await ctx.move('running');
    const result = await ctx.run(probe, { url: ctx.unit.data.url });
    return result.ok ? 'healthy' : 'unhealthy';
  });

const backupFlow = H.flow('backup')
  .for(Backup)
  .does(async ctx => {
    await ctx.move('running');
    const result = await ctx.run(backupDatabase, { database: ctx.unit.data.database, host: ctx.unit.data.host });
    return result.ok ? 'backed-up' : ctx.fail(result.error);
  });

const renewalThresholdDays = 14;

const certificateFlow = H.flow('certificate-renewal')
  .for(CertificateRenewal)
  .does(async ctx => {
    await ctx.move('running');
    const target = { domain: ctx.unit.data.domain, host: ctx.unit.data.host };
    const checked = await ctx.run(certificateDaysLeft, target);
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.daysLeft >= renewalThresholdDays) return 'valid';
    const renewed = await ctx.run(renewCertificate, target);
    return renewed.ok ? 'renewed' : ctx.fail(renewed.error);
  });

const incidentFlow = H.flow('incident-runbook')
  .for(Incident)
  .does(async ctx => {
    const { title, detail, runbook } = ctx.unit.data;
    await ctx.move('acknowledging');
    await ctx.halt({
      name: 'acknowledge',
      show: `${title}\n\n${detail}`,
      decision: z.object({ by: z.string() }),
    });
    await ctx.move('remediating');
    const remediated = await ctx.run(runRunbook, { runbook, title });
    await ctx.move('confirming');
    const confirmed = await ctx.halt({
      name: 'confirm-resolution',
      show: remediated.ok ? `Runbook ${runbook} completed.` : `Runbook ${runbook} failed: ${remediated.error}`,
      decision: z.object({ resolved: z.boolean(), note: z.string().optional() }),
    });
    return confirmed.resolved ? 'resolved' : 'unresolved';
  });

const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow);
const backups = H.lane('backups', Backup).handler(backupFlow);
const certificates = H.lane('certificates', CertificateRenewal).handler(certificateFlow);
const incidents = H.lane('incidents', Incident).handler(incidentFlow).suppliers(H.operator);

const services = [
  { service: 'api', url: 'https://api.internal/health' },
  { service: 'auth', url: 'https://auth.internal/health' },
];
const databases = [
  { database: 'orders', host: 'db-1' },
  { database: 'customers', host: 'db-2' },
];
const certificatesToWatch = [
  { domain: 'example.com', host: 'db-1' },
  { domain: 'internal.example.com', host: 'db-2' },
];

const heartbeatSchedule = H.trigger('heartbeat-every-five-minutes', H.on.clock({ every: { minutes: 5 } }), (_event, act) =>
  services.map(service => act.create(heartbeats, service)));

const backupSchedule = H.trigger('backup-nightly', H.on.clock({ daily: '01:00' }), (event, act) =>
  databases.map(db => act.create(backups, db, `${db.database}-${event.at.toISOString().slice(0, 10)}`)));

const certificateSchedule = H.trigger('certificate-weekly', H.on.clock({ weekly: { day: 'mon', at: '04:00' } }), (_event, act) =>
  certificatesToWatch.map(cert => act.create(certificates, cert, cert.domain)));

const threeFailedHeartbeats = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(Heartbeat, 'unhealthy', 3, data => data.service),
  (event, act) => act.create(incidents, {
    title: `${event.unit.data.service} failed ${event.streak ?? 3} heartbeats in a row`,
    detail: `Probe of ${event.unit.data.url} failing since before ${event.at.toISOString()}.`,
    runbook: 'service-down',
  }, `heartbeat-${event.unit.data.service}`),
);

const failedBackup = H.trigger('failed-backup-opens-incident', H.on.enters(Backup, 'failed'), (event, act) =>
  act.create(incidents, {
    title: `Backup of ${event.unit.data.database} failed`,
    detail: `On host ${event.unit.data.host} at ${event.at.toISOString()}.`,
    runbook: 'backup-failed',
  }, `backup-${event.unit.data.database}`));

const operationalExperience = H.memory('operational-experience', 'fallible');
const opsJournal = H.library('ops-journal', operationalExperience, jsonl.memory('ops/experience.jsonl'));

const slowBackupMs = 2 * 60 * 60 * 1000;

const slowBackupNote = H.trigger('slow-backup-noted', H.on.enters(Backup, 'backed-up'), (event, act) => {
  const attempt = event.attempt;
  if (!attempt || attempt.durationMs <= slowBackupMs) return [];
  const hours = (attempt.durationMs / 3_600_000).toFixed(1);
  return act.remember(opsJournal, {
    text: `When planning maintenance on ${event.unit.data.host}, allow for the ${event.unit.data.database} backup running past two hours`,
    because: `it took ${hours} hours on ${event.at.toISOString().slice(0, 10)}`,
    when: { kinds: [Backup.name], resources: [event.unit.data.database, event.unit.data.host] },
    status: 'accepted',
  });
});

const isIncident = (unit: PendingView | ActiveView) => unit.kind === Incident.name;
const isBackup = (unit: PendingView | ActiveView) => unit.kind === Backup.name;

const incidentsFirst = H.policy.scheduler('incidents-preempt', view => {
  const incidentInPlay = view.active.some(isIncident) || view.pending.some(isIncident);
  const start = [...view.pending]
    .filter(unit => !(incidentInPlay && isBackup(unit)))
    .sort((a, b) => Number(isIncident(b)) - Number(isIncident(a)) || b.waitedMs - a.waitedMs);
  const preempt = view.pending.some(isIncident)
    ? view.active.filter(unit => !isIncident(unit) && !isBackup(unit))
    : [];
  return { start, preempt };
});

const controlApi = http.control({
  port: H.slot.port(0),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry, H.ops.recoverAttempts],
});

const incidentToSlack = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === Incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'new'} → ${entry.to}`
      : null,
});

export default H.harness('operations')
  .ledger(sqlite.ledger('.harness/ops-ledger.sqlite'))
  .lanes(incidents, heartbeats, backups, certificates)
  .triggers(heartbeatSchedule, backupSchedule, certificateSchedule, threeFailedHeartbeats, failedBackup, slowBackupNote)
  .scheduler(incidentsFirst)
  .clients(controlApi)
  .observers(incidentToSlack, markdown.board('BOARD.md'));
