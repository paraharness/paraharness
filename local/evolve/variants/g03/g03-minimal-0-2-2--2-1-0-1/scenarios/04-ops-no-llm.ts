import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, SupplyOf } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';

const queued = H.state('queued', 'pending');
const up = H.state('up', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');
const backedUp = H.state('backedUp', 'terminal', 'success');
const backupFailed = H.state('backupFailed', 'terminal', 'failure');
const valid = H.state('valid', 'terminal', 'success');
const renewed = H.state('renewed', 'terminal', 'success');
const renewalFailed = H.state('renewalFailed', 'terminal', 'failure');
const open = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');
const unresolved = H.state('unresolved', 'terminal', 'failure');

const Heartbeat = H.kind('Heartbeat').data(z.object({ service: z.string() })).states(queued, up, down);
const Backup = H.kind('Backup').data(z.object({ database: z.string() })).states(queued, backedUp, backupFailed);
const CertificateRenewal = H.kind('CertificateRenewal').data(z.object({ domain: z.string() })).states(queued, valid, renewed, renewalFailed);
const Incident = H.kind('Incident')
  .data(z.object({ title: z.string(), service: z.string(), detail: z.string() }))
  .states(open, resolved, unresolved);

const services = ['api', 'web', 'queue'];
const domains = ['example.com', 'api.example.com'];
const databases = [
  { name: 'orders', resource: H.resource('orders-db') },
  { name: 'billing', resource: H.resource('billing-db') },
];

const local = shell.local('local', { slots: 4 });

const diskSpace = H.command('diskSpace')
  .argv(() => ['sh', '-c', 'test "$(df --output=avail -k /var/backups | tail -1)" -gt 10485760'])
  .recovery('rerun');

const sshKey = H.env('OPS_SSH_KEY');
const hostA = ssh.host('db-host-a', { address: 'db-a.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskSpace });
const hostB = ssh.host('db-host-b', { address: 'db-b.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskSpace });

const healthCheck = H.command('healthCheck')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .recovery('rerun');

const backupCommand = H.command('backupDatabase')
  .input(z.object({ database: z.string() }))
  .argv(input => ['pg-backup', '--database', input.database])
  .on(hostA, hostB)
  .recovery('rerun');

const certificateCheck = H.command('certificateCheck')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['cert-days-left', input.domain])
  .on(hostA, hostB)
  .recovery('rerun');

const certificateRenew = H.command('certificateRenew')
  .input(z.object({ domain: z.string() }))
  .argv(input => ['certbot', 'renew', '--cert-name', input.domain])
  .on(hostA, hostB)
  .recovery('rerun');

const runbook = H.command('runbook')
  .input(z.object({ service: z.string() }))
  .argv(input => ['runbook', 'restart', input.service])
  .on(local);

const acknowledgement = H.halt('incidentAcknowledged', z.object({ by: z.string() }));
const resolution = H.halt('incidentResolved', z.object({ resolved: z.boolean(), note: z.string().optional() }));

const heartbeat = H.flow('heartbeat').for(Heartbeat).does(async ctx => {
  const result = await ctx.run(healthCheck, { service: ctx.unit.data.service });
  return result.ok ? 'up' : 'down';
});

const backup = H.flow('backup').for(Backup).does(async ctx => {
  const result = await ctx.run(backupCommand, { database: ctx.unit.data.database });
  return result.ok ? 'backedUp' : ctx.fail(result.error);
});

const renewal = H.flow('renewal').for(CertificateRenewal).does(async ctx => {
  const domain = ctx.unit.data.domain;
  const checked = await ctx.run(certificateCheck, { domain });
  if (!checked.ok) return ctx.fail(checked.error);
  if (checked.value.daysLeft >= 14) return 'valid';
  const result = await ctx.run(certificateRenew, { domain });
  return result.ok ? 'renewed' : ctx.fail(result.error);
});

const incidentResponse = H.flow('incidentResponse').for(Incident).does(async ctx => {
  const incident = ctx.unit.data;
  await ctx.halt(acknowledgement, `Acknowledge incident: ${incident.title}\n${incident.detail}`);
  const ran = await ctx.run(runbook, { service: incident.service });
  const confirmation = await ctx.halt(
    resolution,
    ran.ok ? `Runbook finished for ${incident.service}. Confirm resolution.` : `Runbook failed for ${incident.service}: ${ran.error}`,
  );
  return confirmation.resolved ? 'resolved' : 'unresolved';
});

const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(heartbeat)
  .attempts(1, { exhausted: 'down' })
  .suppliers(H.schedule('heartbeatEveryFiveMinutes', Heartbeat, { every: { minutes: 5 } }, () =>
    services.map((service): SupplyOf<typeof Heartbeat> => ({ create: { service } }))));

const backups = H.lane('backups', Backup)
  .handler(backup)
  .attempts(1, { exhausted: 'backupFailed' })
  .suppliers(H.schedule('nightlyBackups', Backup, { daily: '01:00' }, () =>
    databases.map((db): SupplyOf<typeof Backup> => ({ create: { database: db.name } }))));

const renewals = H.lane('renewals', CertificateRenewal)
  .handler(renewal)
  .attempts(2, { backoff: { first: { hours: 1 } }, exhausted: 'renewalFailed' })
  .suppliers(H.schedule('weeklyCertificateCheck', CertificateRenewal, { weekly: { day: 'sun', at: '03:00' } }, () =>
    domains.map((domain): SupplyOf<typeof CertificateRenewal> => ({ create: { domain } }))));

const incidents = H.lane('incidents', Incident)
  .handler(incidentResponse)
  .attempts(1, { exhausted: 'unresolved' })
  .suppliers(H.operator);

const operations = H.journal('operations', H.memory('operations', 'experience'), jsonl.memory('memory/operations.jsonl'));

const twoHoursMs = 2 * 60 * 60 * 1000;

const heartbeatStreak = H.trigger(
  'threeFailedHeartbeats',
  H.on.streak(Heartbeat, 'down', 3, data => data.service),
  (event, act) => act.create(incidents, {
    title: `${event.unit.data.service} failed three heartbeats`,
    service: event.unit.data.service,
    detail: `Third consecutive failure at ${event.at.toISOString()}.`,
  }, `heartbeat-${event.unit.data.service}`),
);

const backupFailure = H.trigger(
  'backupFailure',
  H.on.enters(Backup, 'backupFailed'),
  (event, act) => act.create(incidents, {
    title: `Backup of ${event.unit.data.database} failed`,
    service: event.unit.data.database,
    detail: `Backup unit ${event.unit.key} failed at ${event.at.toISOString()}.`,
  }),
);

const slowBackup = H.trigger(
  'slowBackup',
  H.on.enters(Backup, 'backedUp'),
  (event, act) => {
    const tookMs = event.attempt?.durationMs ?? 0;
    if (tookMs <= twoHoursMs) return [];
    const db = databases.find(candidate => candidate.name === event.unit.data.database);
    return act.remember(operations, {
      text: `When scheduling the ${event.unit.data.database} backup, expect it to run over two hours and leave the window clear`,
      because: `the backup finishing at ${event.at.toISOString()} took ${(tookMs / 3600000).toFixed(1)} hours`,
      when: { kinds: [Backup], resources: db ? [db.resource] : [] },
    });
  },
);

const incidentsFirst = H.policy.scheduler('incidentsFirst', view => {
  const incidentLive = view.live.some(unit => unit.is(Incident));
  const incidentPending = view.pending.some(unit => unit.is(Incident));
  const rank = (unit: PendingView): number => {
    if (unit.is(Incident)) return 0;
    if (unit.is(Heartbeat)) return 1;
    if (unit.is(CertificateRenewal)) return 2;
    return 3;
  };
  const start = view.pending
    .filter(unit => !(unit.is(Backup) && (incidentLive || incidentPending)))
    .sort((a, b) => rank(a) - rank(b));
  const preempt = incidentPending
    ? view.live.filter(unit => unit.position === 'active' && !unit.is(Backup) && !unit.is(Incident))
    : [];
  return { start, preempt };
});

const control = http.control({
  port: 8080,
  token: H.env('CONTROL_TOKEN'),
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(acknowledgement, resolution, H.halts.interrupted),
    H.ops.readMemory,
    H.ops.readTelemetry,
  ],
});

const incidentNotice = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  message: entry => entry.entry === 'transition' && entry.kind === Incident.name
    ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'created'} -> ${entry.to}`
    : null,
});

export const operationsHarness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(heartbeatStreak, backupFailure, slowBackup)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentNotice, markdown.board('BOARD.md'));
