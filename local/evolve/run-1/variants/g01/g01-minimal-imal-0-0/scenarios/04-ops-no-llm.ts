import { H, type PendingView } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';
import { z } from 'zod';

const host = z.enum(['db-1', 'db-2']);

export const Heartbeat = H.kind('Heartbeat')
  .data(z.object({ service: z.string() }))
  .states(
    [H.state('due', 'pending'), H.state('checking', 'active'), H.state('healthy', 'terminal', 'success'), H.state('unhealthy', 'terminal', 'failure')],
    { initial: 'due', afterFailure: 'unhealthy' }
  );

export const Backup = H.kind('Backup')
  .data(z.object({ database: z.string(), host }))
  .states(
    [H.state('due', 'pending'), H.state('backing-up', 'active'), H.state('backed-up', 'terminal', 'success'), H.state('failed', 'terminal', 'failure')],
    { initial: 'due', afterFailure: 'failed' }
  );

export const CertificateRenewal = H.kind('CertificateRenewal')
  .data(z.object({ domain: z.string(), host }))
  .states(
    [
      H.state('due', 'pending'),
      H.state('checking', 'active'),
      H.state('renewing', 'active'),
      H.state('still-valid', 'terminal', 'neutral'),
      H.state('renewed', 'terminal', 'success'),
      H.state('failed', 'terminal', 'failure'),
    ],
    { initial: 'due', afterFailure: 'failed' }
  );

export const Incident = H.kind('Incident')
  .data(z.object({ title: z.string(), source: z.enum(['heartbeat', 'backup', 'operator']), service: z.string().optional() }))
  .states(
    [H.state('open', 'pending'), H.state('responding', 'active'), H.state('resolved', 'terminal', 'success'), H.state('unresolved', 'terminal', 'failure')],
    { initial: 'open', afterFailure: 'unresolved' }
  );

const local = shell.local('local', { slots: 4 });
const diskPreflight = ['test "$(df --output=avail -BG /var/backups | tail -1 | tr -dc 0-9)" -ge 50'];
const hostOne = ssh.host('db-1', { address: 'db-1.internal', user: 'ops', key: H.env('SSH_KEY'), slots: 1, preflight: diskPreflight });
const hostTwo = ssh.host('db-2', { address: 'db-2.internal', user: 'ops', key: H.env('SSH_KEY'), slots: 1, preflight: diskPreflight });
const onHost = (input: { readonly host: 'db-1' | 'db-2' }) => (input.host === 'db-1' ? hostOne : hostTwo);

const healthCheck = H.command('health-check')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./ops/health-check.sh', i.service])
  .on(local);

const backupDatabase = H.command('backup-database')
  .input(z.object({ database: z.string(), host }))
  .argv(i => ['/opt/ops/backup.sh', i.database])
  .on(onHost);

const certificateExpiry = H.command('certificate-expiry')
  .input(z.object({ domain: z.string(), host }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(i => ['/opt/ops/cert-days-left.sh', i.domain])
  .on(onHost);

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string(), host }))
  .argv(i => ['/opt/ops/renew-cert.sh', i.domain])
  .on(onHost);

const pageOnCall = H.command('page-on-call')
  .input(z.object({ incident: z.string(), title: z.string() }))
  .argv(i => ['./ops/page.sh', '--token', H.env('PAGER_TOKEN'), i.incident, i.title])
  .on(local);

const runbook = H.command('incident-runbook')
  .input(z.object({ incident: z.string(), service: z.string().optional() }))
  .argv(i => ['./ops/runbook.sh', i.incident, i.service ?? 'none'])
  .on(local);

const heartbeatFlow = H.flow('heartbeat').for(Heartbeat).does(async ctx => {
  await ctx.move('checking');
  const probe = await ctx.run(healthCheck, { service: ctx.unit.data.service });
  return probe.ok ? 'healthy' : ctx.fail(probe.error);
});

const backupFlow = H.flow('backup').for(Backup).does(async ctx => {
  await ctx.move('backing-up');
  const backed = await ctx.run(backupDatabase, ctx.unit.data);
  return backed.ok ? 'backed-up' : ctx.fail(backed.error);
});

const renewalFlow = H.flow('certificate-renewal').for(CertificateRenewal).does(async ctx => {
  await ctx.move('checking');
  const expiry = await ctx.run(certificateExpiry, ctx.unit.data);
  if (!expiry.ok) return ctx.fail(expiry.error);
  if (expiry.value.daysLeft >= 14) return 'still-valid';
  await ctx.move('renewing');
  const renewed = await ctx.run(renewCertificate, ctx.unit.data);
  return renewed.ok ? 'renewed' : ctx.fail(renewed.error);
});

const incidentFlow = H.flow('incident-runbook').for(Incident).does(async ctx => {
  await ctx.move('responding');
  const { title, service } = ctx.unit.data;
  await ctx.run(pageOnCall, { incident: ctx.unit.key, title });
  await ctx.halt({ name: 'acknowledge', show: title, decision: z.object({ by: z.string() }) });
  const ran = await ctx.run(runbook, { incident: ctx.unit.key, service });
  const confirmation = await ctx.halt({
    name: 'confirm-resolution',
    show: ran.ok ? ran.value : `runbook failed: ${ran.error}`,
    decision: z.object({ resolved: z.boolean() }),
  });
  return confirmation.resolved ? 'resolved' : 'open';
});

const services = ['api', 'queue', 'auth'];
const databases = [
  { database: 'orders', host: 'db-1' },
  { database: 'users', host: 'db-2' },
] as const satisfies readonly { readonly database: string; readonly host: 'db-1' | 'db-2' }[];
const domains = [
  { domain: 'example.com', host: 'db-1' },
  { domain: 'api.example.com', host: 'db-2' },
] as const satisfies readonly { readonly domain: string; readonly host: 'db-1' | 'db-2' }[];

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatFlow)
  .suppliers(H.calendar('heartbeats', Heartbeat, { every: { minutes: 5 } }, () =>
    services.map(service => ({ create: { service }, key: `heartbeat-${service}` }))
  ));

const backupLane = H.lane('backups', Backup)
  .handler(backupFlow)
  .suppliers(H.calendar('nightly-backups', Backup, { daily: '01:00' }, () =>
    databases.map(target => ({ create: { database: target.database, host: target.host }, key: `backup-${target.database}` }))
  ))
  .store(sqlite.store(Backup, '.harness/ops.db'));

const renewalLane = H.lane('certificates', CertificateRenewal)
  .handler(renewalFlow)
  .suppliers(H.calendar('weekly-certificate-check', CertificateRenewal, { weekly: { day: 'mon', at: '03:00' } }, () =>
    domains.map(target => ({ create: { domain: target.domain, host: target.host }, key: `certificate-${target.domain}` }))
  ));

const incidentLane = H.lane('incidents', Incident)
  .handler(incidentFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Incident, '.harness/ops.db'));

const operationalExperience = H.memory('operational-experience', 'fallible');
const opsLibrary = H.library('operational-experience', operationalExperience, jsonl.memory('.harness/ops-experience.jsonl'));

const twoHoursMs = 2 * 60 * 60 * 1000;

const repeatedHeartbeatFailure = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(Heartbeat, 'unhealthy', 3, data => data.service),
  (event, act) =>
    act.create(
      incidentLane,
      { title: `${event.unit.data.service} failed three heartbeats in a row`, source: 'heartbeat', service: event.unit.data.service },
      { key: `incident-heartbeat-${event.unit.data.service}` }
    )
);

const failedBackup = H.trigger('failed-backup-opens-incident', H.on.enters(Backup, 'failed'), (event, act) =>
  act.create(
    incidentLane,
    { title: `Backup of ${event.unit.data.database} failed`, source: 'backup', service: event.unit.data.database },
    { key: `incident-backup-${event.unit.data.database}` }
  )
);

const slowBackup = H.trigger('slow-backup-records-experience', H.on.enters(Backup, 'backed-up'), (event, act) => {
  const durationMs = event.attempt?.durationMs ?? 0;
  if (durationMs <= twoHoursMs) return [];
  return act.remember(opsLibrary, {
    text: `when planning work on ${event.unit.data.host} around the ${event.unit.data.database} backup, allow more than two hours`,
    because: `the backup finishing ${event.at.toISOString()} took ${Math.round(durationMs / 60000)} minutes`,
    when: { kinds: [Backup.name], resources: [event.unit.data.database, event.unit.data.host] },
    status: 'accepted',
  });
});

const kindPriority = new Map([
  [Incident.name, 0],
  [Heartbeat.name, 1],
  [Backup.name, 2],
  [CertificateRenewal.name, 3],
]);
const rank = (unit: PendingView) => kindPriority.get(unit.kind) ?? 9;
const isIncident = (unit: { readonly kind: string }) => unit.kind === Incident.name;

const incidentsPreempt = H.policy.scheduler('incidents-preempt', view => {
  const incidentWaitingToStart = view.pending.some(isIncident);
  const incidentOpen = incidentWaitingToStart || view.active.some(isIncident);
  const start = view.pending
    .filter(unit => !(incidentOpen && unit.kind === Backup.name))
    .sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs);
  const preempt = incidentWaitingToStart
    ? view.active.filter(unit => unit.kind === Heartbeat.name || unit.kind === CertificateRenewal.name)
    : [];
  return { start, preempt };
});

const incidentNotifications = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === Incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'created'} -> ${entry.to}`
      : null,
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidentLane, heartbeatLane, backupLane, renewalLane)
  .triggers(repeatedHeartbeatFailure, failedBackup, slowBackup)
  .scheduler(incidentsPreempt)
  .clients(http.control({
    port: H.slot.port(0),
    token: H.env('CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
  }))
  .observers(incidentNotifications, markdown.board('BOARD.md'));
