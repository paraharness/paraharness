import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
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
const completed = H.state('completed', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');

const valid = H.state('valid', 'terminal', 'success');
const renewed = H.state('renewed', 'terminal', 'success');
const renewalFailed = H.state('renewal-failed', 'terminal', 'failure');

const open = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');

export const heartbeat = H.kind('Heartbeat').data(z.object({ service: z.string() })).states(due, healthy, unhealthy);

export const backup = H.kind('Backup').data(z.object({ database: z.string() })).states(scheduled, completed, failed);

export const renewal = H.kind('CertificateRenewal')
  .data(z.object({ domain: z.string() }))
  .states(due, valid, renewed, renewalFailed);

export const incident = H.kind('Incident')
  .data(z.object({ title: z.string(), detail: z.string(), source: z.enum(['heartbeat', 'backup', 'operator']) }))
  .states(open, resolved);

const opsExperienceMemory = H.memory('operational-experience', 'experience');
const opsJournal = H.journal('operational-experience', opsExperienceMemory, jsonl.memory('memory/operations.jsonl'));

const acknowledgement = H.halt('incident-acknowledgement', z.object({ by: z.string() }));
const resolutionCheck = H.halt('incident-resolution', z.object({ resolved: z.boolean(), note: z.string().optional() }));

const local = shell.local('local', { slots: 4 });

const diskSpacePreflight = H.command('disk-space-preflight').argv(() => ['scripts/check-free-disk', '--min-gb', '50']);

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
  .argv(input => ['scripts/probe', input.service])
  .on(local);

const runBackup = H.command('run-backup')
  .input(z.object({ database: z.string() }))
  .argv(input => ['scripts/backup', input.database])
  .on(dbHostOne, dbHostTwo);

const checkCertificate = H.command('check-certificate')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['scripts/cert-days-left', input.domain])
  .on(dbHostOne, dbHostTwo);

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv(input => ['scripts/renew-cert', input.domain])
  .on(dbHostOne, dbHostTwo);

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(input => ['scripts/page', input.title])
  .on(local);

const runRunbook = H.command('run-runbook')
  .input(z.object({ source: z.string(), detail: z.string() }))
  .argv(input => ['scripts/runbook', input.source, input.detail])
  .on(local);

const checkHeartbeat = H.flow('check-heartbeat')
  .for(heartbeat)
  .does(async ctx => {
    const probe = await ctx.run(serviceProbe, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : 'unhealthy';
  });

const takeBackup = H.flow('take-backup')
  .for(backup)
  .does(async ctx => {
    const result = await ctx.run(runBackup, { database: ctx.unit.data.database });
    return result.ok ? 'completed' : ctx.fail(result.error);
  });

const renewalWindowDays = 14;

const checkRenewal = H.flow('check-renewal')
  .for(renewal)
  .does(async ctx => {
    const domain = ctx.unit.data.domain;
    const checked = await ctx.run(checkCertificate, { domain });
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.daysLeft >= renewalWindowDays) return 'valid';
    const renewal_ = await ctx.run(renewCertificate, { domain });
    return renewal_.ok ? 'renewed' : ctx.fail(renewal_.error);
  });

const incidentRunbook = H.flow('incident-runbook')
  .for(incident)
  .does(async ctx => {
    const { title, detail, source } = ctx.unit.data;
    const paged = await ctx.run(pageOnCall, { title });
    if (!paged.ok) return ctx.fail(paged.error);
    await ctx.halt(acknowledgement, `Acknowledge incident: ${title}`);
    for (;;) {
      const runbook = await ctx.run(runRunbook, { source, detail });
      const confirmation = await ctx.halt(
        resolutionCheck,
        runbook.ok ? `Runbook finished:\n${runbook.value}\nIs the incident resolved?` : `Runbook failed: ${runbook.error}\nIs the incident resolved?`
      );
      if (confirmation.resolved) return 'resolved';
    }
  });

const services = ['api', 'web', 'worker'];
const databases = ['orders', 'customers'];
const domains = ['example.com', 'api.example.com'];

const heartbeatClock = H.clock('heartbeat-every-five-minutes', heartbeat, { every: { minutes: 5 } }, () =>
  services.map(service => ({ create: { service } }))
);
const backupClock = H.clock('nightly-backups', backup, { daily: '01:00' }, () =>
  databases.map(database => ({ create: { database } }))
);
const renewalClock = H.clock('weekly-certificate-check', renewal, { weekly: { day: 'mon', at: '04:00' } }, () =>
  domains.map(domain => ({ create: { domain } }))
);

export const heartbeatLane = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat, { exhausted: 'unhealthy' })
  .suppliers(heartbeatClock);

export const backupLane = H.lane('backups', backup)
  .handler(takeBackup, { exhausted: 'failed' })
  .suppliers(backupClock);

export const renewalLane = H.lane('certificate-renewals', renewal)
  .handler(checkRenewal, { retries: 2, backoff: { first: { minutes: 30 }, factor: 2 }, exhausted: 'renewal-failed' })
  .suppliers(renewalClock);

export const incidentLane = H.lane('incidents', incident)
  .handler(incidentRunbook, { exhausted: H.halts.exhausted })
  .suppliers(H.operator);

const heartbeatStreakOpensIncident = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(heartbeat, 'unhealthy', 3, data => data.service),
  (event, act) =>
    act.create(
      incidentLane,
      {
        title: `${event.unit.data.service} failed three heartbeats in a row`,
        detail: `Third failure at ${event.at.toISOString()}`,
        source: 'heartbeat',
      },
      `incident-heartbeat-${event.unit.data.service}`
    )
);

const failedBackupOpensIncident = H.trigger(
  'failed-backup-opens-incident',
  H.on.enters(backup, 'failed'),
  (event, act) =>
    act.create(
      incidentLane,
      {
        title: `Backup of ${event.unit.data.database} failed`,
        detail: `Failed at ${event.at.toISOString()}`,
        source: 'backup',
      },
      `incident-backup-${event.unit.data.database}`
    )
);

const slowBackupMs = 2 * 60 * 60 * 1000;

const slowBackupNotesExperience = H.trigger(
  'slow-backup-notes-experience',
  H.on.enters(backup, 'completed'),
  (event, act) =>
    event.attempt !== undefined && event.attempt.durationMs > slowBackupMs
      ? act.remember(opsJournal, {
          text: `When planning work after the nightly backup of ${event.unit.data.database}, allow more than two hours for it`,
          because: `the backup finishing at ${event.at.toISOString()} took ${Math.round(event.attempt.durationMs / 60000)} minutes`,
          when: { kinds: [backup] },
          status: 'accepted',
        })
      : []
);

const rank = (unit: PendingView): number => {
  if (unit.kind === incident.name) return 0;
  if (unit.kind === heartbeat.name) return 1;
  if (unit.kind === renewal.name) return 2;
  return 3;
};

const incidentsFirst = H.policy.scheduler('incidents-preempt', view => {
  const incidentPending = view.pending.some(unit => unit.kind === incident.name);
  const incidentOpen = incidentPending || view.live.some(unit => unit.kind === incident.name);
  const start = view.pending
    .filter(unit => !(incidentOpen && unit.kind === backup.name))
    .sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs);
  const preempt = incidentPending
    ? view.live.filter(unit => unit.position === 'active' && (unit.kind === renewal.name || unit.kind === heartbeat.name))
    : [];
  return { start, preempt };
});

const controlApi = http.control({
  port: 7300,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.readMemory,
    H.ops.readTelemetry,
    H.ops.resolve(acknowledgement, resolutionCheck, H.halts.exhausted, H.halts.interrupted, H.halts.definitionChanged),
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
  .ledger(sqlite.ledger('.harness/operations.sqlite'))
  .lanes(heartbeatLane, backupLane, renewalLane, incidentLane)
  .triggers(heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupNotesExperience)
  .scheduler(incidentsFirst)
  .clients(controlApi)
  .observers(incidentNotifications, markdown.board('BOARD.md'));
