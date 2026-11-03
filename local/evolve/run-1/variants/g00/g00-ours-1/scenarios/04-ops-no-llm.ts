import { H, type Runner } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { schedule, manual } from 'harness-dsl/supply';
import { local, ssh } from 'harness-dsl/runners';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { board } from 'harness-dsl/projections';

const HeartbeatDue = H.state('HeartbeatDue').pending();
const Probing = H.state('Probing').active();
const Up = H.state('Up').succeeded();
const Down = H.state('Down').failed();

const BackupDue = H.state('BackupDue').pending();
const BackingUp = H.state('BackingUp').active();
const BackedUp = H.state('BackedUp').succeeded();
const BackupFailed = H.state('BackupFailed').failed();

const CheckDue = H.state('CheckDue').pending();
const CheckingCertificate = H.state('CheckingCertificate').active();
const CertificateValid = H.state('CertificateValid').succeeded();
const CertificateRenewed = H.state('CertificateRenewed').succeeded();
const RenewalFailed = H.state('RenewalFailed').failed();

const IncidentOpen = H.state('IncidentOpen').pending();
const Acknowledging = H.state('Acknowledging').active();
const Remediating = H.state('Remediating').active();
const ConfirmingResolution = H.state('ConfirmingResolution').active();
const IncidentResolved = H.state('IncidentResolved').succeeded();
const IncidentUnresolved = H.state('IncidentUnresolved').failed();
const IncidentCancelled = H.state('IncidentCancelled').cancelled();

const Heartbeat = H.work('heartbeat')
  .schema(z.object({ service: z.string(), url: z.string(), at: z.string() }))
  .states(HeartbeatDue, Probing, Up, Down)
  .key(d => `${d.service}@${d.at}`);

const Backup = H.work('backup')
  .schema(z.object({ host: z.string(), database: z.string(), night: z.string() }))
  .states(BackupDue, BackingUp, BackedUp, BackupFailed)
  .key(d => `${d.host}/${d.database}/${d.night}`);

const CertificateRenewal = H.work('certificate-renewal')
  .schema(z.object({ domain: z.string(), week: z.string() }))
  .states(CheckDue, CheckingCertificate, CertificateValid, CertificateRenewed, RenewalFailed)
  .key(d => `${d.domain}@${d.week}`);

const Incident = H.work('incident')
  .schema(z.object({ service: z.string(), title: z.string(), cause: z.string(), openedAt: z.string() }))
  .states(IncidentOpen, Acknowledging, Remediating, ConfirmingResolution, IncidentResolved, IncidentUnresolved, IncidentCancelled)
  .key(d => `${d.service}@${d.openedAt}`);

const OpsExperience = H.memory('ops-experience').content(z.object({ action: z.string(), condition: z.string(), reason: z.string() }));
const opsJournal = H.journal('ops-experience').of(OpsExperience).store(jsonl.memory('memory/ops.jsonl'));

const diskSpace = H.command('disk-space-preflight').run(async ctx => {
  const result = await ctx.exec('df', ['--output=pcent', '/var/backups']);
  const used = Number(result.stdout.split('\n')[1]?.replace('%', '').trim() ?? '100');
  if (used > 85) throw new Error(`Backup volume ${used}% full`);
});

const sshKey = H.env('OPS_SSH_KEY_PATH');
const controlNode = local('control-node').slots(6);
const dbHost1 = ssh('db-host-1', { host: H.env('DB_HOST_1'), user: 'ops', keyPath: sshKey }).slots(1).preflight(diskSpace);
const dbHost2 = ssh('db-host-2', { host: H.env('DB_HOST_2'), user: 'ops', keyPath: sshKey }).slots(1).preflight(diskSpace);

const hostOfUnit = H.policy.pick<Runner>('host-of-unit', ctx =>
  ctx.unit === null ? ctx.candidates : ctx.candidates.filter(r => ctx.unit !== null && ctx.unit.key.startsWith(`${r.name}/`)),
);
const anyHost = H.policy.pick<Runner>('any-free-host', ctx => ctx.candidates);

const backupHosts = H.pool('backup-hosts', [dbHost1, dbHost2]).policy(hostOfUnit);
const renewalHosts = H.pool('renewal-hosts', [dbHost1, dbHost2]).policy(anyHost);

const probe = H.command('probe')
  .input(z.object({ url: z.string() }))
  .runner(controlNode)
  .run(async ctx => {
    await ctx.exec('curl', ['-fsS', '--max-time', '10', ctx.input.url]);
  });

const runBackup = H.command('run-backup')
  .input(z.object({ database: z.string(), night: z.string() }))
  .runner(backupHosts)
  .run(async ctx => {
    await ctx.exec('pg_dump', ['-Fc', '-f', `/var/backups/${ctx.input.database}-${ctx.input.night}.dump`, ctx.input.database]);
  });

const checkCertificate = H.command('check-certificate')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .runner(renewalHosts)
  .run(async ctx => {
    const result = await ctx.exec('cert-days-left', [ctx.input.domain]);
    return { daysLeft: Number(result.stdout.trim()) };
  });

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .runner(renewalHosts)
  .run(async ctx => {
    await ctx.exec('certbot', ['renew', '--cert-name', ctx.input.domain]);
  });

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string(), service: z.string() }))
  .runner(controlNode)
  .env({ PAGER_TOKEN: H.env('PAGER_TOKEN') })
  .run(async ctx => {
    await ctx.exec('page', ['--service', ctx.input.service, '--summary', ctx.input.title]);
  });

const runbook = H.command('runbook')
  .input(z.object({ service: z.string() }))
  .runner(controlNode)
  .run(async ctx => {
    await ctx.exec('runbook', ['restart', ctx.input.service]);
  });

const notify = slack.message('ops-channel', { webhookUrl: H.env('OPS_SLACK_WEBHOOK') });

const heartbeatFlow = H.flow('heartbeat')
  .of(Heartbeat)
  .transition(Probing)
  .step('probe', probe, s => ({ url: s.unit.data.url }))
  .transition(Up);

const backupFlow = H.flow('backup')
  .of(Backup)
  .transition(BackingUp)
  .step('backup', runBackup, s => ({ database: s.unit.data.database, night: s.unit.data.night }))
  .transition(BackedUp);

const renewalFlow = H.flow('certificate-renewal')
  .of(CertificateRenewal)
  .transition(CheckingCertificate)
  .step('check', checkCertificate, s => ({ domain: s.unit.data.domain }))
  .when(
    s => s.steps.check.daysLeft < 14,
    w => w.step('renew', renewCertificate, s => ({ domain: s.unit.data.domain }), { retry: { maxRetries: 2, backoff: 'exponential', initialDelayMs: 60000 } }),
  )
  .transition(s => (s.steps.renew === undefined ? CertificateValid : CertificateRenewed));

const incidentFlow = H.flow('incident-runbook')
  .of(Incident)
  .transition(Acknowledging)
  .step('page', pageOnCall, s => ({ title: s.unit.data.title, service: s.unit.data.service }))
  .halt('acknowledgement', {
    ask: s => `Acknowledge incident: ${s.unit.data.title} (${s.unit.data.cause})`,
    decision: z.object({ acknowledgedBy: z.string() }),
  })
  .transition(Remediating)
  .step('runbook', runbook, s => ({ service: s.unit.data.service }))
  .transition(ConfirmingResolution)
  .halt('resolution', {
    ask: s => `Runbook ran for ${s.unit.data.service}. Is the incident resolved?`,
    decision: z.object({ resolved: z.boolean(), note: z.string() }),
  })
  .transition(s => (s.steps.resolution.resolved ? IncidentResolved : IncidentUnresolved));

const services = [
  { service: 'api', url: 'https://api.internal/health' },
  { service: 'queue', url: 'https://queue.internal/health' },
];
const databases = [
  { host: 'db-host-1', database: 'orders' },
  { host: 'db-host-1', database: 'users' },
  { host: 'db-host-2', database: 'analytics' },
];
const domains = ['example.com', 'api.example.com'];

const heartbeats = H.lane('heartbeats')
  .of(Heartbeat)
  .from(schedule('*/5 * * * *', at => services.map(s => ({ service: s.service, url: s.url, at: at.toISOString() }))))
  .handle(heartbeatFlow);

const backups = H.lane('backups')
  .of(Backup)
  .from(schedule('0 1 * * *', at => databases.map(d => ({ host: d.host, database: d.database, night: at.toISOString().slice(0, 10) }))))
  .handle(backupFlow);

const renewals = H.lane('certificate-renewals')
  .of(CertificateRenewal)
  .from(schedule('0 4 * * 1', at => domains.map(domain => ({ domain, week: at.toISOString().slice(0, 10) }))))
  .handle(renewalFlow);

const incidents = H.lane('incidents').of(Incident).from(manual()).handle(incidentFlow);

const heartbeatStreak = H.trigger('three-down-heartbeats-open-incident')
  .on(heartbeats.streak(Down, 3, { by: u => u.data.service }))
  .create(incidents, e => ({
    service: e.group,
    title: `${e.group} down for ${e.count} consecutive heartbeats`,
    cause: 'heartbeat streak',
    openedAt: e.unit.updatedAt.toISOString(),
  }));

const backupFailure = H.trigger('failed-backup-opens-incident')
  .on(backups.enters(BackupFailed))
  .create(incidents, e => ({
    service: e.unit.data.database,
    title: `Backup of ${e.unit.data.database} on ${e.unit.data.host} failed`,
    cause: 'backup failed',
    openedAt: e.at.toISOString(),
  }));

const slowBackupMs = 2 * 60 * 60 * 1000;

const slowBackupNote = H.trigger('slow-backup-noted')
  .on(backups.enters(BackedUp))
  .where(e => e.attempt !== null && e.attempt.durationMs > slowBackupMs)
  .record(opsJournal, e => ({
    content: {
      action: `start the ${e.unit.data.database} backup earlier or move it off ${e.unit.data.host}`,
      condition: `when scheduling backups of ${e.unit.data.database}`,
      reason: `on ${e.unit.data.night} it took ${Math.round((e.attempt?.durationMs ?? 0) / 60000)} minutes`,
    },
    when: { kinds: [Backup], resources: [e.unit.data.host] },
  }));

const incidentAlerts = H.trigger('incident-transitions-to-chat')
  .on(incidents.enters(IncidentOpen, Acknowledging, Remediating, ConfirmingResolution, IncidentResolved, IncidentUnresolved, IncidentCancelled))
  .run(notify, e => ({ text: `Incident ${e.unit.data.title}: ${e.from ?? 'created'} -> ${e.to}` }));

const concurrency = 6;

const incidentsFirst = H.policy.schedule('incidents-preempt', ctx => {
  const pendingIncidents = ctx.of(incidents).pending;
  const incidentActive = ctx.of(incidents).running.length > 0 || pendingIncidents.length > 0;
  const others = ctx.pending.filter(q => q.lane !== incidents.name && !(incidentActive && q.lane === backups.name));
  const freeSlots = concurrency - ctx.running.length;
  const preempt =
    pendingIncidents.length > freeSlots
      ? ctx.running.filter(r => r.lane !== backups.name && r.lane !== incidents.name).slice(0, pendingIncidents.length - freeSlots)
      : [];
  return { start: [...pendingIncidents, ...others], preempt };
});

const supervisor = H.supervisor('ops-console')
  .endpoint(http.endpoint({ port: 8080, token: H.env('OPS_CONTROL_TOKEN') }))
  .grant(H.ops.work.read, H.ops.work.write, H.ops.blockers.resolve, H.ops.memory.read, H.ops.telemetry.read);

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(heartbeats, backups, renewals, incidents)
  .journals(opsJournal)
  .triggers(heartbeatStreak, backupFailure, slowBackupNote, incidentAlerts)
  .scheduler(H.scheduler('operations').concurrency(concurrency).policy(incidentsFirst))
  .supervisor(supervisor)
  .projections(board('BOARD.md'));

export const run = operations.start();
