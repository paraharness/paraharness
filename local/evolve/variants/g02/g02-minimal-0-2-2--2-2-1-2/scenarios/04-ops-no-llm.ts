import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');
const backedUp = H.state('backed-up', 'terminal', 'success');
const stillValid = H.state('still-valid', 'terminal', 'success');
const renewed = H.state('renewed', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');
const open = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');
const unresolved = H.state('unresolved', 'terminal', 'failure');

const heartbeat = H.kind('heartbeat').data(z.object({ service: z.string() })).states(due, healthy, unhealthy);
const backup = H.kind('backup').data(z.object({ database: z.string() })).states(due, backedUp, failed);
const renewal = H.kind('certificate-renewal').data(z.object({ domain: z.string() })).states(due, stillValid, renewed, failed);
const incident = H.kind('incident').data(z.object({ title: z.string(), detail: z.string() })).states(open, resolved, unresolved);

const local = shell.local('local', { slots: 4 });

const diskSpacePreflight = H.command('disk-space-preflight').argv(() => [
  'sh',
  '-c',
  'test "$(df --output=avail -BG /var/backups | tail -1 | tr -dc 0-9)" -ge 50',
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

const probe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local);
const runBackup = H.command('run-backup')
  .input(z.object({ database: z.string() }))
  .argv(input => ['pg-backup', '--database', input.database])
  .on(dbHostOne, dbHostTwo);
const checkCertificate = H.command('check-certificate')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['cert-tool', 'days-left', input.domain])
  .on(dbHostOne, dbHostTwo);
const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv(input => ['cert-tool', 'renew', input.domain])
  .on(dbHostOne, dbHostTwo)
  .recovery('park');
const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(input => ['pager', 'page', '--rotation', 'platform', '--summary', input.title])
  .on(local)
  .recovery('park');
const runbook = H.command('incident-runbook')
  .input(z.object({ title: z.string() }))
  .argv(input => ['runbook', 'run', '--incident', input.title])
  .on(local)
  .recovery('park');

const acknowledgement = H.halt('incident-acknowledgement', z.object({ responder: z.string() }))
  .about(z.object({ title: z.string() }));
const resolution = H.halt('incident-resolution', z.object({ resolved: z.boolean(), note: z.string() }))
  .about(z.object({ title: z.string() }));

const heartbeatFlow = H.flow('heartbeat').for(heartbeat).does(async ctx => {
  const probed = await ctx.run(probe, { service: ctx.unit.data.service });
  return probed.ok ? 'healthy' : ctx.fail(probed.error);
});

const backupFlow = H.flow('backup').for(backup).does(async ctx => {
  const ran = await ctx.run(runBackup, { database: ctx.unit.data.database });
  return ran.ok ? 'backed-up' : ctx.fail(ran.error);
});

const renewalThresholdDays = 14;

const renewalFlow = H.flow('certificate-renewal').for(renewal).does(async ctx => {
  const { domain } = ctx.unit.data;
  const checked = await ctx.run(checkCertificate, { domain });
  if (!checked.ok) return ctx.fail(checked.error);
  if (checked.value.daysLeft >= renewalThresholdDays) return 'still-valid';
  const renewal = await ctx.run(renewCertificate, { domain });
  return renewal.ok ? 'renewed' : ctx.fail(renewal.error);
});

const incidentFlow = H.flow('incident-runbook').for(incident).does(async ctx => {
  const { title } = ctx.unit.data;
  const paged = await ctx.run(pageOnCall, { title });
  if (!paged.ok) return ctx.fail(paged.error);
  await ctx.halt(acknowledgement, `Acknowledge incident: ${title}`, { title });
  const ran = await ctx.run(runbook, { title });
  if (!ran.ok) return ctx.fail(ran.error);
  const confirmation = await ctx.halt(resolution, `Confirm resolution: ${title}`, { title });
  return confirmation.resolved ? 'resolved' : ctx.fail(confirmation.note);
});

const services = ['api', 'auth', 'billing'];
const databases = ['orders', 'customers'];
const domains = ['example.com', 'api.example.com'];

const heartbeatSchedule = H.clock('heartbeat-schedule', heartbeat, { every: { minutes: 5 } }, tick =>
  services.map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
);
const backupSchedule = H.clock('backup-schedule', backup, { daily: '01:00' }, tick =>
  databases.map(database => ({ create: { database }, key: `${database}-${tick.now.toISOString().slice(0, 10)}` }))
);
const renewalSchedule = H.clock('renewal-schedule', renewal, { weekly: { day: 'mon', at: '03:00' } }, tick =>
  domains.map(domain => ({ create: { domain }, key: `${domain}-${tick.now.toISOString().slice(0, 10)}` }))
);

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(heartbeatFlow, { retries: 0, exhausted: 'unhealthy' })
  .suppliers(heartbeatSchedule);
const backups = H.lane('backups', backup)
  .handler(backupFlow, { retries: 0, exhausted: 'failed' })
  .suppliers(backupSchedule);
const renewals = H.lane('renewals', renewal)
  .handler(renewalFlow, { retries: 2, backoff: { first: { minutes: 10 }, factor: 2 }, exhausted: 'failed' })
  .suppliers(renewalSchedule);
const incidents = H.lane('incidents', incident)
  .handler(incidentFlow, { retries: 2, exhausted: 'unresolved' })
  .suppliers(H.operator);

const operationsJournal = H.library(
  'operations-journal',
  H.memory('operational-experience', 'experience'),
  jsonl.memory('.harness/operations.jsonl')
);

const twoHoursMs = 2 * 60 * 60 * 1000;

const threeFailedHeartbeats = H.trigger(
  'three-failed-heartbeats',
  H.on.streak(heartbeat, 'unhealthy', 3, data => data.service),
  (event, act) =>
    act.create(
      incidents,
      {
        title: `${event.unit.data.service} failed three consecutive heartbeats`,
        detail: `Last failure at ${event.at.toISOString()}.`,
      },
      `heartbeat-${event.unit.data.service}`
    )
);

const backupFailure = H.trigger('backup-failure', H.on.enters(backup, 'failed'), (event, act) =>
  act.create(
    incidents,
    { title: `Backup of ${event.unit.data.database} failed`, detail: `Backup unit ${event.unit.key} failed.` },
    `backup-${event.unit.key}`
  )
);

const slowBackupNote = H.trigger('slow-backup-note', H.on.enters(backup, 'backed-up'), (event, act) =>
  event.attempt !== undefined && event.attempt.durationMs > twoHoursMs
    ? act.remember(operationsJournal, {
        text: `When the ${event.unit.data.database} backup is scheduled, start it on the less loaded host`,
        because: `the backup finishing at ${event.at.toISOString()} took ${Math.round(event.attempt.durationMs / 60000)} minutes`,
        when: { kinds: [backup] },
      })
    : []
);

const rank = (unit: PendingView): number =>
  unit.is(incident) ? 0 : unit.is(heartbeat) ? 1 : unit.is(renewal) ? 2 : 3;

const incidentsFirst = H.policy.scheduler('incidents-first', view => {
  const incidentPending = view.pending.some(unit => unit.is(incident));
  const incidentActive = incidentPending || view.live.some(unit => unit.is(incident));
  const start = view.pending
    .filter(unit => !(incidentActive && unit.is(backup)))
    .sort((a, b) => rank(a) - rank(b));
  const preempt = incidentPending
    ? view.live.filter(unit => unit.position === 'active' && (unit.is(heartbeat) || unit.is(renewal)))
    : [];
  return { start, preempt };
});

const control = http.control({
  port: 8787,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(acknowledgement, resolution, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.readTelemetry,
  ],
});

const incidentNotifications = slack.notify({
  webhook: H.env('SLACK_INCIDENT_WEBHOOK'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'created'} -> ${entry.to}`
      : null,
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, backups, renewals, incidents)
  .triggers(threeFailedHeartbeats, backupFailure, slowBackupNote)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentNotifications, markdown.board('BOARD.md'));
