import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';

const twoHoursMs = 2 * 60 * 60 * 1000;
const renewBelowDays = 14;

const due = H.state('due', 'pending');
const probing = H.state('probing', 'active');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');
const Heartbeat = H.kind('heartbeat').data(z.object({ service: z.string() })).states(due, probing, healthy, unhealthy);

const scheduled = H.state('scheduled', 'pending');
const backingUp = H.state('backing-up', 'active');
const backedUp = H.state('backed-up', 'terminal', 'success');
const backupFailed = H.state('backup-failed', 'terminal', 'failure');
const Backup = H.kind('backup')
  .data(z.object({ database: z.string() }))
  .states(scheduled, backingUp, backedUp, backupFailed)
  .failsTo('backup-failed');

const checkDue = H.state('check-due', 'pending');
const checking = H.state('checking', 'active');
const renewing = H.state('renewing', 'active');
const current = H.state('current', 'terminal', 'success');
const renewed = H.state('renewed', 'terminal', 'success');
const renewalFailed = H.state('renewal-failed', 'terminal', 'failure');
const CertificateRenewal = H.kind('certificate-renewal')
  .data(z.object({ domain: z.string() }))
  .states(checkDue, checking, renewing, current, renewed, renewalFailed)
  .failsTo('renewal-failed');

const opened = H.state('opened', 'pending');
const acknowledging = H.state('acknowledging', 'active');
const remediating = H.state('remediating', 'active');
const confirming = H.state('confirming', 'active');
const resolved = H.state('resolved', 'terminal', 'success');
const Incident = H.kind('incident')
  .data(z.object({ title: z.string(), source: z.string() }))
  .states(opened, acknowledging, remediating, confirming, resolved);

const local = shell.local('local', { slots: 4 });
const sshKey = H.env('OPS_SSH_KEY');
const primaryHost = ssh.host('db-primary', { address: 'db-primary.internal', user: 'ops', key: sshKey, slots: 1 });
const replicaHost = ssh.host('db-replica', { address: 'db-replica.internal', user: 'ops', key: sshKey, slots: 1 });
const hosts = { primary: primaryHost, replica: replicaHost };

const operationsExperience = H.memory('operational-experience', 'experience');
const operationsLibrary = H.library('operational-experience', operationsExperience, jsonl.memory('.harness/operations.jsonl'));

const acknowledgement = H.halt('incident-acknowledgement', z.object({ by: z.string() }));
const resolutionConfirmation = H.halt('incident-resolution', z.object({ resolved: z.boolean() }));

const stopAtOnce = H.policy.retry('stop-at-once', () => 'stop');

const heartbeatProbe = H.command('heartbeat-probe')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .recovery('rerun');

const backupInput = z.object({ database: z.string() });

const diskSpace = H.command('disk-space')
  .input(backupInput)
  .argv((input) => ['check-free-space', '--for-database', input.database, '--min-free-gb', '50']);

const backupDump = H.command('backup-dump')
  .input(backupInput)
  .argv((input) => ['backup-database', input.database])
  .on(hosts, (input) => (input.database === 'orders' || input.database === 'billing' ? 'primary' : 'replica'))
  .preflight(diskSpace)
  .recovery('rerun');

const certificateExpiry = H.command('certificate-expiry')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv((input) => ['certificate-days-left', input.domain])
  .on(hosts, (input) => (input.domain.endsWith('.internal') ? 'replica' : 'primary'))
  .recovery('rerun');

const certificateRenew = H.command('certificate-renew')
  .input(z.object({ domain: z.string() }))
  .argv((input) => ['renew-certificate', input.domain])
  .on(hosts, (input) => (input.domain.endsWith('.internal') ? 'replica' : 'primary'))
  .recovery('rerun');

const runbook = H.command('incident-runbook')
  .input(z.object({ title: z.string(), source: z.string() }))
  .argv((input) => ['run-runbook', '--source', input.source, '--title', input.title])
  .on(local)
  .recovery('park');

const heartbeatWork = H.flow('heartbeat-work')
  .for(Heartbeat)
  .phases('probing')
  .exits('healthy', 'unhealthy')
  .does(async (ctx) => {
    await ctx.move('probing');
    const probe = await ctx.run(heartbeatProbe, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : 'unhealthy';
  });

const backupWork = H.flow('backup-work')
  .for(Backup)
  .phases('backingUp')
  .exits('backedUp')
  .does(async (ctx) => {
    await ctx.move('backingUp');
    const dumped = await ctx.run(backupDump, { database: ctx.unit.data.database });
    return dumped.ok ? 'backedUp' : ctx.fail(dumped.error);
  });

const renewalWork = H.flow('renewal-work')
  .for(CertificateRenewal)
  .phases('checking', 'renewing')
  .exits('current', 'renewed')
  .does(async (ctx) => {
    const domain = ctx.unit.data.domain;
    await ctx.move('checking');
    const expiry = await ctx.run(certificateExpiry, { domain });
    if (!expiry.ok) return ctx.fail(expiry.error);
    if (expiry.value.daysLeft >= renewBelowDays) return 'current';
    await ctx.move('renewing');
    const renewal = await ctx.run(certificateRenew, { domain });
    return renewal.ok ? 'renewed' : ctx.fail(renewal.error);
  });

const incidentWork = H.flow('incident-work')
  .for(Incident)
  .phases('acknowledging', 'remediating', 'confirming')
  .exits('resolved')
  .does(async (ctx) => {
    const { title, source } = ctx.unit.data;
    await ctx.move('acknowledging');
    await ctx.halt(acknowledgement, `Incident from ${source}: ${title}`);
    while (true) {
      await ctx.move('remediating');
      const ran = await ctx.run(runbook, { title, source });
      await ctx.move('confirming');
      const outcome = ran.ok ? ran.value : `runbook failed: ${ran.error}`;
      const confirmation = await ctx.halt(resolutionConfirmation, `Runbook result for "${title}":\n${outcome}`);
      if (confirmation.resolved) return 'resolved';
    }
  });

const heartbeatSchedule = H.clock('heartbeat-schedule', Heartbeat, { every: { minutes: 5 } }, ({ now }) =>
  ['api', 'web', 'queue'].map((service) => ({ create: { service }, key: `${service}@${now.toISOString()}` }))
);

const backupSchedule = H.clock('backup-schedule', Backup, { daily: '01:00' }, ({ now }) =>
  ['orders', 'billing', 'analytics', 'auth'].map((database) => ({
    create: { database },
    key: `${database}@${now.toISOString().slice(0, 10)}`,
  }))
);

const renewalSchedule = H.clock('renewal-schedule', CertificateRenewal, { weekly: { day: 'sun', at: '03:00' } }, ({ now }) =>
  ['example.com', 'api.example.com', 'vault.internal'].map((domain) => ({
    create: { domain },
    key: `${domain}@${now.toISOString().slice(0, 10)}`,
  }))
);

const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatWork, { probing, healthy, unhealthy })
  .suppliers(heartbeatSchedule);

const backups = H.lane('backups', Backup)
  .handler(backupWork, { backingUp, backedUp })
  .suppliers(backupSchedule)
  .retry(stopAtOnce);

const renewals = H.lane('renewals', CertificateRenewal)
  .handler(renewalWork, { checking, renewing, current, renewed })
  .suppliers(renewalSchedule);

const incidents = H.lane('incidents', Incident)
  .handler(incidentWork, { acknowledging, remediating, confirming, resolved })
  .suppliers(H.operator);

const heartbeatStreak = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(Heartbeat, 'unhealthy', 3, (data) => data.service),
  (event, act) =>
    act.create(
      incidents,
      { title: `${event.unit.data.service} failed three heartbeats in a row`, source: 'heartbeat' },
      `incident-heartbeat-${event.unit.data.service}`
    )
);

const backupFailure = H.trigger('failed-backup-opens-incident', H.on.enters(Backup, 'backup-failed'), (event, act) =>
  act.create(
    incidents,
    { title: `Backup of ${event.unit.data.database} failed`, source: 'backup' },
    `incident-backup-${event.unit.key}`
  )
);

const slowBackup = H.trigger('slow-backup-records-experience', H.on.enters(Backup, 'backed-up'), (event, act) =>
  event.attempt !== null && event.attempt.durationMs > twoHoursMs
    ? act.remember(operationsLibrary, {
        text: `When scheduling the ${event.unit.data.database} backup, start it earlier or split it`,
        because: `it took ${Math.round(event.attempt.durationMs / 60000)} minutes on ${event.at.toISOString().slice(0, 10)}`,
        when: { kinds: [Backup], resources: [event.unit.data.database] },
        status: 'accepted',
      })
    : []
);

const priority = (unit: PendingView): number => {
  if (unit.is(Incident)) return 0;
  if (unit.is(Heartbeat)) return 1;
  if (unit.is(CertificateRenewal)) return 2;
  return 3;
};

const incidentsFirst = H.policy.scheduler('incidents-first', ({ pending, active }) => {
  const incidentWaiting = pending.some((unit) => unit.is(Incident));
  const incidentOpen = incidentWaiting || active.some((unit) => unit.is(Incident));
  const start = pending
    .filter((unit) => !(incidentOpen && unit.is(Backup)))
    .sort((a, b) => priority(a) - priority(b) || b.waitedMs - a.waitedMs);
  const preempt = incidentWaiting ? active.filter((unit) => !unit.is(Backup) && !unit.is(Incident)) : [];
  return { start, preempt };
});

const control = http.control({
  port: 8420,
  token: H.env('CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
});

const incidentAlerts = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  message: (entry) =>
    entry.entry === 'transition' && entry.kind === Incident.name
      ? `Incident ${entry.unit ?? 'unknown'}: ${entry.from ?? 'new'} -> ${entry.to}`
      : null,
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(heartbeatStreak, backupFailure, slowBackup)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentAlerts, markdown.board('BOARD.md'));

export const running = operations.start();
