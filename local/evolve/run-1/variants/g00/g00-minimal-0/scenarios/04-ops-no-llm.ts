import { z } from 'zod';
import { H, PendingView } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const Heartbeat = H.kind('Heartbeat').data(z.object({ service: z.string(), url: z.string() })).states({
  due: 'pending',
  probing: 'active',
  healthy: 'succeeded',
  down: 'failed',
}, 'due');

const Backup = H.kind('Backup').data(z.object({ database: z.string(), host: z.string() })).states({
  due: 'pending',
  running: 'active',
  done: 'succeeded',
  failed: 'failed',
}, 'due');

const CertificateRenewal = H.kind('CertificateRenewal').data(z.object({ domain: z.string(), host: z.string() })).states({
  due: 'pending',
  checking: 'active',
  renewing: 'active',
  valid: 'succeeded',
  renewed: 'succeeded',
  failed: 'failed',
}, 'due');

const Incident = H.kind('Incident').data(z.object({
  title: z.string(),
  detail: z.string(),
  runbook: z.string(),
})).states({
  open: 'pending',
  acknowledging: 'active',
  remediating: 'active',
  confirming: 'active',
  resolved: 'succeeded',
  unresolved: 'failed',
  cancelled: 'cancelled',
}, 'open');

const OpsExperience = H.memory('operational-experience', 'fallible');
const opsJournal = H.library('ops-experience', OpsExperience, jsonl.memory('memory/ops.jsonl'));

const local = shell.local('local', { slots: 4 });
const sshKey = H.env('OPS_SSH_KEY');
const diskPreflight = ['test $(df --output=avail /var/backups | tail -1) -gt 52428800'];
const hostA = ssh.host('db-host-a', { address: 'db-a.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskPreflight });
const hostB = ssh.host('db-host-b', { address: 'db-b.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskPreflight });
const hostFor = (input: { readonly host: string }) => input.host === hostA.name ? hostA : hostB;

const ping = H.command('ping')
  .input(z.object({ url: z.string() }))
  .argv(input => ['curl', '-fsS', '--max-time', '10', input.url])
  .on(local);

const backup = H.command('backup-database')
  .input(z.object({ database: z.string(), host: z.string() }))
  .argv(input => ['backup-db', input.database])
  .on(hostFor);

const certificateDays = H.command('certificate-days-left')
  .input(z.object({ domain: z.string(), host: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['cert-days-left', '--json', input.domain])
  .on(hostFor);

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string(), host: z.string() }))
  .argv(input => ['renew-cert', input.domain])
  .on(hostFor);

const runbook = H.command('runbook')
  .input(z.object({ runbook: z.string() }))
  .argv(input => ['run-runbook', input.runbook])
  .on(local);

const heartbeatFlow = H.flow('heartbeat').for(Heartbeat).does(async ctx => {
  await ctx.move('probing');
  const probe = await ctx.run(ping, { url: ctx.unit.data.url });
  return probe.ok ? 'healthy' : 'down';
});

const backupFlow = H.flow('backup').for(Backup).does(async ctx => {
  await ctx.move('running');
  const result = await ctx.run(backup, ctx.unit.data);
  return result.ok ? 'done' : 'failed';
});

const renewalFlow = H.flow('certificate-renewal').for(CertificateRenewal).does(async ctx => {
  await ctx.move('checking');
  const check = await ctx.run(certificateDays, ctx.unit.data);
  if (!check.ok) return 'failed';
  if (check.value.daysLeft >= 14) return 'valid';
  await ctx.move('renewing');
  const renewal = await ctx.run(renewCertificate, ctx.unit.data);
  return renewal.ok ? 'renewed' : 'failed';
});

const incidentFlow = H.flow('incident-runbook').for(Incident).does(async ctx => {
  await ctx.move('acknowledging');
  await ctx.halt({
    name: 'acknowledge',
    show: `${ctx.unit.data.title}\n\n${ctx.unit.data.detail}`,
    decision: z.object({ acknowledgedBy: z.string() }),
  });
  await ctx.move('remediating');
  const remediation = await ctx.run(runbook, { runbook: ctx.unit.data.runbook });
  await ctx.move('confirming');
  const confirmation = await ctx.halt({
    name: 'confirm-resolution',
    show: remediation.ok ? `Runbook ${ctx.unit.data.runbook} completed.` : `Runbook failed: ${remediation.error}`,
    decision: z.object({ resolved: z.boolean() }),
  });
  return confirmation.resolved ? 'resolved' : 'unresolved';
});

const services = [
  { service: 'api', url: 'https://api.internal/health' },
  { service: 'queue', url: 'https://queue.internal/health' },
];
const databases = [
  { database: 'orders', host: hostA.name },
  { database: 'users', host: hostB.name },
];
const domains = [
  { domain: 'example.com', host: hostA.name },
  { domain: 'api.example.com', host: hostB.name },
];
const dayOf = (date: Date) => date.toISOString().slice(0, 10);

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatFlow)
  .suppliers(H.schedule('every-five-minutes', Heartbeat, { every: { minutes: 5 } }, tick =>
    services.map(service => ({ create: service, key: `${service.service}-${tick.now.toISOString()}` }))));

const backupLane = H.lane('backups', Backup)
  .handler(backupFlow)
  .suppliers(H.schedule('nightly', Backup, { daily: '01:00' }, tick =>
    databases.map(db => ({ create: db, key: `${db.database}-${dayOf(tick.now)}` }))));

const renewalLane = H.lane('certificate-renewals', CertificateRenewal)
  .handler(renewalFlow)
  .suppliers(H.schedule('weekly', CertificateRenewal, { weekly: { day: 'mon', at: '04:00' } }, tick =>
    domains.map(domain => ({ create: domain, key: `${domain.domain}-${dayOf(tick.now)}` }))));

const incidentLane = H.lane('incidents', Incident)
  .handler(incidentFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Incident, '.harness/incidents.db'));

const repeatedHeartbeatFailure = H.trigger(
  'three-failed-heartbeats',
  H.on.streak(Heartbeat, 'down', 3, data => data.service),
  (event, act) => act.create(incidentLane, {
    title: `${event.unit.data.service} is down`,
    detail: `Three consecutive heartbeats failed against ${event.unit.data.url}.`,
    runbook: `restart-${event.unit.data.service}`,
  }),
);

const failedBackup = H.trigger('failed-backup', H.on.enters(Backup, 'failed'), (event, act) =>
  act.create(incidentLane, {
    title: `Backup of ${event.unit.data.database} failed`,
    detail: `Backup unit ${event.unit.key} on ${event.unit.data.host} failed.`,
    runbook: `verify-backup-${event.unit.data.database}`,
  }));

const twoHoursMs = 2 * 60 * 60 * 1000;
const slowBackup = H.trigger('slow-backup', H.on.enters(Backup, 'done'), (event, act) =>
  (event.attempt?.durationMs ?? 0) > twoHoursMs
    ? act.remember(opsJournal, {
        text: `When scheduling the ${event.unit.data.database} backup, allow more than two hours`,
        because: `the run of ${event.unit.key} took ${Math.round((event.attempt?.durationMs ?? 0) / 60000)} minutes`,
        when: { kinds: [Backup.name], resources: [event.unit.data.database, event.unit.data.host] },
      })
    : []);

const rank = (unit: PendingView): number => {
  if (unit.is(Incident)) return 0;
  if (unit.is(Heartbeat)) return 1;
  return 2;
};

const incidentsFirst = H.policy.schedule('incidents-first', view => {
  const incidentActive = view.active.some(unit => unit.is(Incident));
  const incidentWaiting = view.pending.some(unit => unit.is(Incident));
  const start = [...view.pending]
    .filter(unit => !(incidentActive && unit.is(Backup)))
    .sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs);
  const preempt = incidentWaiting ? view.active.filter(unit => unit.is(Heartbeat)) : [];
  return { start, preempt };
});

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidentLane, heartbeatLane, backupLane, renewalLane)
  .triggers(repeatedHeartbeatFailure, failedBackup, slowBackup)
  .scheduler(incidentsFirst)
  .clients(http.control({
    port: 8080,
    token: H.env('OPS_CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
  }))
  .observers(
    slack.notify({
      webhook: H.env('SLACK_OPS_WEBHOOK'),
      message: entry => entry.entry === 'transition' && entry.kind === Incident.name
        ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'new'} → ${entry.to}`
        : null,
    }),
    markdown.board('BOARD.md'),
  );
