import { H, type PendingView } from 'harness-dsl';
import { z } from 'zod';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

export const due = H.state('due', 'pending');
export const up = H.state('up', 'terminal', 'success');
export const failed = H.state('failed', 'terminal', 'failure');
export const backedUp = H.state('backedUp', 'terminal', 'success');
export const certificateValid = H.state('certificateValid', 'terminal', 'success');
export const renewed = H.state('renewed', 'terminal', 'success');
export const reported = H.state('reported', 'pending');
export const mitigating = H.state('mitigating', 'active');
export const resolved = H.state('resolved', 'terminal', 'success');

export const Heartbeat = H.kind('Heartbeat').data(z.object({ service: z.string() })).states(due, up, failed);
export const Backup = H.kind('Backup').data(z.object({ database: z.string() })).states(due, backedUp, failed);
export const CertificateRenewal = H.kind('CertificateRenewal')
  .data(z.object({ domain: z.string() }))
  .states(due, certificateValid, renewed, failed);
export const Incident = H.kind('Incident')
  .data(z.object({ title: z.string(), source: z.string(), runbook: z.string() }))
  .states(reported, mitigating, resolved);

export const local = shell.local('local', { slots: 4 });

const diskPreflight = ['sh', '-c', 'test "$(df --output=avail -k /var/backups | tail -1)" -gt 20971520'];

export const hostA = ssh.host('ops-host-a', {
  address: 'ops-a.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskPreflight,
});
export const hostB = ssh.host('ops-host-b', {
  address: 'ops-b.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskPreflight,
});

export const probe = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['curl', '-fsS', '--max-time', '10', `https://${input.service}.internal/health`])
  .on(local)
  .recovers('rerun');

export const dumpDatabase = H.command('dump-database')
  .input(z.object({ database: z.string() }))
  .argv((input) => ['backup-db', '--database', input.database])
  .on(hostA, hostB)
  .recovers('rerun');

export const certificateDays = H.command('certificate-days-left')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv((input) => ['cert-days-left', input.domain])
  .on(hostA, hostB)
  .recovers('rerun');

export const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv((input) => ['certbot', 'renew', '--cert-name', input.domain])
  .on(hostA, hostB)
  .recovers('rerun');

export const pageOncall = H.command('page-oncall')
  .input(z.object({ title: z.string() }))
  .argv((input) => ['page', '--team', 'platform', '--summary', input.title])
  .on(local)
  .recovers('park');

export const runRunbook = H.command('run-runbook')
  .input(z.object({ runbook: z.string() }))
  .argv((input) => ['runbook', input.runbook])
  .on(local)
  .recovers('park');

export const acknowledge = H.halt('acknowledge-incident', z.object({ by: z.string() }));
export const confirmResolution = H.halt('confirm-resolution', z.object({ resolved: z.boolean(), note: z.string() }));

export const heartbeatFlow = H.flow('heartbeat').for(Heartbeat).does(async (ctx) => {
  const probed = await ctx.run(probe, { service: ctx.unit.data.service });
  return probed.ok ? 'up' : 'failed';
});

export const backupFlow = H.flow('backup').for(Backup).does(async (ctx) => {
  const dumped = await ctx.run(dumpDatabase, { database: ctx.unit.data.database });
  return dumped.ok ? 'backedUp' : 'failed';
});

const renewWithinDays = 14;

export const renewalFlow = H.flow('certificate-renewal').for(CertificateRenewal).does(async (ctx) => {
  const { domain } = ctx.unit.data;
  const checked = await ctx.run(certificateDays, { domain });
  if (checked.ok === false) return 'failed';
  if (checked.value.daysLeft >= renewWithinDays) return 'certificateValid';
  const renewal = await ctx.run(renewCertificate, { domain });
  return renewal.ok ? 'renewed' : 'failed';
});

export const incidentFlow = H.flow('incident-runbook').for(Incident).does(async (ctx) => {
  const { title, runbook } = ctx.unit.data;
  await ctx.run(pageOncall, { title });
  await ctx.halt(acknowledge, `Incident: ${title}`);
  await ctx.move('mitigating');
  while (true) {
    const ran = await ctx.run(runRunbook, { runbook });
    const outcome = ran.ok ? `Runbook ${runbook} finished:\n${ran.value}` : `Runbook ${runbook} failed: ${ran.error}`;
    const confirmation = await ctx.halt(confirmResolution, outcome);
    if (confirmation.resolved) return 'resolved';
  }
});

export const services = ['api', 'worker', 'gateway'] as const;
export const databases = ['orders', 'users'] as const;
export const domains = ['example.com', 'api.example.com'] as const;

export const heartbeatClock = H.clock('heartbeat-every-five-minutes', Heartbeat, { every: { minutes: 5 } }, (tick) =>
  services.map((service) => ({ create: { service }, key: `${service}@${tick.now.toISOString()}` })));

export const backupClock = H.clock('nightly-backups', Backup, { daily: '01:00' }, (tick) =>
  databases.map((database) => ({ create: { database }, key: `${database}@${tick.now.toISOString().slice(0, 10)}` })));

export const renewalClock = H.clock('weekly-certificate-check', CertificateRenewal, { weekly: { day: 'mon', at: '04:00' } }, (tick) =>
  domains.map((domain) => ({ create: { domain }, key: `${domain}@${tick.now.toISOString().slice(0, 10)}` })));

export const heartbeatLane = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(heartbeatClock);
export const backupLane = H.lane('backups', Backup).handler(backupFlow).suppliers(backupClock);
export const renewalLane = H.lane('renewals', CertificateRenewal).handler(renewalFlow).suppliers(renewalClock);
export const incidentLane = H.lane('incidents', Incident).handler(incidentFlow).suppliers(H.operator);

export const operationalExperience = H.memory('operational-experience', 'experience');
export const opsArchive = H.archive('operational-experience', operationalExperience, jsonl.memory('.harness/ops-notes.jsonl'));

export const heartbeatStreak = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(Heartbeat, 'failed', 3, (data) => data.service),
  (event, act) => act.create(
    incidentLane,
    {
      title: `${event.unit.data.service} failed three heartbeats in a row`,
      source: 'heartbeat',
      runbook: `restart-${event.unit.data.service}`,
    },
    `heartbeat-${event.unit.data.service}`,
  ),
);

export const backupFailure = H.trigger(
  'failed-backup-opens-incident',
  H.on.enters(Backup, 'failed'),
  (event, act) => act.create(
    incidentLane,
    { title: `Backup of ${event.unit.data.database} failed`, source: 'backup', runbook: `inspect-backup-${event.unit.data.database}` },
    `backup-${event.unit.data.database}`,
  ),
);

const slowBackupMs = 2 * 60 * 60 * 1000;

export const slowBackupNote = H.trigger(
  'slow-backup-records-note',
  H.on.enters(Backup, 'backedUp'),
  (event, act) => {
    const attempt = event.attempt;
    if (attempt === undefined || attempt.durationMs <= slowBackupMs) return [];
    return act.remember(opsArchive, {
      text: `When scheduling the ${event.unit.data.database} backup, expect it to run past two hours and keep the window clear`,
      because: `the backup on ${event.at.toISOString()} took ${Math.round(attempt.durationMs / 60_000)} minutes`,
      when: { kinds: [Backup.name], resources: [event.unit.data.database] },
    });
  },
);

export const incidentsFirst = H.policy.scheduler('incidents-preempt', (view) => {
  const incidentPending = view.pending.some((unit) => unit.is(Incident));
  const incidentActive = view.active.some((unit) => unit.is(Incident)) || incidentPending;
  const rank = (unit: PendingView): number => {
    if (unit.is(Incident)) return 0;
    if (unit.is(Heartbeat)) return 1;
    return 2;
  };
  const startable = view.pending.filter((unit) => incidentActive ? unit.is(Backup) === false : true);
  const preempt = incidentPending
    ? view.active.filter((unit) => unit.is(Backup) === false && unit.is(Incident) === false && unit.runners.includes(local.name))
    : [];
  return { start: [...startable].sort((a, b) => rank(a) - rank(b)), preempt };
});

export const control = http.control({
  port: 8780,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
});

export const incidentNotice = slack.notify({
  webhook: H.env('SLACK_OPS_WEBHOOK'),
  on: { entry: 'transition', kind: Incident },
  message: (entry) => entry.entry === 'transition'
    ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'created'} -> ${entry.to}`
    : `Incident ${entry.unit ?? ''}: ${entry.entry}`,
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidentLane, heartbeatLane, backupLane, renewalLane)
  .triggers(heartbeatStreak, backupFailure, slowBackupNote)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentNotice, markdown.board('BOARD.md'));
