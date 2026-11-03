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

const hostSchema = z.enum(['db-1', 'db-2']);
type HostName = z.infer<typeof hostSchema>;

const Heartbeat = H.kind('Heartbeat')
  .data(z.object({ service: z.string() }))
  .states(
    [
      H.state.pending('due'),
      H.state.active('probing'),
      H.state.terminal('up', 'success'),
      H.state.terminal('down', 'failure'),
    ],
    'due'
  );

const Backup = H.kind('Backup')
  .data(z.object({ database: z.string(), host: hostSchema }))
  .states(
    [
      H.state.pending('scheduled'),
      H.state.active('backing-up'),
      H.state.terminal('backed-up', 'success'),
      H.state.terminal('failed', 'failure'),
    ],
    'scheduled'
  );

const CertificateRenewal = H.kind('CertificateRenewal')
  .data(z.object({ domain: z.string(), host: hostSchema }))
  .states(
    [
      H.state.pending('due'),
      H.state.active('checking'),
      H.state.active('renewing'),
      H.state.terminal('renewed', 'success'),
      H.state.terminal('not-due', 'neutral'),
      H.state.terminal('renewal-failed', 'failure'),
    ],
    'due'
  );

const Incident = H.kind('Incident')
  .data(z.object({ title: z.string(), cause: z.string(), service: z.string().optional() }))
  .states(
    [
      H.state.pending('open'),
      H.state.active('paging'),
      H.state.active('acknowledging'),
      H.state.active('running-runbook'),
      H.state.active('confirming'),
      H.state.terminal('resolved', 'success'),
    ],
    'open'
  );

const OperationalExperience = H.memory('operational-experience', 'fallible');
const opsJournal = H.library('operations-journal', OperationalExperience, jsonl.memory('memory/operations.jsonl'));

const database = H.resource('database');

const local = shell.local('local', { slots: 4 });
const sshKey = H.env('OPS_SSH_KEY');
const diskPreflight = ['test "$(df --output=avail -BG /var/backups | tail -1 | tr -dc 0-9)" -gt 50'];
const hosts: Readonly<Record<HostName, ReturnType<typeof ssh.host>>> = {
  'db-1': ssh.host('db-1', { address: 'db-1.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskPreflight }),
  'db-2': ssh.host('db-2', { address: 'db-2.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskPreflight }),
};

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .restart('rerun');

const runBackup = H.command('run-backup')
  .input(z.object({ database: z.string() }))
  .argv(input => ['/opt/ops/backup.sh', input.database])
  .on(hosts['db-1'])
  .restart('rerun');

const certificateDaysLeft = H.command('certificate-days-left')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['/opt/ops/cert-days-left.sh', input.domain])
  .on(hosts['db-1'])
  .restart('rerun');

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv(input => ['/opt/ops/renew-cert.sh', input.domain])
  .on(hosts['db-1']);

const pageOnCall = H.command('page-on-call')
  .input(z.object({ incident: z.string(), title: z.string() }))
  .argv(input => ['/opt/ops/page.sh', '--incident', input.incident, '--title', input.title])
  .on(local);

const runbook = H.command('incident-runbook')
  .input(z.object({ incident: z.string(), service: z.string() }))
  .argv(input => ['/opt/ops/runbook.sh', input.service, input.incident])
  .on(local);

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async ctx => {
    await ctx.move('probing');
    const probe = await ctx.run(probeService, { service: ctx.unit.data.service });
    return probe.ok ? 'up' : 'down';
  });

const backupFlow = H.flow('backup')
  .for(Backup)
  .does(async ctx => {
    await ctx.move('backing-up');
    const backup = await ctx.run(runBackup, { database: ctx.unit.data.database }, { on: hosts[ctx.unit.data.host] });
    return backup.ok ? 'backed-up' : 'failed';
  });

const renewalFlow = H.flow('certificate-renewal')
  .for(CertificateRenewal)
  .does(async ctx => {
    const { domain, host } = ctx.unit.data;
    await ctx.move('checking');
    const check = await ctx.run(certificateDaysLeft, { domain }, { on: hosts[host] });
    if (!check.ok) return ctx.fail(check.error);
    if (check.value.daysLeft >= 14) return 'not-due';
    await ctx.move('renewing');
    const renewal = await ctx.run(renewCertificate, { domain }, { on: hosts[host] });
    return renewal.ok ? 'renewed' : 'renewal-failed';
  });

const incidentFlow = H.flow('incident-runbook')
  .for(Incident)
  .does(async ctx => {
    const { title, service } = ctx.unit.data;
    await ctx.move('paging');
    const paged = await ctx.run(pageOnCall, { incident: ctx.unit.key, title });
    if (!paged.ok) return ctx.fail(paged.error);
    await ctx.move('acknowledging');
    await ctx.halt({ name: 'acknowledge', show: title, decision: z.object({ by: z.string() }) });
    await ctx.move('running-runbook');
    const ran = await ctx.run(runbook, { incident: ctx.unit.key, service: service ?? 'unknown' });
    await ctx.move('confirming');
    const confirmation = await ctx.halt({
      name: 'confirm-resolution',
      show: ran.ok ? ran.value : `runbook failed: ${ran.error}`,
      decision: z.object({ resolved: z.boolean(), note: z.string() }),
    });
    return confirmation.resolved ? 'resolved' : 'open';
  });

const services = ['api', 'web', 'queue'];
const databases: readonly { readonly name: string; readonly host: HostName }[] = [
  { name: 'orders', host: 'db-1' },
  { name: 'users', host: 'db-2' },
];
const domains: readonly { readonly domain: string; readonly host: HostName }[] = [
  { domain: 'example.com', host: 'db-1' },
  { domain: 'api.example.com', host: 'db-2' },
];

const heartbeatClock = H.timetable('every-five-minutes', Heartbeat, { every: { minutes: 5 } }, tick =>
  services.map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
);

const nightlyBackups = H.timetable('nightly-backups', Backup, { daily: '01:00' }, tick =>
  databases.map(db => ({
    create: { database: db.name, host: db.host },
    key: `${db.name}-${tick.now.toISOString().slice(0, 10)}`,
  }))
);

const weeklyRenewals = H.timetable('weekly-renewals', CertificateRenewal, { weekly: { day: 'mon', at: '03:00' } }, tick =>
  domains.map(entry => ({
    create: { domain: entry.domain, host: entry.host },
    key: `${entry.domain}-${tick.now.toISOString().slice(0, 10)}`,
  }))
);

const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(heartbeatClock);
const backups = H.lane('backups', Backup)
  .handler(backupFlow)
  .suppliers(nightlyBackups)
  .store(sqlite.store(Backup, '.harness/ops.sqlite'));
const renewals = H.lane('renewals', CertificateRenewal)
  .handler(renewalFlow)
  .suppliers(weeklyRenewals)
  .store(sqlite.store(CertificateRenewal, '.harness/ops.sqlite'));
const incidents = H.lane('incidents', Incident)
  .handler(incidentFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Incident, '.harness/ops.sqlite'));

const threeDownHeartbeats = H.trigger(
  'three-down-heartbeats-open-incident',
  H.on.streak(Heartbeat, 'down', 3, data => data.service),
  (event, act) =>
    act.create(
      incidents,
      {
        title: `${event.unit.data.service} down for ${event.streak ?? 3} consecutive heartbeats`,
        cause: 'heartbeat',
        service: event.unit.data.service,
      },
      { oneOpenPer: `heartbeat:${event.unit.data.service}` }
    )
);

const failedBackup = H.trigger('failed-backup-opens-incident', H.on.enters(Backup, 'failed'), (event, act) =>
  act.create(incidents, {
    title: `Backup of ${event.unit.data.database} on ${event.unit.data.host} failed`,
    cause: 'backup',
    service: event.unit.data.database,
  })
);

const slowBackupMs = 2 * 60 * 60 * 1000;

const slowBackup = H.trigger('slow-backup-noted', H.on.enters(Backup, 'backed-up'), (event, act) =>
  event.attempt !== undefined && event.attempt.durationMs > slowBackupMs
    ? act.remember(opsJournal, {
        text: `When scheduling the ${event.unit.data.database} backup, allow more than two hours on ${event.unit.data.host}`,
        because: `the backup finishing ${event.at.toISOString()} took ${Math.round(event.attempt.durationMs / 60000)} minutes`,
        when: { kinds: [Backup], resources: [database.of(event.unit.data.database)] },
      })
    : []
);

const incidentsFirst = H.policy.scheduler('incidents-preempt', view => {
  const incidentActive = view.active.some(unit => unit.kind === Incident.name);
  const incidentPending = view.pending.some(unit => unit.kind === Incident.name);
  const rank = (unit: PendingView) => (unit.kind === Incident.name ? 0 : 1);
  return {
    start: view.pending
      .filter(unit => !(incidentActive && unit.kind === Backup.name))
      .sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
    preempt: incidentPending
      ? view.active.filter(unit => unit.kind !== Backup.name && unit.kind !== Incident.name)
      : [],
  };
});

const control = http.control({
  port: H.slot.port(0),
  token: H.env('CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
});

const incidentNotices = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === Incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'created'} → ${entry.to}`
      : null,
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(threeDownHeartbeats, failedBackup, slowBackup)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentNotices, markdown.board('BOARD.md'));
