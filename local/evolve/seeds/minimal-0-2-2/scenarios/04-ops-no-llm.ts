import { H } from 'harness-dsl';
import type { SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const heartbeatDue = H.state('heartbeat-due', 'pending');
const heartbeatChecking = H.state('heartbeat-checking', 'active');
const heartbeatOk = H.state('heartbeat-ok', 'terminal', 'success');
const heartbeatDown = H.state('heartbeat-down', 'terminal', 'failure');

const backupDue = H.state('backup-due', 'pending');
const backupRunning = H.state('backup-running', 'active');
const backupDone = H.state('backup-done', 'terminal', 'success');
const backupFailed = H.state('backup-failed', 'terminal', 'failure');

const certDue = H.state('cert-due', 'pending');
const certChecking = H.state('cert-checking', 'active');
const certRenewing = H.state('cert-renewing', 'active');
const certFresh = H.state('cert-fresh', 'terminal', 'success');
const certRenewed = H.state('cert-renewed', 'terminal', 'success');
const certFailed = H.state('cert-failed', 'terminal', 'failure');

const incidentOpen = H.state('incident-open', 'pending');
const incidentPaging = H.state('incident-paging', 'active');
const incidentRemediating = H.state('incident-remediating', 'active');
const incidentConfirming = H.state('incident-confirming', 'active');
const incidentResolved = H.state('incident-resolved', 'terminal', 'success');

export const Heartbeat = H.kind('heartbeat')
  .data(z.object({ service: z.string() }))
  .states(heartbeatDue, heartbeatChecking, heartbeatOk, heartbeatDown);

export const Backup = H.kind('backup')
  .data(z.object({ database: z.string() }))
  .states(backupDue, backupRunning, backupDone, backupFailed);

export const CertificateRenewal = H.kind('certificate-renewal')
  .data(z.object({ domain: z.string() }))
  .states(certDue, certChecking, certRenewing, certFresh, certRenewed, certFailed);

export const Incident = H.kind('incident')
  .data(z.object({ title: z.string(), source: z.string() }))
  .states(incidentOpen, incidentPaging, incidentRemediating, incidentConfirming, incidentResolved);

const local = shell.local('local', { slots: 4 });
const diskPreflight = ['test "$(df --output=avail -BG /var/backups | tail -n 1 | tr -dc 0-9)" -ge 50'];
const dbHostA = ssh.host('db-host-a', {
  address: 'db-a.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskPreflight,
});
const dbHostB = ssh.host('db-host-b', {
  address: 'db-b.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskPreflight,
});

const heartbeatCheck = H.command('heartbeat-check')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['./ops/heartbeat.sh', input.service])
  .on(local);

const backupDatabase = H.command('backup-database')
  .input(z.object({ database: z.string() }))
  .argv((input) => ['./ops/backup.sh', input.database])
  .on(dbHostA, dbHostB);

const certDaysLeft = H.command('certificate-days-left')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv((input) => ['./ops/cert-days-left.sh', input.domain])
  .on(local);

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv((input) => ['./ops/renew-cert.sh', input.domain])
  .on(dbHostA, dbHostB);

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv((input) => ['./ops/page.sh', input.title])
  .on(local);

const runbook = H.command('incident-runbook')
  .input(z.object({ title: z.string(), source: z.string() }))
  .argv((input) => ['./ops/runbook.sh', input.source, input.title])
  .on(local);

const incidentAcknowledgement = H.halt('incident-acknowledgement', z.object({ acknowledgedBy: z.string() }));
const incidentResolution = H.halt('incident-resolution', z.object({ resolved: z.boolean(), note: z.string() }));

const heartbeatFlow = H.flow('heartbeat').for(Heartbeat).does(async (ctx) => {
  await ctx.move('heartbeat-checking');
  const check = await ctx.run(heartbeatCheck, { service: ctx.unit.data.service });
  return check.ok ? 'heartbeat-ok' : 'heartbeat-down';
});

const backupFlow = H.flow('backup').for(Backup).does(async (ctx) => {
  await ctx.move('backup-running');
  const backup = await ctx.run(backupDatabase, { database: ctx.unit.data.database });
  return backup.ok ? 'backup-done' : 'backup-failed';
});

const renewalFlow = H.flow('certificate-renewal').for(CertificateRenewal).does(async (ctx) => {
  const { domain } = ctx.unit.data;
  await ctx.move('cert-checking');
  const check = await ctx.run(certDaysLeft, { domain });
  if (!check.ok) return ctx.fail(check.error);
  if (check.value.daysLeft >= 14) return 'cert-fresh';
  await ctx.move('cert-renewing');
  const renewal = await ctx.run(renewCertificate, { domain });
  return renewal.ok ? 'cert-renewed' : 'cert-failed';
});

const incidentFlow = H.flow('incident-response').for(Incident).does(async (ctx) => {
  const { title, source } = ctx.unit.data;
  await ctx.move('incident-paging');
  await ctx.run(pageOnCall, { title });
  await ctx.halt(incidentAcknowledgement, `Incident: ${title}`);
  for (;;) {
    await ctx.move('incident-remediating');
    const ran = await ctx.run(runbook, { title, source });
    await ctx.move('incident-confirming');
    const confirmation = await ctx.halt(
      incidentResolution,
      ran.ok ? `Runbook finished for "${title}". Resolved?` : `Runbook failed for "${title}": ${ran.error}. Resolved?`,
    );
    if (confirmation.resolved) return 'incident-resolved';
  }
});

const services = ['api', 'web', 'worker'];
const databases = ['orders', 'users'];
const domains = ['example.com', 'api.example.com'];

const heartbeatClock = H.clock('heartbeat-clock', Heartbeat, { every: { minutes: 5 } }, ({ now }) =>
  services.map((service): SupplyOf<typeof Heartbeat> => ({ create: { service }, key: `${service}@${now.toISOString()}` })));

const backupClock = H.clock('backup-clock', Backup, { daily: '01:00' }, ({ now }) =>
  databases.map((database): SupplyOf<typeof Backup> => ({
    create: { database },
    key: `${database}@${now.toISOString().slice(0, 10)}`,
  })));

const renewalClock = H.clock('renewal-clock', CertificateRenewal, { weekly: { day: 'mon', at: '05:00' } }, ({ now }) =>
  domains.map((domain): SupplyOf<typeof CertificateRenewal> => ({
    create: { domain },
    key: `${domain}@${now.toISOString().slice(0, 10)}`,
  })));

export const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(heartbeatClock);
export const backups = H.lane('backups', Backup).handler(backupFlow).suppliers(backupClock);
export const renewals = H.lane('renewals', CertificateRenewal).handler(renewalFlow).suppliers(renewalClock);
export const incidents = H.lane('incidents', Incident).handler(incidentFlow).suppliers(H.operator);

const opsJournal = H.library(
  'operational-experience',
  H.memory('operational-experience', 'experience'),
  jsonl.memory('.harness/ops-experience.jsonl'),
);

const repeatedHeartbeatFailure = H.trigger(
  'repeated-heartbeat-failure',
  H.on.streak(Heartbeat, 'heartbeat-down', 3, (data) => data.service),
  (event, act) => act.create(incidents, {
    title: `${event.unit.data.service} failed three consecutive heartbeats`,
    source: 'heartbeat',
  }, `heartbeat-${event.unit.data.service}`),
);

const failedBackup = H.trigger(
  'failed-backup',
  H.on.enters(Backup, 'backup-failed'),
  (event, act) => act.create(incidents, {
    title: `Backup of ${event.unit.data.database} failed`,
    source: 'backup',
  }, `backup-${event.unit.data.database}`),
);

const twoHoursMs = 2 * 60 * 60 * 1000;

const slowBackupNoted = H.trigger(
  'slow-backup-noted',
  H.on.enters(Backup, 'backup-done'),
  (event, act) => {
    const tookMs = event.attempt?.durationMs ?? 0;
    if (tookMs <= twoHoursMs) return [];
    return act.remember(opsJournal, {
      text: `When scheduling the ${event.unit.data.database} backup, start it before 01:00 or on the less loaded host`,
      because: `the backup of ${event.at.toISOString().slice(0, 10)} took ${Math.round(tookMs / 60000)} minutes`,
      when: { kinds: [Backup.name], resources: [event.unit.data.database] },
    });
  },
);

const incidentsFirst = H.policy.scheduler('incidents-first', ({ pending, active }) => {
  const pendingIncidents = pending.filter((unit) => unit.kind === Incident.name);
  const incidentOpenNow = pendingIncidents.length > 0 || active.some((unit) => unit.kind === Incident.name);
  const others = pending.filter((unit) =>
    unit.kind !== Incident.name && !(incidentOpenNow && unit.kind === Backup.name));
  const preempt = pendingIncidents.length > 0
    ? active.filter((unit) => unit.kind !== Incident.name && unit.kind !== Backup.name && !unit.blocked)
    : [];
  return { start: [...pendingIncidents, ...others], preempt };
});

const incidentAlerts = slack.notify({
  webhook: H.env('SLACK_INCIDENT_WEBHOOK'),
  message: (entry) =>
    entry.entry === 'transition' && entry.kind === Incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'created'} -> ${entry.to}`
      : null,
});

const controlApi = http.control({
  port: 8420,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, backups, renewals, incidents)
  .triggers(repeatedHeartbeatFailure, failedBackup, slowBackupNoted)
  .scheduler(incidentsFirst)
  .clients(controlApi)
  .observers(incidentAlerts, markdown.board('.harness/board.md'));

export const running = operations.start();
