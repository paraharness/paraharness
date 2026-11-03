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

const Due = H.state('due', 'pending');
const Healthy = H.state('healthy', 'terminal', 'success');
const Unhealthy = H.state('unhealthy', 'terminal', 'failure');

const BackupDone = H.state('backed-up', 'terminal', 'success');
const BackupFailed = H.state('backup-failed', 'terminal', 'failure');

const Valid = H.state('valid', 'terminal', 'success');
const Renewed = H.state('renewed', 'terminal', 'success');
const RenewalFailed = H.state('renewal-failed', 'terminal', 'failure');

const Open = H.state('open', 'pending');
const Unresolved = H.state('unresolved', 'pending');
const Resolved = H.state('resolved', 'terminal', 'success');

const Heartbeat = H.kind('heartbeat').data(z.object({ service: z.string() })).states(Due, Healthy, Unhealthy);
const Backup = H.kind('backup').data(z.object({ database: z.string() })).states(Due, BackupDone, BackupFailed);
const CertificateRenewal = H.kind('certificate-renewal')
  .data(z.object({ domain: z.string() }))
  .states(Due, Valid, Renewed, RenewalFailed)
  .onFailure('renewal-failed', { afterAttempts: 3 });
const Incident = H.kind('incident').data(z.object({ title: z.string(), runbook: z.string() })).states(Open, Unresolved, Resolved);

const operationalMemory = H.memory('operational-experience', 'experience');
const operations = H.library('operational-experience', operationalMemory, jsonl.memory('memory/operations.jsonl'));

const local = shell.local('local', { slots: 4 });
const diskPreflight = ['test "$(df --output=avail -k /var/backups | tail -1)" -gt 20971520'];
const hostA = ssh.host('db-host-a', {
  address: 'db-a.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskPreflight,
});
const hostB = ssh.host('db-host-b', {
  address: 'db-b.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskPreflight,
});

const healthCheck = H.command('health-check')
  .input(z.object({ service: z.string() }))
  .argv(i => ['ops/health-check', i.service])
  .on(local)
  .recover('rerun');

const backupDatabase = H.command('backup-database')
  .input(z.object({ database: z.string() }))
  .argv(i => ['ops/backup', i.database])
  .on(hostA, hostB)
  .recover('park');

const certificateDays = H.command('certificate-days')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(i => ['ops/certificate-days', i.domain])
  .on(hostA, hostB)
  .recover('rerun');

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv(i => ['ops/renew-certificate', i.domain])
  .on(hostA, hostB)
  .recover('rerun');

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(i => ['ops/page', i.title])
  .on(local)
  .recover('park');

const runRunbook = H.command('run-runbook')
  .input(z.object({ runbook: z.string() }))
  .argv(i => ['ops/runbook', i.runbook])
  .on(local)
  .recover('park');

const acknowledge = H.decision('acknowledge-incident')
  .input(z.object({ title: z.string() }))
  .output(z.object({ acknowledgedBy: z.string() }))
  .show(i => `Acknowledge: ${i.title}`);

const confirmResolution = H.decision('confirm-resolution')
  .input(z.object({ title: z.string(), runbookOutput: z.string() }))
  .output(z.object({ resolved: z.boolean() }))
  .show(i => `${i.title}\n\n${i.runbookOutput}`);

const heartbeatFlow = H.flow('heartbeat').for(Heartbeat).does(async ctx => {
  const check = await ctx.run(healthCheck, { service: ctx.unit.data.service });
  return check.ok ? 'healthy' : 'unhealthy';
});

const backupFlow = H.flow('backup').for(Backup).does(async ctx => {
  const backup = await ctx.run(backupDatabase, { database: ctx.unit.data.database });
  return backup.ok ? 'backed-up' : 'backup-failed';
});

const renewalFlow = H.flow('certificate-renewal').for(CertificateRenewal).does(async ctx => {
  const domain = ctx.unit.data.domain;
  const days = await ctx.run(certificateDays, { domain });
  if (days.ok === false) return ctx.fail(days.error);
  if (days.value.daysLeft >= 14) return 'valid';
  const renewal = await ctx.run(renewCertificate, { domain });
  if (renewal.ok === false) return ctx.fail(renewal.error);
  return 'renewed';
});

const respondToIncident = H.flow('respond-to-incident').for(Incident).does(async ctx => {
  const { title, runbook } = ctx.unit.data;
  const paged = await ctx.run(pageOnCall, { title });
  if (paged.ok === false) return ctx.fail(paged.error);
  await ctx.decide(acknowledge, { title });
  const ran = await ctx.run(runRunbook, { runbook });
  const confirmation = await ctx.decide(confirmResolution, { title, runbookOutput: ran.ok ? ran.value : ran.error });
  return confirmation.resolved ? 'resolved' : 'unresolved';
});

const followUpIncident = H.flow('follow-up-incident').for(Incident).does(async ctx => {
  const { title, runbook } = ctx.unit.data;
  const ran = await ctx.run(runRunbook, { runbook });
  const confirmation = await ctx.decide(confirmResolution, { title, runbookOutput: ran.ok ? ran.value : ran.error });
  return confirmation.resolved ? 'resolved' : 'unresolved';
});

const services = ['api', 'auth', 'billing'];
const databases = ['orders', 'customers', 'events'];
const domains = ['example.com', 'api.example.com'];

const heartbeatClock = H.clock('heartbeat-clock', Heartbeat, { every: { minutes: 5 } }, tick =>
  services.map(service => ({ create: { service }, key: `${service}@${tick.now.toISOString()}` }))
);
const backupClock = H.clock('backup-clock', Backup, { daily: '01:00' }, tick =>
  databases.map(database => ({ create: { database }, key: `${database}@${tick.now.toISOString().slice(0, 10)}` }))
);
const renewalClock = H.clock('renewal-clock', CertificateRenewal, { weekly: { day: 'mon', at: '04:00' } }, tick =>
  domains.map(domain => ({ create: { domain }, key: `${domain}@${tick.now.toISOString().slice(0, 10)}` }))
);

const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(heartbeatClock);
const backups = H.lane('backups', Backup).handler(backupFlow).suppliers(backupClock);
const renewals = H.lane('certificate-renewals', CertificateRenewal).handler(renewalFlow).suppliers(renewalClock);
const incidents = H.lane('incidents', Incident)
  .handler({ open: respondToIncident, unresolved: followUpIncident })
  .suppliers(H.operator);

const threeFailedHeartbeats = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(Heartbeat, 'unhealthy', 3, data => data.service),
  (event, act) =>
    act.create(
      incidents,
      { title: `${event.unit.data.service} failed three heartbeats in a row`, runbook: `runbooks/${event.unit.data.service}-down` },
      `heartbeat-${event.unit.data.service}`
    )
);

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident', H.on.enters(Backup, 'backup-failed'), (event, act) =>
  act.create(
    incidents,
    { title: `Backup of ${event.unit.data.database} failed`, runbook: `runbooks/backup-${event.unit.data.database}` },
    `backup-${event.unit.key}`
  )
);

const twoHoursMs = 2 * 3600_000;
const slowBackupNotesExperience = H.trigger('slow-backup-notes-experience', H.on.enters(Backup, 'backed-up'), (event, act) => {
  const tookMs = event.attempt === undefined ? 0 : event.attempt.durationMs;
  if (tookMs <= twoHoursMs) return [];
  return act.remember(operations, {
    text: `When scheduling the backup of ${event.unit.data.database}, allow more than two hours`,
    because: `the backup finished on ${event.at.toISOString()} took ${Math.round(tookMs / 60_000)} minutes`,
    when: { kinds: [Backup.name], resources: [event.unit.data.database] },
    status: 'accepted',
  });
});

const rank = (unit: PendingView): number => {
  if (unit.is(Incident)) return 0;
  if (unit.is(Heartbeat)) return 1;
  if (unit.is(CertificateRenewal)) return 2;
  return 3;
};

const incidentsPreempt = H.policy.scheduler('incidents-preempt', view => {
  const incidentActive = view.active.some(a => a.is(Incident));
  const start = view.pending
    .filter(unit => (incidentActive && unit.is(Backup)) === false)
    .sort((a, b) => rank(a) - rank(b));
  const incidentWaiting = start.some(unit => unit.is(Incident));
  const localRunner = view.runners[local.name];
  const localFull = localRunner === undefined ? false : localRunner.used >= localRunner.slots;
  const preempt = incidentWaiting && localFull
    ? view.active.filter(a => a.is(Incident) === false && a.is(Backup) === false && a.runners.includes(local.name)).slice(0, 1)
    : [];
  return { start, preempt };
});

const control = http.control({
  port: 8420,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveDecisions, H.ops.readMemory, H.ops.readTelemetry],
});

const incidentToSlack = slack.notify({
  webhook: H.env('SLACK_INCIDENT_WEBHOOK'),
  among: { entry: 'transition', kind: Incident },
  message: entry => (entry.entry === 'transition'
    ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'new'} -> ${entry.to}`
    : `Incident event: ${entry.entry}`),
});

export const operationsHarness = H.harness('operations')
  .ledger(sqlite.ledger('harness/operations.sqlite'))
  .lanes(heartbeats, backups, renewals, incidents)
  .triggers(threeFailedHeartbeats, failedBackupOpensIncident, slowBackupNotesExperience)
  .scheduler(incidentsPreempt)
  .clients(control)
  .observers(incidentToSlack, markdown.board('BOARD.md'));
