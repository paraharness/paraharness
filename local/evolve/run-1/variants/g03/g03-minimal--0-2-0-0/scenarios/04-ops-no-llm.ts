import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { z } from 'zod';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const due = H.state('due', 'pending');
const up = H.state('up', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');
const backedUp = H.state('backed-up', 'terminal', 'success');
const backupFailed = H.state('backup-failed', 'terminal', 'failure');
const valid = H.state('valid', 'terminal', 'success');
const renewed = H.state('renewed', 'terminal', 'success');
const renewalFailed = H.state('renewal-failed', 'terminal', 'failure');
const open = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');

const Heartbeat = H.kind('Heartbeat').data(z.object({ service: z.string() })).states(due, up, down);
const Backup = H.kind('Backup')
  .data(z.object({ database: z.string() }))
  .states(due, backedUp, backupFailed)
  .failsTo('backup-failed');
const CertificateRenewal = H.kind('CertificateRenewal')
  .data(z.object({ domain: z.string() }))
  .states(due, valid, renewed, renewalFailed)
  .failsTo('renewal-failed');
const Incident = H.kind('Incident')
  .data(z.object({ title: z.string(), detail: z.string(), runbook: z.string(), target: z.string() }))
  .states(open, resolved);

const databaseTag = H.tag('database');
const operational = H.memory('operational-experience', 'experience');
const opsJournal = H.archive('ops-journal', operational, jsonl.memory('memory/operations.jsonl'));

const sshKey = H.env('OPS_SSH_KEY');
const diskPreflight = ['test "$(df --output=avail /var/backups | tail -1)" -gt 52428800'];
const localRunner = shell.local('local', { slots: 4 });
const hostA = ssh.host('ops-a', { address: 'ops-a.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskPreflight });
const hostB = ssh.host('ops-b', { address: 'ops-b.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskPreflight });

const probe = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(localRunner)
  .recovers('rerun');

const backupDatabase = H.command('backup-database')
  .input(z.object({ database: z.string() }))
  .argv((input) => ['pg-backup', '--database', input.database])
  .on(hostA, hostB)
  .recovers('rerun');

const checkExpiry = H.command('check-certificate-expiry')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv((input) => ['cert-days-left', input.domain])
  .on(hostA, hostB)
  .recovers('rerun');

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv((input) => ['certbot', 'renew', '--cert-name', input.domain])
  .on(hostA, hostB)
  .recovers('park');

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv((input) => ['pager', 'trigger', '--summary', input.title])
  .on(localRunner)
  .recovers('park');

const runbook = H.command('run-runbook')
  .input(z.object({ runbook: z.string(), target: z.string() }))
  .argv((input) => ['runbook', input.runbook, '--target', input.target])
  .on(localRunner)
  .recovers('park');

const acknowledgement = H.halt('incident-acknowledgement', z.object({ by: z.string() }));
const resolutionCheck = H.halt('incident-resolution', z.object({ resolved: z.boolean(), notes: z.string().optional() }));

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async (ctx) => {
    const result = await ctx.run(probe, { service: ctx.unit.data.service });
    return result.ok ? 'up' : 'down';
  });

const backupFlow = H.flow('backup')
  .for(Backup)
  .does(async (ctx) => {
    const result = await ctx.run(backupDatabase, { database: ctx.unit.data.database });
    if (result.ok === false) return ctx.fail(result.error, 'backup-failed');
    return 'backed-up';
  });

const renewalThresholdDays = 14;

const renewalFlow = H.flow('certificate-renewal')
  .for(CertificateRenewal)
  .does(async (ctx) => {
    const { domain } = ctx.unit.data;
    const expiry = await ctx.run(checkExpiry, { domain });
    if (expiry.ok === false) return ctx.fail(expiry.error);
    if (expiry.value.daysLeft >= renewalThresholdDays) return 'valid';
    const renewal = await ctx.run(renewCertificate, { domain });
    if (renewal.ok === false) return ctx.fail(renewal.error, 'renewal-failed');
    return 'renewed';
  });

const incidentFlow = H.flow('incident-runbook')
  .for(Incident)
  .does(async (ctx) => {
    const { title, detail, target } = ctx.unit.data;
    await ctx.run(pageOnCall, { title });
    await ctx.halt(acknowledgement, `${title}\n\n${detail}`);
    const ran = await ctx.run(runbook, { runbook: ctx.unit.data.runbook, target });
    const report = ran.ok ? `Runbook finished: ${ran.value}` : `Runbook failed: ${ran.error}`;
    const confirmation = await ctx.halt(resolutionCheck, `${title}\n\n${report}`);
    return confirmation.resolved ? 'resolved' : 'open';
  });

const services = ['api', 'web', 'worker'];
const databases = ['orders', 'accounts'];
const domains = ['example.com', 'api.example.com'];

const heartbeatClock = H.clock('heartbeat-every-five-minutes', Heartbeat, { every: { minutes: 5 } }, (tick) =>
  services.map((service) => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
);
const backupClock = H.clock('nightly-backup', Backup, { daily: '01:00' }, (tick) =>
  databases.map((database) => ({ create: { database }, key: `${database}-${tick.now.toISOString().slice(0, 10)}` }))
);
const renewalClock = H.clock('weekly-certificate-check', CertificateRenewal, { weekly: { day: 'sun', at: '04:00' } }, (tick) =>
  domains.map((domain) => ({ create: { domain }, key: `${domain}-${tick.now.toISOString().slice(0, 10)}` }))
);

const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(heartbeatClock);
const backups = H.lane('backups', Backup)
  .handler(backupFlow)
  .suppliers(backupClock)
  .store(sqlite.store(Backup, '.harness/work.db'));
const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .handler(renewalFlow)
  .suppliers(renewalClock)
  .store(sqlite.store(CertificateRenewal, '.harness/work.db'));
const incidents = H.lane('incidents', Incident)
  .handler(incidentFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Incident, '.harness/work.db'));

const heartbeatStreak = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(Heartbeat, 'down', 3, (data) => data.service),
  (event, act) =>
    act.create(
      incidents,
      {
        title: `${event.unit.data.service} failed three heartbeats`,
        detail: `Last failure at ${event.at.toISOString()}.`,
        runbook: 'restart-service',
        target: event.unit.data.service,
      },
      `heartbeat-${event.unit.data.service}`
    )
);

const failedBackup = H.trigger('failed-backup-opens-incident', H.on.enters(Backup, 'backup-failed'), (event, act) =>
  act.create(
    incidents,
    {
      title: `Backup of ${event.unit.data.database} failed`,
      detail: `Backup failed at ${event.at.toISOString()}.`,
      runbook: 'retry-backup',
      target: event.unit.data.database,
    },
    `backup-${event.unit.data.database}`
  )
);

const slowBackupMs = 2 * 60 * 60 * 1000;

const slowBackup = H.trigger('slow-backup-records-note', H.on.enters(Backup, 'backed-up'), (event, act) => {
  const durationMs = event.attempt ? event.attempt.durationMs : 0;
  if (durationMs <= slowBackupMs) return [];
  const minutes = Math.round(durationMs / 60_000);
  return act.remember(opsJournal, {
    text: `When scheduling the ${event.unit.data.database} backup, allow at least ${minutes} minutes`,
    because: `the backup of ${event.at.toISOString().slice(0, 10)} took ${minutes} minutes`,
    when: { kinds: [Backup], tags: [databaseTag.is(event.unit.data.database)] },
  });
});

const incidentsFirst = H.policy.scheduler('incidents-preempt', (view) => {
  const incidentWaiting = view.pending.some((unit) => unit.lane === incidents.name);
  const incidentOpen = incidentWaiting || view.active.some((unit) => unit.lane === incidents.name);
  const rank = (unit: PendingView): number => {
    if (unit.lane === incidents.name) return 0;
    if (unit.lane === heartbeats.name) return 1;
    if (unit.lane === renewals.name) return 2;
    return 3;
  };
  const start = [...view.pending]
    .filter((unit) => (incidentOpen ? unit.lane === backups.name === false : true))
    .sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs);
  const localBusy = view.active.filter(
    (unit) => unit.blocked === false && unit.runners.includes(localRunner.name)
  );
  const preempt =
    incidentWaiting && localBusy.length >= localRunner.slots
      ? localBusy.filter((unit) => unit.lane === heartbeats.name || unit.lane === renewals.name)
      : [];
  return { start, preempt };
});

const control = http.control({
  port: 8443,
  token: H.env('CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
});

const incidentAlerts = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  on: { entry: 'transition', kind: Incident },
  message: (entry) => `Incident ${entry.unit ?? 'unknown'}: ${entry.from ?? 'created'} -> ${entry.to}`,
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(heartbeatStreak, failedBackup, slowBackup)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentAlerts, markdown.board('BOARD.md'));
