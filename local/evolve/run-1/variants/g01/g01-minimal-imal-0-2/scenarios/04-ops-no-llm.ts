import { z } from 'zod';
import { H, type Runner } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';

const Due = H.state('due', 'pending');
const Checking = H.state('checking', 'active');
const Healthy = H.state('healthy', 'terminal', 'success');
const Unhealthy = H.state('unhealthy', 'terminal', 'failure');
const Scheduled = H.state('scheduled', 'pending');
const Running = H.state('running', 'active');
const BackedUp = H.state('backed-up', 'terminal', 'success');
const Failed = H.state('failed', 'terminal', 'failure');
const Renewing = H.state('renewing', 'active');
const Renewed = H.state('renewed', 'terminal', 'success');
const StillValid = H.state('still-valid', 'terminal', 'neutral');
const Open = H.state('open', 'pending');
const Responding = H.state('responding', 'active');
const Resolved = H.state('resolved', 'terminal', 'success');

const host = z.enum(['db-1', 'db-2']);

const Heartbeat = H.kind('heartbeat')
  .data(z.object({ service: z.string(), url: z.string() }))
  .states(Due, Checking, Healthy, Unhealthy);
const Backup = H.kind('backup')
  .data(z.object({ database: z.string(), host }))
  .states(Scheduled, Running, BackedUp, Failed);
const CertificateRenewal = H.kind('certificate-renewal')
  .data(z.object({ domain: z.string(), host }))
  .states(Due, Checking, Renewing, Renewed, StillValid, Failed);
const Incident = H.kind('incident')
  .data(z.object({ title: z.string(), service: z.string() }))
  .states(Open, Responding, Resolved);

const diskSpacePreflight = ['sh', '-c', 'test "$(df --output=avail -k /var/backups | tail -1)" -gt 20971520'];

const hosts = {
  'db-1': ssh.host('db-1', { address: 'db-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskSpacePreflight }),
  'db-2': ssh.host('db-2', { address: 'db-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskSpacePreflight }),
};
const local = shell.local('local', { slots: 4 });

const backupOn = (runner: Runner) => H.command(`backup-on-${runner.name}`)
  .input(z.object({ database: z.string() }))
  .argv(i => ['pg-backup', '--database', i.database])
  .on(runner)
  .recovery('rerun');

const certificateCheckOn = (runner: Runner) => H.command(`certificate-check-on-${runner.name}`)
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(i => ['cert-days-left', i.domain])
  .on(runner)
  .recovery('rerun');

const certificateRenewOn = (runner: Runner) => H.command(`certificate-renew-on-${runner.name}`)
  .input(z.object({ domain: z.string() }))
  .argv(i => ['cert-renew', i.domain])
  .on(runner)
  .recovery('rerun');

const backupCommands = { 'db-1': backupOn(hosts['db-1']), 'db-2': backupOn(hosts['db-2']) };
const certificateChecks = { 'db-1': certificateCheckOn(hosts['db-1']), 'db-2': certificateCheckOn(hosts['db-2']) };
const certificateRenewals = { 'db-1': certificateRenewOn(hosts['db-1']), 'db-2': certificateRenewOn(hosts['db-2']) };

const healthProbe = H.command('health-probe')
  .input(z.object({ url: z.string() }))
  .argv(i => ['curl', '--fail', '--silent', i.url])
  .on(local)
  .recovery('rerun');

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(i => ['pager', 'trigger', '--summary', i.title])
  .on(local)
  .recovery('park');

const runbook = H.command('runbook')
  .input(z.object({ service: z.string() }))
  .argv(i => ['runbook', 'remediate', i.service])
  .on(local)
  .recovery('park');

const heartbeatFlow = H.flow('heartbeat').for(Heartbeat).does(async ctx => {
  await ctx.move('checking');
  const probe = await ctx.run(healthProbe, { url: ctx.unit.data.url });
  return probe.ok ? 'healthy' : 'unhealthy';
});

const backupFlow = H.flow('backup').for(Backup).does(async ctx => {
  await ctx.move('running');
  const result = await ctx.run(backupCommands[ctx.unit.data.host], { database: ctx.unit.data.database });
  return result.ok ? 'backed-up' : 'failed';
});

const renewalFlow = H.flow('certificate-renewal').for(CertificateRenewal).does(async ctx => {
  const { domain } = ctx.unit.data;
  await ctx.move('checking');
  const check = await ctx.run(certificateChecks[ctx.unit.data.host], { domain });
  if (!check.ok) return 'failed';
  if (check.value.daysLeft >= 14) return 'still-valid';
  await ctx.move('renewing');
  const renewed = await ctx.run(certificateRenewals[ctx.unit.data.host], { domain });
  return renewed.ok ? 'renewed' : 'failed';
});

const incidentFlow = H.flow('incident-runbook').for(Incident).does(async ctx => {
  const { title, service } = ctx.unit.data;
  await ctx.move('responding');
  await ctx.run(pageOnCall, { title });
  await ctx.halt({
    name: 'acknowledge',
    show: title,
    decision: z.object({ by: z.string() }),
  });
  const remediation = await ctx.run(runbook, { service });
  const confirmation = await ctx.halt({
    name: 'confirm-resolution',
    show: remediation.ok ? remediation.value : remediation.error,
    decision: z.object({ resolved: z.boolean(), note: z.string().optional() }),
  });
  return confirmation.resolved ? 'resolved' : 'open';
});

const services = [
  { service: 'api', url: 'https://api.internal/health' },
  { service: 'queue', url: 'https://queue.internal/health' },
];
const databases = [
  { database: 'orders', host: 'db-1' },
  { database: 'customers', host: 'db-2' },
] satisfies readonly { database: string; host: 'db-1' | 'db-2' }[];
const domains = [
  { domain: 'example.com', host: 'db-1' },
  { domain: 'api.example.com', host: 'db-2' },
] satisfies readonly { domain: string; host: 'db-1' | 'db-2' }[];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatFlow)
  .suppliers(H.clock('heartbeat-clock', Heartbeat, { every: { minutes: 5 } }, () =>
    services.map(s => ({ create: s, key: `heartbeat-${s.service}` }))));

const backups = H.lane('backups', Backup)
  .handler(backupFlow)
  .suppliers(H.clock('nightly-backups', Backup, { daily: '01:00' }, tick =>
    databases.map(d => ({ create: d, key: `backup-${d.database}-${tick.now.toISOString().slice(0, 10)}` }))))
  .store(sqlite.store(Backup, '.harness/ops.db'));

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .handler(renewalFlow)
  .suppliers(H.clock('weekly-certificate-check', CertificateRenewal, { weekly: { day: 'mon', at: '04:00' } }, tick =>
    domains.map(d => ({ create: d, key: `certificate-${d.domain}-${tick.now.toISOString().slice(0, 10)}` }))));

const incidents = H.lane('incidents', Incident)
  .handler(incidentFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Incident, '.harness/ops.db'));

const operationalExperience = H.memory('operational-experience', 'experience');
const opsJournal = H.library('ops-journal', operationalExperience, jsonl.memory('memory/ops.jsonl'));

const slowBackupMs = 2 * 60 * 60 * 1000;

const heartbeatStreakOpensIncident = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(Heartbeat, 'unhealthy', 3, data => data.service),
  (event, act) => act.create(incidents, {
    title: `${event.unit.data.service} failed three heartbeats in a row`,
    service: event.unit.data.service,
  }, `incident-heartbeat-${event.unit.data.service}`),
);

const failedBackupOpensIncident = H.trigger(
  'failed-backup-opens-incident',
  H.on.enters(Backup, 'failed'),
  (event, act) => act.create(incidents, {
    title: `Backup of ${event.unit.data.database} on ${event.unit.data.host} failed`,
    service: event.unit.data.database,
  }, `incident-backup-${event.unit.data.database}`),
);

const slowBackupNoted = H.trigger(
  'slow-backup-noted',
  H.on.enters(Backup, 'backed-up'),
  (event, act) => {
    const durationMs = event.attempt?.durationMs ?? 0;
    if (durationMs <= slowBackupMs) return [];
    return act.remember(opsJournal, {
      text: `When scheduling work on ${event.unit.data.host} after 01:00, leave room for the ${event.unit.data.database} backup`,
      because: `its backup took ${Math.round(durationMs / 60000)} minutes on ${event.at.toISOString().slice(0, 10)}`,
      when: { kinds: [Backup.name], resources: [event.unit.data.database, event.unit.data.host] },
    });
  },
);

const laneOrder: Readonly<Record<string, number>> = {
  [incidents.name]: 0,
  [heartbeats.name]: 1,
  [renewals.name]: 2,
  [backups.name]: 3,
};

const incidentsPreempt = H.policy.scheduler('incidents-preempt', view => {
  const incidentPending = view.pending.some(u => u.lane === incidents.name);
  const incidentLive = incidentPending || view.active.some(u => u.lane === incidents.name);
  const start = view.pending
    .filter(u => !(incidentLive && u.lane === backups.name))
    .sort((a, b) => (laneOrder[a.lane] ?? 9) - (laneOrder[b.lane] ?? 9) || b.waitedMs - a.waitedMs);
  const preempt = incidentPending
    ? view.active.filter(a => a.lane === heartbeats.name && !a.blocked)
    : [];
  return { start, preempt };
});

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ops-ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupNoted)
  .scheduler(incidentsPreempt)
  .clients(http.control({
    port: 8080,
    token: H.env('OPS_CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
  }))
  .observers(
    markdown.board('BOARD.md'),
    slack.notify({
      webhook: H.env('SLACK_WEBHOOK_URL'),
      message: entry => entry.entry === 'transition' && entry.kind === Incident.name
        ? `Incident ${entry.unit ?? 'unknown'}: ${entry.from ?? 'created'} -> ${entry.to}`
        : null,
    }),
  );
