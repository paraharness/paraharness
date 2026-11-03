import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, ActiveView } from 'harness-dsl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';

const ServiceData = z.object({ service: z.string() });
const BackupData = z.object({ database: z.enum(['orders', 'users']) });
const RenewalData = z.object({ domain: z.enum(['api.example.com', 'shop.example.com']) });
const IncidentData = z.object({ title: z.string(), detail: z.string() });

const heartbeatDue = H.state('heartbeat-due', 'pending');
const heartbeatOk = H.state('heartbeat-ok', 'terminal', 'success');
const heartbeatDown = H.state('heartbeat-down', 'terminal', 'failure');

const backupDue = H.state('backup-due', 'pending');
const backupRunning = H.state('backup-running', 'active');
const backupDone = H.state('backup-done', 'terminal', 'success');
const backupFailed = H.state('backup-failed', 'terminal', 'failure');

const certDue = H.state('cert-due', 'pending');
const certChecking = H.state('cert-checking', 'active');
const certRenewing = H.state('cert-renewing', 'active');
const certValid = H.state('cert-valid', 'terminal', 'success');
const certRenewed = H.state('cert-renewed', 'terminal', 'success');
const certFailed = H.state('cert-failed', 'terminal', 'failure');

const incidentOpen = H.state('incident-open', 'pending');
const incidentActive = H.state('incident-active', 'active');
const incidentResolved = H.state('incident-resolved', 'terminal', 'success');

const Heartbeat = H.kind('heartbeat').data(ServiceData).states(heartbeatDue, heartbeatOk, heartbeatDown);
const Backup = H.kind('backup').data(BackupData).states(backupDue, backupRunning, backupDone, backupFailed);
const CertificateRenewal = H.kind('certificate-renewal')
  .data(RenewalData)
  .states(certDue, certChecking, certRenewing, certValid, certRenewed, certFailed)
  .failsTo('cert-failed');
const Incident = H.kind('incident').data(IncidentData).states(incidentOpen, incidentActive, incidentResolved);

const local = shell.local('local', { slots: 4 });
const opsHostA = ssh.host('ops-host-a', { address: '10.0.0.11', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1 });
const opsHostB = ssh.host('ops-host-b', { address: '10.0.0.12', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1 });

const probeService = H.command('probe-service')
  .input(ServiceData)
  .argv((target) => ['./scripts/probe.sh', target.service])
  .on(local);

const diskSpace = H.command('disk-space-preflight')
  .input(BackupData)
  .argv((target) => ['check-free-space', '--min-gb', '100', `/var/backups/${target.database}`])
  .on({ orders: opsHostA, users: opsHostB }, (target) => target.database);

const backupDatabase = H.command('backup-database')
  .input(BackupData)
  .argv((target) => ['pg-backup', '--database', target.database, '--to', `/var/backups/${target.database}`])
  .on({ orders: opsHostA, users: opsHostB }, (target) => target.database)
  .preflight(diskSpace);

const certificateExpiry = H.command('certificate-expiry')
  .input(RenewalData)
  .output(z.object({ daysLeft: z.number() }))
  .argv((target) => ['cert-days-left', target.domain])
  .on({ 'api.example.com': opsHostA, 'shop.example.com': opsHostB }, (target) => target.domain);

const renewCertificate = H.command('renew-certificate')
  .input(RenewalData)
  .argv((target) => ['certbot', 'renew', '--cert-name', target.domain])
  .on({ 'api.example.com': opsHostA, 'shop.example.com': opsHostB }, (target) => target.domain);

const runbook = H.command('incident-runbook')
  .input(IncidentData)
  .argv((incident) => ['./runbooks/run.sh', incident.title])
  .on(local);

const incidentAcknowledged = H.halt('incident-acknowledged', z.object({ by: z.string() }));
const incidentResolution = H.halt('incident-resolution', z.object({ resolved: z.boolean(), note: z.string() }));

const heartbeatCheck = H.flow('heartbeat-check')
  .for(Heartbeat)
  .does(async (ctx) => {
    const probe = await ctx.run(probeService, ctx.unit.data);
    return probe.ok ? 'heartbeat-ok' : 'heartbeat-down';
  });

const nightlyBackup = H.flow('nightly-backup')
  .for(Backup)
  .does(async (ctx) => {
    await ctx.move('backup-running');
    const backup = await ctx.run(backupDatabase, ctx.unit.data);
    return backup.ok ? 'backup-done' : 'backup-failed';
  });

const renewalCheck = H.flow('renewal-check')
  .for(CertificateRenewal)
  .does(async (ctx) => {
    await ctx.move('cert-checking');
    const expiry = await ctx.run(certificateExpiry, ctx.unit.data);
    if (!expiry.ok) return ctx.fail(expiry.error);
    if (expiry.value.daysLeft >= 14) return 'cert-valid';
    await ctx.move('cert-renewing');
    const renewed = await ctx.run(renewCertificate, ctx.unit.data);
    return renewed.ok ? 'cert-renewed' : ctx.fail(renewed.error);
  });

const incidentRunbook = H.flow('incident-runbook-flow')
  .for(Incident)
  .does(async (ctx) => {
    await ctx.move('incident-active');
    await ctx.halt(incidentAcknowledged, `Acknowledge incident: ${ctx.unit.data.title}\n\n${ctx.unit.data.detail}`);
    for (;;) {
      const outcome = await ctx.run(runbook, ctx.unit.data);
      const confirmation = await ctx.halt(incidentResolution, outcome.ok ? `Runbook finished:\n${outcome.value}` : `Runbook failed: ${outcome.error}`);
      if (confirmation.resolved) return 'incident-resolved';
    }
  });

const services = ['api', 'web', 'worker'];
const databases = ['orders', 'users'] as const satisfies readonly z.infer<typeof BackupData>['database'][];
const domains = ['api.example.com', 'shop.example.com'] as const satisfies readonly z.infer<typeof RenewalData>['domain'][];

const heartbeatClock = H.clock('heartbeat-clock', Heartbeat, { every: { minutes: 5 } }, ({ now }) =>
  services.map((service) => ({ create: { service }, key: `${service}@${now.toISOString()}` })));

const backupClock = H.clock('backup-clock', Backup, { daily: '01:00' }, ({ now }) =>
  databases.map((database) => ({ create: { database }, key: `${database}@${now.toISOString().slice(0, 10)}` })));

const renewalClock = H.clock('renewal-clock', CertificateRenewal, { weekly: { day: 'mon', at: '03:00' } }, ({ now }) =>
  domains.map((domain) => ({ create: { domain }, key: `${domain}@${now.toISOString().slice(0, 10)}` })));

const heartbeatLane = H.lane('heartbeats', Heartbeat).handler(heartbeatCheck).suppliers(heartbeatClock);
const backupLane = H.lane('backups', Backup).handler(nightlyBackup).suppliers(backupClock);
const renewalLane = H.lane('renewals', CertificateRenewal).handler(renewalCheck).suppliers(renewalClock);
const incidentLane = H.lane('incidents', Incident).handler(incidentRunbook).suppliers(H.operator);

const operationalExperience = H.memory('operational-experience', 'experience');
const opsJournal = H.library('ops-journal', operationalExperience, jsonl.memory('.harness/ops-experience.jsonl'));

const twoHoursMs = 2 * 60 * 60 * 1000;

const heartbeatStreakOpensIncident = H.trigger('heartbeat-streak-opens-incident',
  H.on.streak(Heartbeat, 'heartbeat-down', 3, (data) => data.service),
  (event, act) => act.create(incidentLane, {
    title: `${event.unit.data.service} failed three heartbeats in a row`,
    detail: `Third consecutive failure at ${event.at.toISOString()}.`,
  }, `heartbeat-${event.unit.data.service}`));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident', H.on.enters(Backup, 'backup-failed'), (event, act) =>
  act.create(incidentLane, {
    title: `Backup of ${event.unit.data.database} failed`,
    detail: `Backup unit ${event.unit.key} failed at ${event.at.toISOString()}.`,
  }, `backup-${event.unit.data.database}`));

const slowBackupNotesExperience = H.trigger('slow-backup-notes-experience', H.on.enters(Backup, 'backup-done'), (event, act) =>
  event.attempt !== null && event.attempt.durationMs > twoHoursMs
    ? act.remember(opsJournal, {
      text: `When scheduling the ${event.unit.data.database} backup, budget more than two hours of host time`,
      because: `the backup ${event.unit.key} took ${Math.round(event.attempt.durationMs / 60000)} minutes`,
      when: { kinds: [Backup], resources: [event.unit.data.database] },
    })
    : []);

const incidentsFirst = H.policy.scheduler('incidents-first', ({ pending, active }) => {
  const incidentWaiting = pending.some((unit) => unit.is(Incident));
  const incidentOngoing = active.some((unit) => unit.is(Incident));
  const rank = (unit: PendingView): number => {
    if (unit.is(Incident)) return 0;
    if (unit.is(Heartbeat)) return 1;
    if (unit.is(CertificateRenewal)) return 2;
    return 3;
  };
  const preemptible = (unit: ActiveView): boolean => {
    if (unit.is(Heartbeat)) return true;
    if (unit.is(CertificateRenewal)) return unit.state !== 'cert-renewing';
    return false;
  };
  const start = pending
    .filter((unit) => !(unit.is(Backup) && (incidentWaiting || incidentOngoing)))
    .sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs);
  return { start, preempt: incidentWaiting ? active.filter(preemptible) : [] };
});

const control = http.control({
  port: 8080,
  token: H.env('CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
});

const incidentAlerts = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  message: (entry) => entry.entry === 'transition' && entry.kind === Incident.name
    ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'created'} -> ${entry.to}`
    : null,
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/operations.sqlite'))
  .lanes(incidentLane, heartbeatLane, backupLane, renewalLane)
  .triggers(heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupNotesExperience)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentAlerts, markdown.board('BOARD.md'));

export const running = operations.start();
