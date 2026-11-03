import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, Runner } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const databases = H.resources('databases', ['orders', 'users']);
const domains = H.resources('domains', ['api.example.com', 'www.example.com']);
const services = ['api', 'web', 'queue'];

const Heartbeat = H.kind('Heartbeat')
  .data(z.object({ service: z.string() }))
  .states({ due: 'pending', checking: 'active', up: 'success', down: 'failure' }, 'due');

const Backup = H.kind('Backup')
  .data(z.object({ database: databases.schema }))
  .states({ due: 'pending', running: 'active', done: 'success', failed: 'failure' }, 'due')
  .onFailure('failed');

const CertificateRenewal = H.kind('CertificateRenewal')
  .data(z.object({ domain: domains.schema }))
  .states({ due: 'pending', checking: 'active', renewing: 'active', valid: 'success', renewed: 'success' }, 'due');

const Incident = H.kind('Incident')
  .data(z.object({ title: z.string(), service: z.string(), origin: z.string() }))
  .states({ open: 'pending', paging: 'active', mitigating: 'active', resolved: 'success', unresolved: 'failure' }, 'open');

const opsExperience = H.memory('operational-experience', 'fallible');
const opsJournal = H.library('ops-journal', opsExperience, jsonl.memory('memory/ops.jsonl'));

const diskPreflight = ['test "$(df --output=avail -k /var/backups | tail -1)" -gt 52428800'];

const local = shell.local('local', { slots: 4 });
const hostA = ssh.host('db-host-a', { address: 'db-a.internal', user: 'ops', key: H.env('SSH_KEY_A'), slots: 1, preflight: diskPreflight });
const hostB = ssh.host('db-host-b', { address: 'db-b.internal', user: 'ops', key: H.env('SSH_KEY_B'), slots: 1, preflight: diskPreflight });

const databaseHost: Record<'orders' | 'users', Runner> = { orders: hostA, users: hostB };
const domainHost: Record<'api.example.com' | 'www.example.com', Runner> = { 'api.example.com': hostA, 'www.example.com': hostB };

const probe = H.command('probe')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .restart('rerun');

const runBackup = H.command('backup')
  .input(z.object({ database: databases.schema }))
  .argv(input => ['/opt/ops/backup.sh', input.database])
  .on(input => databaseHost[input.database]);

const checkExpiry = H.command('check-certificate')
  .input(z.object({ domain: domains.schema }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['/opt/ops/cert-days-left.sh', input.domain])
  .on(input => domainHost[input.domain])
  .restart('rerun');

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: domains.schema }))
  .argv(input => ['certbot', 'renew', '--cert-name', input.domain])
  .on(input => domainHost[input.domain]);

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string(), service: z.string() }))
  .argv(input => ['/opt/ops/page.sh', '--service', input.service, '--title', input.title])
  .on(local);

const runbook = H.command('runbook')
  .input(z.object({ service: z.string() }))
  .argv(input => ['/opt/ops/runbooks/restart.sh', input.service])
  .on(local);

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async ctx => {
    await ctx.move('checking');
    const probed = await ctx.run(probe, { service: ctx.unit.data.service });
    return probed.ok ? 'up' : 'down';
  });

const backupFlow = H.flow('backup')
  .for(Backup)
  .does(async ctx => {
    await ctx.move('running');
    const result = await ctx.run(runBackup, { database: ctx.unit.data.database });
    return result.ok ? 'done' : ctx.fail(result.error);
  });

const renewalFlow = H.flow('check-and-renew')
  .for(CertificateRenewal)
  .does(async ctx => {
    await ctx.move('checking');
    const checked = await ctx.run(checkExpiry, { domain: ctx.unit.data.domain });
    if (checked.ok === false) return ctx.fail(checked.error);
    if (checked.value.daysLeft >= 14) return 'valid';
    await ctx.move('renewing');
    const renewed = await ctx.run(renewCertificate, { domain: ctx.unit.data.domain });
    if (renewed.ok === false) return ctx.fail(renewed.error);
    return 'renewed';
  });

const incidentFlow = H.flow('incident-runbook')
  .for(Incident)
  .does(async ctx => {
    await ctx.move('paging');
    await ctx.run(pageOnCall, { title: ctx.unit.data.title, service: ctx.unit.data.service });
    const ack = await ctx.halt({
      name: 'acknowledge',
      show: `${ctx.unit.data.title} (${ctx.unit.data.origin})`,
      decision: z.object({ by: z.string() }),
    });
    ctx.tag({ acknowledgedBy: ack.by });
    await ctx.move('mitigating');
    const ran = await ctx.run(runbook, { service: ctx.unit.data.service });
    const confirmation = await ctx.halt({
      name: 'confirm-resolution',
      show: ran.ok ? `Runbook output:\n${ran.value}` : `Runbook failed: ${ran.error}`,
      decision: z.object({ resolved: z.boolean(), notes: z.string() }),
    });
    return confirmation.resolved ? 'resolved' : 'unresolved';
  });

const everyFiveMinutes = H.recurring('heartbeat-schedule', Heartbeat, { every: { minutes: 5 } }, tick =>
  services.map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
);
const nightly = H.recurring('backup-schedule', Backup, { daily: '01:00' }, tick =>
  databases.ids.map(database => ({ create: { database }, key: `${database}-${tick.now.toISOString().slice(0, 10)}` }))
);
const weekly = H.recurring('renewal-schedule', CertificateRenewal, { weekly: { day: 'mon', at: '04:00' } }, tick =>
  domains.ids.map(domain => ({ create: { domain }, key: `${domain}-${tick.now.toISOString().slice(0, 10)}` }))
);

const retryHourly = H.policy.retry('retry-hourly-three-times', view =>
  view.failures >= 3 ? 'stop' : { retryInMs: 60 * 60 * 1000 }
);

const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(everyFiveMinutes);
const backups = H.lane('backups', Backup)
  .handler(backupFlow)
  .suppliers(nightly)
  .touches(data => [databases.of(data.database)]);
const renewals = H.lane('renewals', CertificateRenewal)
  .handler(renewalFlow)
  .suppliers(weekly)
  .retry(retryHourly)
  .touches(data => [domains.of(data.domain)]);
const incidents = H.lane('incidents', Incident).handler(incidentFlow).suppliers(H.operator);

const threeDownHeartbeats = H.trigger(
  'three-down-heartbeats',
  H.on.streak(Heartbeat, 'down', 3, data => data.service),
  (event, act) =>
    act.create(
      incidents,
      { title: `${event.unit.data.service} failed ${event.streak ?? 3} heartbeats in a row`, service: event.unit.data.service, origin: 'heartbeat' },
      { dedupe: `heartbeat-${event.unit.data.service}` }
    )
);

const failedBackup = H.trigger('failed-backup', H.on.enters(Backup, 'failed'), (event, act) =>
  act.create(
    incidents,
    { title: `Backup of ${event.unit.data.database} failed`, service: event.unit.data.database, origin: 'backup' },
    { key: `backup-incident-${event.unit.key}` }
  )
);

const twoHoursMs = 2 * 60 * 60 * 1000;

const slowBackup = H.trigger('slow-backup-noted', H.on.enters(Backup, 'done'), (event, act) => {
  const durationMs = event.attempt?.durationMs ?? 0;
  if (durationMs <= twoHoursMs) return [];
  return act.remember(opsJournal, {
    text: `When scheduling the ${event.unit.data.database} backup, allow more than two hours`,
    because: `the run finishing ${event.at.toISOString()} took ${Math.round(durationMs / 60000)} minutes`,
    when: { kinds: [Backup], resources: [databases.of(event.unit.data.database)] },
  });
});

const rank = (unit: PendingView): number => {
  if (unit.kind === Incident.name) return 0;
  if (unit.kind === Heartbeat.name) return 1;
  if (unit.kind === CertificateRenewal.name) return 2;
  return 3;
};

const incidentsFirst = H.policy.scheduler('incidents-preempt', view => {
  const incidentPending = view.pending.some(unit => unit.kind === Incident.name);
  const incidentOpen = incidentPending || view.active.some(unit => unit.kind === Incident.name);
  const start = view.pending
    .filter(unit => (unit.kind === Backup.name ? incidentOpen === false : true))
    .sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs);
  const preempt = incidentPending
    ? view.active.filter(unit => unit.kind === Heartbeat.name || unit.kind === CertificateRenewal.name)
    : [];
  return { start, preempt };
});

const incidentNotices = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === Incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'created'} → ${entry.to}`
      : null,
});

const control = http.control({
  port: H.slot.port(0),
  token: H.env('CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
});

export default H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(threeDownHeartbeats, failedBackup, slowBackup)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentNotices, markdown.board('BOARD.md'));
