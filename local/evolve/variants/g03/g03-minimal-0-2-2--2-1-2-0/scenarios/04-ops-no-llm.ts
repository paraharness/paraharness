import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const heartbeat = H.kind('Heartbeat')
  .data(z.object({ service: z.string() }))
  .states(
    H.state('due', 'pending'),
    H.state('healthy', 'terminal', 'success'),
    H.state('unhealthy', 'terminal', 'failure')
  );

const backup = H.kind('Backup')
  .data(z.object({ database: z.string() }))
  .states(
    H.state('scheduled', 'pending'),
    H.state('backedUp', 'terminal', 'success'),
    H.state('backupFailed', 'terminal', 'failure')
  );

const renewal = H.kind('CertificateRenewal')
  .data(z.object({ domain: z.string() }))
  .states(
    H.state('checking', 'pending'),
    H.state('current', 'terminal', 'neutral'),
    H.state('renewed', 'terminal', 'success'),
    H.state('lapsed', 'terminal', 'failure')
  );

const incident = H.kind('Incident')
  .data(z.object({ title: z.string(), source: z.enum(['heartbeat', 'backup', 'operator']) }))
  .states(
    H.state('open', 'pending'),
    H.state('resolved', 'terminal', 'success'),
    H.state('unresolved', 'terminal', 'failure')
  );

const acknowledged = H.halt('incident-acknowledged', z.object({ by: z.string() }));
const confirmed = H.halt('incident-resolution-confirmed', z.object({ resolved: z.boolean(), note: z.string().optional() }));

const local = shell.local('local', { slots: 4 });
const diskSpace = H.command('disk-space-preflight').argv(() => ['./bin/require-free-disk', '--gb', '50']);
const hostA = ssh.host('db-host-a', { address: '10.0.0.11', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskSpace });
const hostB = ssh.host('db-host-b', { address: '10.0.0.12', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskSpace });

const probe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./bin/probe', i.service])
  .on(local)
  .recovery('rerun');

const dump = H.command('database-backup')
  .input(z.object({ database: z.string() }))
  .argv(i => ['./bin/backup', i.database])
  .on(hostA, hostB)
  .recovery('rerun');

const certExpiry = H.command('certificate-expiry')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(i => ['./bin/cert-days-left', i.domain])
  .on(hostA, hostB)
  .recovery('rerun');

const certRenew = H.command('certificate-renew')
  .input(z.object({ domain: z.string() }))
  .argv(i => ['./bin/cert-renew', i.domain])
  .on(hostA, hostB)
  .recovery('park');

const runbook = H.command('incident-runbook')
  .input(z.object({ title: z.string(), source: z.string() }))
  .argv(i => ['./runbooks/triage', i.source, i.title])
  .on(local)
  .recovery('park');

const checkHeartbeat = H.flow('heartbeat').for(heartbeat).does(async ctx => {
  const probed = await ctx.run(probe, { service: ctx.unit.data.service });
  return probed.ok ? 'healthy' : 'unhealthy';
});

const runBackup = H.flow('backup').for(backup).does(async ctx => {
  const dumped = await ctx.run(dump, { database: ctx.unit.data.database });
  if (!dumped.ok) return ctx.fail(dumped);
  return 'backedUp';
});

const checkCertificate = H.flow('certificate-renewal').for(renewal).does(async ctx => {
  const { domain } = ctx.unit.data;
  const checked = await ctx.run(certExpiry, { domain });
  if (!checked.ok) return ctx.fail(checked);
  if (checked.value.daysLeft >= 14) return 'current';
  const renewed = await ctx.run(certRenew, { domain });
  if (!renewed.ok) return ctx.fail(renewed);
  return 'renewed';
});

const handleIncident = H.flow('incident-runbook').for(incident).does(async ctx => {
  const { title, source } = ctx.unit.data;
  await ctx.halt(acknowledged, `Acknowledge incident: ${title}`);
  const ran = await ctx.run(runbook, { title, source });
  const confirmation = await ctx.halt(
    confirmed,
    ran.ok ? `Runbook finished:\n${ran.value}` : `Runbook failed: ${ran.error}`
  );
  return confirmation.resolved ? 'resolved' : 'unresolved';
});

const services = ['api', 'web', 'queue'];
const databases = ['orders', 'users'];
const domains = ['example.com', 'api.example.com'];

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat)
  .retries(0, 'unhealthy')
  .suppliers(H.clock('every-five-minutes', heartbeat, { every: { minutes: 5 } }, tick => services.map(service => tick.create({ service }))));

const backups = H.lane('backups', backup)
  .handler(runBackup)
  .retries(0, 'backupFailed')
  .suppliers(H.clock('nightly-backups', backup, { daily: '01:30' }, tick => databases.map(database => tick.create({ database }))));

const renewals = H.lane('renewals', renewal)
  .handler(checkCertificate)
  .retries(2, 'lapsed', { first: { hours: 1 } })
  .suppliers(H.clock('weekly-certificates', renewal, { weekly: { day: 'mon', at: '04:00' } }, tick => domains.map(domain => tick.create({ domain }))));

const incidents = H.lane('incidents', incident)
  .handler(handleIncident)
  .retries(0, 'unresolved')
  .suppliers(H.operator);

const operational = H.journal(
  'operational-experience',
  H.memory('operational', 'experience'),
  jsonl.memory('memory/operations.jsonl'),
  H.policy.recall('newest-specific', view => view.ranked.slice(0, 20))
);

const failingHeartbeatsOpenIncident = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(heartbeat, 'unhealthy', 3, data => data.service),
  (event, act) =>
    act.create(
      incidents,
      { title: `${event.unit.data.service} failed three heartbeats in a row`, source: 'heartbeat' },
      `heartbeat-${event.unit.data.service}-${event.at.toISOString()}`
    )
);

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident', H.on.enters(backup, 'backupFailed'), (event, act) =>
  act.create(incidents, { title: `Backup of ${event.unit.data.database} failed`, source: 'backup' }, `backup-${event.unit.key}`)
);

const slowBackupNotes = H.trigger('slow-backup-notes-experience', H.on.enters(backup, 'backedUp'), (event, act) => {
  const tookMs = event.attempt?.durationMs ?? 0;
  if (tookMs <= 2 * 3_600_000) return [];
  return act.remember(operational, {
    text: `When backing up ${event.unit.data.database}, check its growth and start it earlier`,
    because: `the backup finishing ${event.at.toISOString()} took ${(tookMs / 3_600_000).toFixed(1)} hours`,
    when: { kinds: [backup] },
  });
});

const rank = (unit: PendingView): number => {
  if (unit.is(incident)) return 0;
  if (unit.is(heartbeat)) return 1;
  if (unit.is(renewal)) return 2;
  return 3;
};

const incidentsFirst = H.policy.scheduler('incidents-preempt', view => {
  const incidentPending = view.pending.some(u => u.is(incident));
  const incidentOpen = incidentPending || view.live.some(u => u.is(incident));
  const start = view.pending.filter(u => !(incidentOpen && u.is(backup))).sort((a, b) => rank(a) - rank(b));
  const preempt = incidentPending
    ? view.live.filter(u => u.position === 'active' && (u.is(heartbeat) || u.is(renewal)))
    : [];
  return { start, preempt };
});

const control = http.control({
  port: 8080,
  token: H.env('CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(acknowledged, confirmed), H.ops.readMemory, H.ops.readTelemetry],
});

const incidentNotices = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'new'} → ${entry.to}`
      : null,
});

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(failingHeartbeatsOpenIncident, failedBackupOpensIncident, slowBackupNotes)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentNotices, markdown.board('BOARD.md'));
