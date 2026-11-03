import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const hour = 60 * 60 * 1000;
const slowBackupMs = 2 * hour;
const renewWithinDays = 14;

const due = H.state('due', 'pending');
const up = H.state('up', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');
const scheduled = H.state('scheduled', 'pending');
const backedUp = H.state('backedUp', 'terminal', 'success');
const backupFailed = H.state('backupFailed', 'terminal', 'failure');
const checkDue = H.state('checkDue', 'pending');
const stillValid = H.state('stillValid', 'terminal', 'success');
const renewed = H.state('renewed', 'terminal', 'success');
const renewalFailed = H.state('renewalFailed', 'terminal', 'failure');
const open = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');

const hostName = z.enum(['a', 'b']);
const heartbeatData = z.object({ service: z.string() });
const backupData = z.object({ database: z.string(), host: hostName });
const certificateData = z.object({ domain: z.string(), host: hostName });
const incidentData = z.object({ title: z.string(), source: z.string() });

const heartbeat = H.kind('Heartbeat').data(heartbeatData).states(due, up, down);
const backup = H.kind('Backup').data(backupData).states(scheduled, backedUp, backupFailed);
const certificate = H.kind('CertificateRenewal').data(certificateData).states(checkDue, stillValid, renewed, renewalFailed);
const incident = H.kind('Incident').data(incidentData).states(open, resolved);

const opsExperience = H.memory('operational-experience', 'experience');
const opsJournal = H.library('operational-journal', opsExperience, jsonl.memory('memory/operations.jsonl'));

const local = shell.local('local', { slots: 4 });
const diskSpacePreflight = ['test "$(df --output=avail -BG /var/backups | tail -1 | tr -dc 0-9)" -gt 20'];
const hosts = {
  a: ssh.host('db-host-a', { address: 'db-a.internal', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskSpacePreflight }),
  b: ssh.host('db-host-b', { address: 'db-b.internal', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskSpacePreflight }),
};

const probe = H.command('probe-service')
  .input(heartbeatData)
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .recovery('rerun');

const backupOn = (host: 'a' | 'b') =>
  H.command(`backup-on-${host}`)
    .input(backupData)
    .argv(input => ['pg-backup', '--database', input.database])
    .on(hosts[host])
    .recovery('rerun');
const backupCommands = { a: backupOn('a'), b: backupOn('b') };

const certificateCheckOn = (host: 'a' | 'b') =>
  H.command(`certificate-check-on-${host}`)
    .input(certificateData)
    .output(z.object({ daysLeft: z.number() }))
    .argv(input => ['cert-days-left', input.domain])
    .on(hosts[host])
    .recovery('rerun');
const certificateRenewOn = (host: 'a' | 'b') =>
  H.command(`certificate-renew-on-${host}`)
    .input(certificateData)
    .argv(input => ['cert-renew', input.domain])
    .on(hosts[host])
    .recovery('rerun');
const certificateChecks = { a: certificateCheckOn('a'), b: certificateCheckOn('b') };
const certificateRenewals = { a: certificateRenewOn('a'), b: certificateRenewOn('b') };

const pageOnCall = H.command('page-on-call')
  .input(incidentData)
  .argv(input => ['page-oncall', '--summary', input.title])
  .on(local)
  .recovery('rerun');

const runbook = H.command('run-runbook')
  .input(incidentData)
  .argv(input => ['run-runbook', '--for', input.source])
  .on(local)
  .recovery('park');

const acknowledgement = H.halt('incident-acknowledgement', z.object({ acknowledgedBy: z.string() })).about(incidentData);
const resolution = H.halt('incident-resolution', z.object({ resolved: z.boolean(), notes: z.string() })).about(incidentData);

const checkHeartbeat = H.flow('check-heartbeat')
  .for(heartbeat)
  .does(async ctx => {
    const probed = await ctx.run(probe, ctx.unit.data);
    return probed.ok ? 'up' : 'down';
  });

const runBackup = H.flow('run-backup')
  .for(backup)
  .does(async ctx => {
    const result = await ctx.run(backupCommands[ctx.unit.data.host], ctx.unit.data);
    return result.ok ? 'backedUp' : 'backupFailed';
  });

const renewCertificate = H.flow('renew-certificate')
  .for(certificate)
  .does(async ctx => {
    const host = ctx.unit.data.host;
    const checked = await ctx.run(certificateChecks[host], ctx.unit.data);
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.daysLeft >= renewWithinDays) return 'stillValid';
    const renewal = await ctx.run(certificateRenewals[host], ctx.unit.data);
    return renewal.ok ? 'renewed' : ctx.fail(renewal.error);
  });

const handleIncident = H.flow('incident-runbook')
  .for(incident)
  .does(async ctx => {
    const paged = await ctx.run(pageOnCall, ctx.unit.data);
    if (!paged.ok) return ctx.fail(paged.error);
    await ctx.halt(acknowledgement, `Acknowledge incident: ${ctx.unit.data.title}`, ctx.unit.data);
    for (;;) {
      const ran = await ctx.run(runbook, ctx.unit.data);
      const show = ran.ok ? `Runbook finished for ${ctx.unit.data.title}. Resolved?` : `Runbook failed: ${ran.error}. Resolved?`;
      const confirmed = await ctx.halt(resolution, show, ctx.unit.data);
      if (confirmed.resolved) return 'resolved';
    }
  });

const heartbeatClock = H.clock('heartbeat-every-five-minutes', heartbeat, { every: { minutes: 5 } }, tick =>
  ['gateway', 'billing', 'search'].map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
);

const backupTargets: readonly z.infer<typeof backupData>[] = [
  { database: 'orders', host: 'a' },
  { database: 'customers', host: 'b' },
];

const nightlyBackups = H.clock('nightly-backups', backup, { daily: '01:00' }, tick =>
  backupTargets.map(target => ({ create: target, key: `${target.database}-${tick.now.toISOString().slice(0, 10)}` }))
);

const certificateTargets: readonly z.infer<typeof certificateData>[] = [
  { domain: 'api.example.com', host: 'a' },
  { domain: 'www.example.com', host: 'b' },
];

const weeklyCertificates = H.clock('weekly-certificate-check', certificate, { weekly: { day: 'mon', at: '05:00' } }, tick =>
  certificateTargets.map(target => ({ create: target, key: `${target.domain}-${tick.now.toISOString().slice(0, 10)}` }))
);

const threeAttempts = H.policy.attemptRetry('three-attempts', view =>
  view.failedAttempts >= 3 ? 'stop' : { retryInMs: 15 * 60 * 1000 }
);

const heartbeats = H.lane('heartbeats', heartbeat).handler(checkHeartbeat).suppliers(heartbeatClock).retry('never', 'down');
const backups = H.lane('backups', backup).handler(runBackup).suppliers(nightlyBackups).retry('never', 'backupFailed');
const certificates = H.lane('certificates', certificate)
  .handler(renewCertificate)
  .suppliers(weeklyCertificates)
  .retry(threeAttempts, 'renewalFailed');
const incidents = H.lane('incidents', incident).handler(handleIncident).suppliers(H.operator);

const heartbeatStreak = H.trigger(
  'three-down-heartbeats-open-incident',
  H.on.streak(heartbeat, 'down', 3, data => data.service),
  (event, act) =>
    act.create(
      incidents,
      { title: `${event.unit.data.service} failed three heartbeats in a row`, source: `heartbeat:${event.unit.data.service}` },
      `heartbeat-${event.unit.data.service}`
    )
);

const failedBackup = H.trigger(
  'failed-backup-opens-incident',
  H.on.enters(backup, 'backupFailed'),
  (event, act) =>
    act.create(
      incidents,
      { title: `Backup of ${event.unit.data.database} failed`, source: `backup:${event.unit.data.database}` },
      `backup-${event.unit.key}`
    )
);

const slowBackup = H.trigger('slow-backup-noted', H.on.enters(backup, 'backedUp'), (event, act) => {
  const durationMs = event.attempt?.durationMs ?? 0;
  return durationMs > slowBackupMs
    ? act.remember(opsJournal, {
        text: `When scheduling the ${event.unit.data.database} backup, start it earlier or split it`,
        because: `the backup on ${event.at.toISOString().slice(0, 10)} took ${(durationMs / hour).toFixed(1)} hours`,
        when: { kinds: [backup] },
      })
    : [];
});

const incidentsFirst = H.policy.scheduler('incidents-preempt', view => {
  const pendingIncidents = view.pending.filter(unit => unit.is(incident));
  const incidentOpen = pendingIncidents.length > 0 || view.live.some(unit => unit.is(incident));
  const others = view.pending.filter(unit => !unit.is(incident) && !(incidentOpen && unit.is(backup)));
  const preempt =
    pendingIncidents.length > 0
      ? view.live.filter(unit => unit.position === 'active' && !unit.is(backup) && !unit.is(incident))
      : [];
  return { start: [...pendingIncidents, ...others], preempt };
});

const control = http.control({
  port: 8080,
  token: H.env('CONTROL_TOKEN'),
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(acknowledgement, resolution),
    H.ops.readMemory,
    H.ops.readTelemetry,
  ],
});

const incidentNotifications = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'created'} -> ${entry.to}`
      : null,
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/operations.sqlite'))
  .lanes(heartbeats, backups, certificates, incidents)
  .triggers(heartbeatStreak, failedBackup, slowBackup)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentNotifications, markdown.board('BOARD.md'));

export const running = operations.start();
