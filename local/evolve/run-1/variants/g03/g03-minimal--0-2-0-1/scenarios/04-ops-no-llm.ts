import { z } from 'zod';
import { H } from 'harness-dsl';
import * as http from 'harness-dsl/http';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';

const due = H.state('due', 'pending');
const probing = H.state('probing', 'active');
const healthy = H.state('healthy', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');
const scheduled = H.state('scheduled', 'pending');
const running = H.state('running', 'active');
const completed = H.state('completed', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');
const checking = H.state('checking', 'active');
const renewed = H.state('renewed', 'terminal', 'success');
const notDue = H.state('notDue', 'terminal', 'neutral');
const open = H.state('open', 'pending');
const acknowledging = H.state('acknowledging', 'active');
const mitigating = H.state('mitigating', 'active');
const resolved = H.state('resolved', 'terminal', 'success');

const Heartbeat = H.kind('Heartbeat').data(z.object({ service: z.string() })).states(due, probing, healthy, down);
const Backup = H.kind('Backup')
  .data(z.object({ database: z.string() }))
  .states(scheduled, running, completed, failed)
  .failsTo('failed');
const CertificateRenewal = H.kind('CertificateRenewal')
  .data(z.object({ domain: z.string() }))
  .states(scheduled, checking, renewed, notDue, failed)
  .failsTo('failed');
const Incident = H.kind('Incident')
  .data(z.object({ title: z.string(), origin: z.string(), service: z.string().optional() }))
  .states(open, acknowledging, mitigating, resolved);

const services = ['api', 'web', 'worker'];
const databases = ['orders', 'customers'];
const domains = ['example.com', 'api.example.com'];

const local = shell.local('local', { slots: 4 });
const sshKey = H.env('OPS_SSH_KEY');
const diskPreflight = ['test "$(df --output=avail /var/backups | tail -1)" -gt 10485760'];
const hostA = ssh.host('ops-a', { address: 'ops-a.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskPreflight });
const hostB = ssh.host('ops-b', { address: 'ops-b.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskPreflight });

const probe = H.command('probe')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local);

const backupCommand = H.command('backup')
  .input(z.object({ database: z.string() }))
  .argv((input) => ['backup-db', '--database', input.database])
  .on(hostA, hostB)
  .recovers('rerun');

const expiryCheck = H.command('certificate-expiry')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv((input) => ['cert-days-left', '--domain', input.domain, '--json'])
  .on(hostA, hostB);

const renewCommand = H.command('certificate-renew')
  .input(z.object({ domain: z.string() }))
  .argv((input) => ['cert-renew', '--domain', input.domain])
  .on(hostA, hostB)
  .recovers('rerun');

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv((input) => ['page', '--summary', input.title])
  .on(local)
  .recovers('park');

const runbook = H.command('runbook')
  .input(z.object({ title: z.string(), service: z.string().optional() }))
  .argv((input) => ['runbook', '--incident', input.title, ...(input.service ? ['--service', input.service] : [])])
  .on(local)
  .recovers('park');

const acknowledged = H.halt('incident-acknowledged', z.object({ responder: z.string() }));
const resolutionConfirmed = H.halt('incident-resolved', z.object({ resolved: z.boolean(), note: z.string().optional() }));

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async (ctx) => {
    await ctx.move('probing');
    const result = await ctx.run(probe, { service: ctx.unit.data.service });
    return result.ok ? 'healthy' : 'down';
  });

const backupFlow = H.flow('backup')
  .for(Backup)
  .does(async (ctx) => {
    await ctx.move('running');
    const result = await ctx.run(backupCommand, { database: ctx.unit.data.database });
    return result.ok ? 'completed' : ctx.fail(result.error, 'failed');
  });

const renewalThresholdDays = 14;

const renewalFlow = H.flow('certificate-renewal')
  .for(CertificateRenewal)
  .does(async (ctx) => {
    await ctx.move('checking');
    const { domain } = ctx.unit.data;
    const expiry = await ctx.run(expiryCheck, { domain });
    if (!expiry.ok) return ctx.fail(expiry.error, 'failed');
    if (expiry.value.daysLeft >= renewalThresholdDays) return 'notDue';
    const renewal = await ctx.run(renewCommand, { domain });
    return renewal.ok ? 'renewed' : ctx.fail(renewal.error, 'failed');
  });

const incidentFlow = H.flow('incident-runbook')
  .for(Incident)
  .does(async (ctx) => {
    const { title, service } = ctx.unit.data;
    await ctx.move('acknowledging');
    await ctx.run(pageOnCall, { title });
    await ctx.halt(acknowledged, `Acknowledge incident: ${title}`);
    await ctx.move('mitigating');
    const outcome = await ctx.run(runbook, { title, service });
    const confirmation = await ctx.halt(
      resolutionConfirmed,
      outcome.ok ? `Runbook finished:\n${outcome.value}` : `Runbook failed: ${outcome.error}`
    );
    return confirmation.resolved ? 'resolved' : ctx.fail(confirmation.note ?? 'not resolved');
  });

const heartbeatClock = H.clock('heartbeat-every-5m', Heartbeat, { every: { minutes: 5 } }, () =>
  services.map((service) => ({ create: { service } }))
);
const backupClock = H.clock('backup-nightly', Backup, { daily: '01:00' }, (tick) =>
  databases.map((database) => ({ create: { database }, key: `${database}:${tick.now.toISOString().slice(0, 10)}` }))
);
const renewalClock = H.clock('renewal-weekly', CertificateRenewal, { weekly: { day: 'mon', at: '04:00' } }, () =>
  domains.map((domain) => ({ create: { domain } }))
);

const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(heartbeatClock);
const backups = H.lane('backups', Backup).handler(backupFlow).suppliers(backupClock);
const renewals = H.lane('renewals', CertificateRenewal).handler(renewalFlow).suppliers(renewalClock);
const incidents = H.lane('incidents', Incident).handler(incidentFlow).suppliers(H.operator);

const operationalExperience = H.archive(
  'operational-experience',
  H.memory('operational-experience', 'experience'),
  jsonl.memory('.harness/ops-experience.jsonl')
);

const slowBackupMs = 2 * 60 * 60 * 1000;

const threeDownHeartbeats = H.trigger(
  'three-down-heartbeats-open-incident',
  H.on.streak(Heartbeat, 'down', 3, (data) => data.service),
  (event, act) =>
    act.create(
      incidents,
      {
        title: `${event.unit.data.service} failed three consecutive heartbeats`,
        origin: 'heartbeat',
        service: event.unit.data.service,
      },
      `heartbeat:${event.unit.data.service}`
    )
);

const failedBackup = H.trigger('failed-backup-opens-incident', H.on.enters(Backup, 'failed'), (event, act) =>
  act.create(incidents, { title: `Backup of ${event.unit.data.database} failed`, origin: 'backup' }, `backup:${event.unit.key}`)
);

const slowBackup = H.trigger('slow-backup-records-note', H.on.enters(Backup, 'completed'), (event, act) =>
  event.attempt && event.attempt.durationMs > slowBackupMs
    ? act.remember(operationalExperience, {
        text: `When scheduling the ${event.unit.data.database} backup, start it earlier or split it`,
        because: `the run on ${event.at.toISOString().slice(0, 10)} took ${Math.round(event.attempt.durationMs / 60000)} minutes`,
        when: { kinds: [Backup], tags: [H.tag('database').is(event.unit.data.database)] },
      })
    : []
);

const incidentsFirst = H.policy.scheduler('incidents-preempt', (view) => {
  const urgent = view.pending.filter((unit) => unit.lane === incidents.name);
  const incidentOpen = urgent.length > 0 || view.active.some((unit) => unit.lane === incidents.name);
  const rest = view.pending.filter(
    (unit) => unit.lane !== incidents.name && !(incidentOpen && unit.lane === backups.name)
  );
  return {
    start: [...urgent, ...rest],
    preempt:
      urgent.length > 0
        ? view.active.filter((unit) => unit.lane !== backups.name && unit.lane !== incidents.name)
        : [],
  };
});

const control = http.control({
  port: 8080,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
});

const incidentNotifications = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  on: { entry: 'transition', kind: Incident },
  message: (entry) =>
    entry.entry === 'transition' ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'new'} → ${entry.to}` : entry.entry,
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(threeDownHeartbeats, failedBackup, slowBackup)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentNotifications, markdown.board('BOARD.md'));

export const started = operations.start();
