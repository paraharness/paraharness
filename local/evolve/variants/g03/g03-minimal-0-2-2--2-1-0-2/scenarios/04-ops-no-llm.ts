import { z } from 'zod';
import { H, type PendingView } from 'harness-dsl';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';

const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');
const scheduled = H.state('scheduled', 'pending');
const backedUp = H.state('backed-up', 'terminal', 'success');
const backupFailed = H.state('backup-failed', 'terminal', 'failure');
const checkDue = H.state('check-due', 'pending');
const stillValid = H.state('still-valid', 'terminal', 'success');
const renewed = H.state('renewed', 'terminal', 'success');
const renewalFailed = H.state('renewal-failed', 'terminal', 'failure');
const open = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');
const unresolved = H.state('unresolved', 'terminal', 'failure');

const heartbeat = H.kind('heartbeat').data(z.object({ service: z.string() })).states(due, healthy, unhealthy);
const backup = H.kind('backup').data(z.object({ database: z.string() })).states(scheduled, backedUp, backupFailed);
const renewal = H.kind('certificate-renewal')
  .data(z.object({ domain: z.string() }))
  .states(checkDue, stillValid, renewed, renewalFailed);
const incident = H.kind('incident')
  .data(z.object({ title: z.string(), source: z.string(), service: z.string().optional() }))
  .states(open, resolved, unresolved);

const services = ['api', 'web', 'worker'];
const databases = ['orders', 'accounts'];
const domains = ['example.com', 'api.example.com'];

const local = shell.local('local', { slots: 4 });
const diskSpacePreflight = H.command('disk-space-preflight').argv(() => [
  'sh',
  '-c',
  'test "$(df --output=avail -k /var/backups | tail -1)" -gt 20971520',
]);
const dbHostOne = ssh.host('db-host-1', {
  address: 'db1.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskSpacePreflight,
});
const dbHostTwo = ssh.host('db-host-2', {
  address: 'db2.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskSpacePreflight,
});

const serviceProbe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local);

const runBackup = H.command('run-backup')
  .input(z.object({ database: z.string() }))
  .argv(input => ['backup-db', input.database])
  .on(dbHostOne, dbHostTwo)
  .recovery('rerun');

const certificateDays = H.command('certificate-days-left')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['cert-days-left', input.domain])
  .on(dbHostOne, dbHostTwo);

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv(input => ['renew-cert', input.domain])
  .on(dbHostOne, dbHostTwo)
  .recovery('rerun');

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(input => ['page', '--rotation', 'platform', '--message', input.title])
  .on(local)
  .recovery('park');

const runbook = H.command('incident-runbook')
  .input(z.object({ title: z.string(), service: z.string().optional() }))
  .argv(input => ['runbook', '--service', input.service ?? 'unknown', '--title', input.title])
  .on(local);

const acknowledgement = H.halt('incident-acknowledgement', z.object({ by: z.string() }));
const resolutionConfirmation = H.halt('incident-resolution', z.object({ resolved: z.boolean(), note: z.string().optional() }));

const heartbeatCheck = H.flow('heartbeat-check')
  .for(heartbeat)
  .does(async ctx => {
    const probe = await ctx.run(serviceProbe, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : 'unhealthy';
  });

const backupDatabase = H.flow('backup-database')
  .for(backup)
  .does(async ctx => {
    const result = await ctx.run(runBackup, { database: ctx.unit.data.database });
    return result.ok ? 'backed-up' : 'backup-failed';
  });

const renewWhenExpiring = H.flow('renew-when-expiring')
  .for(renewal)
  .does(async ctx => {
    const check = await ctx.run(certificateDays, { domain: ctx.unit.data.domain });
    if (check.ok === false) return ctx.fail(check.error);
    if (check.value.daysLeft >= 14) return 'still-valid';
    const renewal = await ctx.run(renewCertificate, { domain: ctx.unit.data.domain });
    return renewal.ok ? 'renewed' : 'renewal-failed';
  });

const runbookRounds = 3;

const handleIncident = H.flow('incident-runbook')
  .for(incident)
  .does(async ctx => {
    const data = ctx.unit.data;
    await ctx.run(pageOnCall, { title: data.title });
    await ctx.halt(acknowledgement, `Acknowledge incident: ${data.title}`);
    for (let round = 1; round <= runbookRounds; round++) {
      await ctx.run(runbook, { title: data.title, service: data.service });
      const confirmation = await ctx.halt(resolutionConfirmation, `Runbook round ${round} finished for: ${data.title}`);
      if (confirmation.resolved) return 'resolved';
    }
    return 'unresolved';
  });

const heartbeatSchedule = H.schedule('heartbeat-every-five-minutes', heartbeat, { every: { minutes: 5 } }, () =>
  services.map(service => ({ create: { service } }))
);
const nightlyBackups = H.schedule('nightly-backups', backup, { daily: '01:00' }, tick =>
  databases.map(database => ({ create: { database }, key: `${database}-${tick.now.toISOString().slice(0, 10)}` }))
);
const weeklyCertificateCheck = H.schedule(
  'weekly-certificate-check',
  renewal,
  { weekly: { day: 'mon', at: '04:00' } },
  tick => domains.map(domain => ({ create: { domain }, key: `${domain}-${tick.now.toISOString().slice(0, 10)}` }))
);

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(heartbeatCheck)
  .retries(0, { exhausted: 'unhealthy' })
  .suppliers(heartbeatSchedule);
const backups = H.lane('backups', backup)
  .handler(backupDatabase)
  .retries(0, { exhausted: 'backup-failed' })
  .suppliers(nightlyBackups)
  .store(sqlite.store(backup, '.harness/ops-units.db'));
const renewals = H.lane('certificate-renewals', renewal)
  .handler(renewWhenExpiring)
  .retries(2, { backoff: { first: { minutes: 30 }, factor: 2 }, exhausted: 'renewal-failed' })
  .suppliers(weeklyCertificateCheck);
const incidents = H.lane('incidents', incident)
  .handler(handleIncident)
  .retries(0, { exhausted: 'unresolved' })
  .suppliers(H.operator)
  .store(sqlite.store(incident, '.harness/ops-units.db'));

const operationalExperience = H.memory('operational-experience', 'experience');
const opsJournal = H.journal('ops-notes', operationalExperience, jsonl.memory('memory/ops.jsonl'));

const twoHoursMs = 2 * 60 * 60 * 1000;

const heartbeatStreakOpensIncident = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(heartbeat, 'unhealthy', 3, data => data.service),
  (event, act) =>
    act.create(
      incidents,
      { title: `${event.unit.data.service} failed three heartbeats in a row`, source: 'heartbeat', service: event.unit.data.service },
      `heartbeat-${event.unit.data.service}`
    )
);

const failedBackupOpensIncident = H.trigger(
  'failed-backup-opens-incident',
  H.on.enters(backup, 'backup-failed'),
  (event, act) =>
    act.create(incidents, { title: `Backup of ${event.unit.data.database} failed`, source: 'backup' }, `backup-${event.unit.key}`)
);

const slowBackupNote = H.trigger('slow-backup-note', H.on.enters(backup, 'backed-up'), (event, act) =>
  event.attempt && event.attempt.durationMs > twoHoursMs
    ? act.remember(opsJournal, {
        text: `When scheduling the ${event.unit.data.database} backup, allow more than two hours or move it earlier`,
        because: `backup ${event.unit.key} succeeded but took ${Math.round(event.attempt.durationMs / 60000)} minutes`,
        when: { kinds: [backup] },
      })
    : []
);

const incidentsFirst = H.policy.scheduler('incidents-first', view => {
  const incidentOpen = view.live.some(unit => unit.is(incident)) || view.pending.some(unit => unit.is(incident));
  const incidentWaiting = view.pending.some(unit => unit.is(incident));
  const rank = (unit: PendingView): number =>
    unit.is(incident) ? 0 : unit.is(heartbeat) ? 1 : unit.is(renewal) ? 2 : 3;
  const start = view.pending
    .filter(unit => incidentOpen === false || unit.is(backup) === false)
    .sort((a, b) => rank(a) - rank(b));
  const preempt = incidentWaiting
    ? view.live.filter(unit => unit.is(renewal) && unit.position === 'active')
    : [];
  return { start, preempt };
});

const control = http.control({
  port: 8080,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
});

const incidentChannel = slack.notify({
  webhook: H.env('SLACK_INCIDENT_WEBHOOK'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'created'} -> ${entry.to}`
      : null,
});

export const harness = H.harness('platform-ops')
  .ledger(sqlite.ledger('.harness/ops.db'))
  .lanes(heartbeats, backups, renewals, incidents)
  .triggers(heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupNote)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentChannel, markdown.board('BOARD.md'));

export const running = harness.start();
