import { z } from 'zod';
import { H, type PendingView } from 'harness-dsl';
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
const current = H.state('current', 'terminal', 'success');
const renewed = H.state('renewed', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');
const open = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');
const unresolved = H.state('unresolved', 'terminal', 'failure');

const heartbeat = H.kind('heartbeat').data(z.object({ service: z.string() })).states(due, up, down);
const backup = H.kind('backup').data(z.object({ database: z.string() })).states(due, backedUp, failed);
const certificate = H.kind('certificate-renewal').data(z.object({ domain: z.string() })).states(due, current, renewed, failed);
const incident = H.kind('incident')
  .data(z.object({ summary: z.string(), runbook: z.string() }))
  .states(open, resolved, unresolved);

const operationalExperience = H.memory('operational-experience', 'experience');
const opsJournal = H.library('ops-journal', operationalExperience, jsonl.memory('.harness/ops-journal.jsonl'));

const local = shell.local('local', { slots: 4 });

const diskSpace = H.command('disk-space-preflight').argv(() => [
  'sh',
  '-c',
  'test "$(df --output=avail -BG /var/backups | tail -1 | tr -dc 0-9)" -gt 50',
]);

const hostOne = ssh.host('db-host-1', {
  address: 'db1.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskSpace,
});
const hostTwo = ssh.host('db-host-2', {
  address: 'db2.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskSpace,
});

const ping = H.command('service-ping')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./bin/ping', input.service])
  .on(local)
  .recovery('rerun');

const dumpDatabase = H.command('dump-database')
  .input(z.object({ database: z.string() }))
  .argv(input => ['./bin/backup', input.database])
  .on(hostOne, hostTwo)
  .recovery('rerun');

const certificateDaysLeft = H.command('certificate-days-left')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['./bin/cert-days-left', input.domain])
  .on(hostOne, hostTwo)
  .recovery('rerun');

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv(input => ['./bin/renew-cert', input.domain])
  .on(hostOne, hostTwo)
  .recovery('park');

const pageOnCall = H.command('page-on-call')
  .input(z.object({ summary: z.string() }))
  .argv(input => ['./bin/page', input.summary])
  .on(local)
  .recovery('park');

const runRunbook = H.command('run-runbook')
  .input(z.object({ runbook: z.string() }))
  .argv(input => ['./bin/runbook', input.runbook])
  .on(local)
  .recovery('park');

const acknowledged = H.halt('incident-acknowledged', z.object({ by: z.string() })).about(z.object({ summary: z.string() }));
const confirmed = H.halt('incident-resolution-confirmed', z.object({ resolved: z.boolean(), note: z.string() })).about(
  z.object({ summary: z.string() })
);

const checkHeartbeat = H.flow('check-heartbeat')
  .for(heartbeat)
  .does(async ctx => {
    const result = await ctx.run(ping, { service: ctx.unit.data.service });
    return result.ok ? 'up' : 'down';
  });

const runBackup = H.flow('run-backup')
  .for(backup)
  .does(async ctx => {
    const result = await ctx.run(dumpDatabase, { database: ctx.unit.data.database });
    return result.ok ? 'backed-up' : ctx.fail(result.error);
  });

const renewIfDue = H.flow('renew-if-due')
  .for(certificate)
  .does(async ctx => {
    const left = await ctx.run(certificateDaysLeft, { domain: ctx.unit.data.domain });
    if (!left.ok) return ctx.fail(left.error);
    if (left.value.daysLeft >= 14) return 'current';
    const renewal = await ctx.run(renewCertificate, { domain: ctx.unit.data.domain });
    return renewal.ok ? 'renewed' : ctx.fail(renewal.error);
  });

const respond = H.flow('incident-runbook')
  .for(incident)
  .does(async ctx => {
    const summary = ctx.unit.data.summary;
    const paged = await ctx.run(pageOnCall, { summary });
    if (!paged.ok) return ctx.fail(paged.error);
    await ctx.halt(acknowledged, `Acknowledge incident: ${summary}`, { summary });
    const ran = await ctx.run(runRunbook, { runbook: ctx.unit.data.runbook });
    const confirmation = await ctx.halt(
      confirmed,
      ran.ok ? 'Runbook finished; confirm the incident is resolved' : `Runbook failed: ${ran.error}`,
      { summary }
    );
    return confirmation.resolved ? 'resolved' : 'unresolved';
  });

const services = ['api', 'web', 'queue'];
const databases = ['orders', 'users', 'billing'];
const domains = ['example.com', 'api.example.com'];

const heartbeatClock = H.clock('heartbeat-clock', heartbeat, { every: { minutes: 5 } }, () =>
  services.map(service => ({ create: { service }, key: `heartbeat-${service}` }))
);
const backupClock = H.clock('nightly-backups', backup, { daily: '01:00' }, () =>
  databases.map(database => ({ create: { database }, key: `backup-${database}` }))
);
const certificateClock = H.clock('weekly-certificate-check', certificate, { weekly: { day: 'sun', at: '03:00' } }, () =>
  domains.map(domain => ({ create: { domain }, key: `certificate-${domain}` }))
);

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat)
  .retries(0, { exhausted: 'down' })
  .suppliers(heartbeatClock);

const backups = H.lane('backups', backup)
  .handler(runBackup)
  .retries(0, { exhausted: 'failed' })
  .suppliers(backupClock);

const certificates = H.lane('certificates', certificate)
  .handler(renewIfDue)
  .retries(1, { backoff: { first: { minutes: 30 } }, exhausted: 'failed' })
  .suppliers(certificateClock);

const incidents = H.lane('incidents', incident)
  .handler(respond)
  .retries(0, { exhausted: 'unresolved' })
  .suppliers(H.operator)
  .store(sqlite.store(incident, '.harness/incidents.sqlite'));

const heartbeatStreak = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(heartbeat, 'down', 3, data => data.service),
  (event, act) =>
    act.create(
      incidents,
      { summary: `${event.unit.data.service} failed three heartbeats in a row`, runbook: `restart-${event.unit.data.service}` },
      `incident-heartbeat-${event.unit.data.service}`
    )
);

const failedBackup = H.trigger('failed-backup-opens-incident', H.on.enters(backup, 'failed'), (event, act) =>
  act.create(
    incidents,
    { summary: `Backup of ${event.unit.data.database} failed`, runbook: `backup-recovery-${event.unit.data.database}` },
    `incident-backup-${event.unit.data.database}`
  )
);

const slowBackupMs = 2 * 60 * 60 * 1000;

const slowBackup = H.trigger('slow-backup-records-note', H.on.enters(backup, 'backed-up'), (event, act) => {
  const durationMs = event.attempt?.durationMs ?? 0;
  if (durationMs <= slowBackupMs) return [];
  return act.remember(opsJournal, {
    text: `When scheduling the ${event.unit.data.database} backup, start it earlier or check host I/O first`,
    because: `the backup finishing ${event.at.toISOString()} took ${Math.round(durationMs / 60000)} minutes`,
    when: { kinds: [backup] },
  });
});

const rank = (unit: PendingView): number => {
  if (unit.kind === incident.name) return 0;
  if (unit.kind === heartbeat.name) return 1;
  return 2;
};

const incidentsFirst = H.policy.scheduler('incidents-preempt', view => {
  const incidentActive =
    view.pending.some(unit => unit.kind === incident.name) || view.live.some(unit => unit.kind === incident.name);
  const start = view.pending
    .filter(unit => !(incidentActive && unit.kind === backup.name))
    .sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs);
  const incidentWaiting = view.pending.some(unit => unit.kind === incident.name);
  const preempt = incidentWaiting
    ? view.live.filter(unit => unit.kind === heartbeat.name && unit.status === 'running')
    : [];
  return { start, preempt };
});

const operatorHttp = http.control('operator-http', {
  port: 8080,
  token: H.env('CONTROL_TOKEN'),
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(acknowledged, confirmed, H.halts.interrupted),
    H.ops.readMemory,
    H.ops.readTelemetry,
  ],
});

const incidentNotices = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'new'} -> ${entry.to}`
      : null,
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(incidents, heartbeats, backups, certificates)
  .triggers(heartbeatStreak, failedBackup, slowBackup)
  .scheduler(incidentsFirst)
  .clients(operatorHttp)
  .observers(incidentNotices, markdown.board('BOARD.md'));
