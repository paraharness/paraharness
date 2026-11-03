import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { z } from 'zod';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';

const databaseSchema = z.enum(['orders', 'users', 'analytics']);
type Database = z.infer<typeof databaseSchema>;
const database = H.facet('database', ['orders', 'users', 'analytics']);
const databases: readonly Database[] = ['orders', 'users', 'analytics'];
const services = ['api', 'web', 'queue'];
const domains = ['example.com', 'api.example.com'];
const slowBackupMs = 2 * 60 * 60_000;

const Heartbeat = H.kind('Heartbeat')
  .data(z.object({ service: z.string() }))
  .states(H.state('checking', 'pending'), H.state('healthy', 'terminal', 'success'), H.state('down', 'terminal', 'failure'));

const Backup = H.kind('Backup')
  .data(z.object({ database: databaseSchema, night: z.string() }))
  .states(H.state('due', 'pending'), H.state('backed-up', 'terminal', 'success'), H.state('failed', 'terminal', 'failure'))
  .failsTo('failed');

const CertificateRenewal = H.kind('CertificateRenewal')
  .data(z.object({ domain: z.string() }))
  .states(
    H.state('due', 'pending'),
    H.state('still-valid', 'terminal', 'neutral'),
    H.state('renewed', 'terminal', 'success'),
    H.state('failed', 'terminal', 'failure')
  )
  .failsTo('failed');

const Incident = H.kind('Incident')
  .data(z.object({ title: z.string(), detail: z.string() }))
  .states(H.state('open', 'pending'), H.state('acknowledged', 'active'), H.state('resolved', 'terminal', 'success'));

const operationalKind = H.memory('operational-experience', 'experience');
const operationsJournal = H.archive('operations-journal', operationalKind, jsonl.memory('memory/operations.jsonl'));

const local = shell.local('local', { slots: 4 });
const diskPreflight = ['check-free-disk', '--path', '/var/backups', '--min-gb', '50'];
const dbHostA = ssh.host('db-host-a', {
  address: 'db-a.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskPreflight,
});
const dbHostB = ssh.host('db-host-b', {
  address: 'db-b.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskPreflight,
});

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['curl', '-fsS', '--max-time', '10', `https://${input.service}.internal/health`])
  .on(local)
  .recovers('rerun');

const backupDatabase = H.command('backup-database')
  .input(z.object({ database: databaseSchema, night: z.string() }))
  .argv((input) => ['backup-db', '--database', input.database, '--label', input.night])
  .on(dbHostA, dbHostB)
  .recovers('rerun');

const certificateDaysLeft = H.command('certificate-days-left')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv((input) => ['cert-days-left', '--domain', input.domain, '--json'])
  .on(dbHostA, dbHostB)
  .recovers('rerun');

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv((input) => ['renew-cert', '--domain', input.domain])
  .on(dbHostA, dbHostB)
  .recovers('rerun');

const runbook = H.command('incident-runbook')
  .input(z.object({ incident: z.string(), title: z.string() }))
  .argv((input) => ['run-runbook', '--incident', input.incident, '--title', input.title])
  .on(local);

const acknowledge = H.halt('incident-acknowledgement', z.object({ by: z.string() }));
const confirmResolution = H.halt('incident-resolution', z.object({ note: z.string() }));

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async (ctx) => {
    const probed = await ctx.run(probeService, { service: ctx.unit.data.service });
    return probed.ok ? 'healthy' : 'down';
  });

const backupFlow = H.flow('backup')
  .for(Backup)
  .does(async (ctx) => {
    ctx.facet(database, ctx.unit.data.database);
    const backed = await ctx.run(backupDatabase, { database: ctx.unit.data.database, night: ctx.unit.data.night });
    return backed.ok ? 'backed-up' : ctx.fail(backed.error);
  });

const renewalFlow = H.flow('certificate-renewal')
  .for(CertificateRenewal)
  .does(async (ctx) => {
    const domain = ctx.unit.data.domain;
    const checked = await ctx.run(certificateDaysLeft, { domain });
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.daysLeft >= 14) return 'still-valid';
    const renewed = await ctx.run(renewCertificate, { domain });
    return renewed.ok ? 'renewed' : ctx.fail(renewed.error);
  });

const incidentFlow = H.flow('incident')
  .for(Incident)
  .does(async (ctx) => {
    const incident = ctx.unit.data;
    await ctx.halt(acknowledge, `Incident: ${incident.title}\n${incident.detail}`);
    await ctx.move('acknowledged');
    const ran = await ctx.run(runbook, { incident: ctx.unit.key, title: incident.title });
    const report = ran.ok ? `Runbook finished:\n${ran.value}` : `Runbook failed: ${ran.error}`;
    await ctx.halt(confirmResolution, `${report}\n\nConfirm the incident is resolved.`);
    return 'resolved';
  });

const noRetry = H.policy.retry('no-retry', () => 'stop');
const renewalRetry = H.policy.retry('renewal-retry', ({ failures }) => (failures >= 3 ? 'stop' : { retryInMs: 60 * 60_000 }));

const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatFlow)
  .suppliers(
    H.clock('heartbeat-clock', Heartbeat, { every: { minutes: 5 } }, (tick) =>
      services.map((service) => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
    )
  );

const backups = H.lane('backups', Backup)
  .handler(backupFlow)
  .suppliers(
    H.clock('backup-clock', Backup, { daily: '01:00' }, (tick) => {
      const night = tick.now.toISOString().slice(0, 10);
      return databases.map((name) => ({ create: { database: name, night }, key: `${name}-${night}` }));
    })
  )
  .store(sqlite.store(Backup, '.harness/ops.db'))
  .retry(noRetry);

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .handler(renewalFlow)
  .suppliers(
    H.clock('renewal-clock', CertificateRenewal, { weekly: { day: 'sun', at: '03:00' } }, (tick) =>
      domains.map((domain) => ({ create: { domain }, key: `${domain}-${tick.now.toISOString().slice(0, 10)}` }))
    )
  )
  .retry(renewalRetry);

const incidents = H.lane('incidents', Incident)
  .handler(incidentFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Incident, '.harness/ops.db'));

const heartbeatStreak = H.trigger(
  'three-failed-heartbeats',
  H.on.streak(Heartbeat, 'down', 3, (data) => data.service),
  (event, act) =>
    act.create(
      incidents,
      {
        title: `${event.unit.data.service} is down`,
        detail: `Three consecutive heartbeats of ${event.unit.data.service} failed, the last at ${event.at.toISOString()}.`,
      },
      `heartbeat-${event.unit.data.service}`
    )
);

const failedBackup = H.trigger('failed-backup', H.on.enters(Backup, 'failed'), (event, act) =>
  act.create(
    incidents,
    {
      title: `Backup of ${event.unit.data.database} failed`,
      detail: `The ${event.unit.data.night} backup of ${event.unit.data.database} failed and will not retry.`,
    },
    `backup-${event.unit.key}`
  )
);

const slowBackup = H.trigger('slow-backup', H.on.enters(Backup, 'backed-up'), (event, act) => {
  const durationMs = event.attempt?.durationMs ?? 0;
  if (durationMs <= slowBackupMs) return [];
  return act.remember(operationsJournal, {
    text: `When scheduling the ${event.unit.data.database} backup, start it earlier or split it`,
    because: `the ${event.unit.data.night} run took ${Math.round(durationMs / 60_000)} minutes`,
    when: { kinds: [Backup], facets: [database.is(event.unit.data.database)] },
  });
});

const incidentsFirst = H.policy.scheduler('incidents-first', (view) => {
  const incidentWaiting = view.pending.some((unit) => unit.lane === incidents.name);
  const incidentOpen = incidentWaiting || view.active.some((unit) => unit.lane === incidents.name);
  const rank = (unit: PendingView): number =>
    unit.lane === incidents.name ? 0 : unit.lane === heartbeats.name ? 1 : 2;
  const start = view.pending
    .filter((unit) => !(incidentOpen && unit.lane === backups.name))
    .sort((a, b) => rank(a) - rank(b));
  const preempt = incidentWaiting
    ? view.active.filter((unit) => unit.lane !== backups.name && unit.lane !== incidents.name)
    : [];
  return { start, preempt };
});

const control = http.control({
  port: 8080,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
});

const incidentPager = slack.notify({
  webhook: H.env('SLACK_INCIDENT_WEBHOOK'),
  on: { kind: Incident, entry: ['transition', 'halt'] },
  message: (entry) =>
    entry.entry === 'transition'
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'new'} -> ${entry.to}`
      : entry.entry === 'halt'
        ? `Incident ${entry.unit ?? ''} needs a human (${entry.halt}, ${entry.status})`
        : `Incident ${entry.unit ?? ''}: ${entry.entry}`,
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(heartbeatStreak, failedBackup, slowBackup)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentPager, markdown.board('BOARD.md'));
