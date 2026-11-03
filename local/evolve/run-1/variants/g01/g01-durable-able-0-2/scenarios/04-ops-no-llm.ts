import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';
import { slack } from 'harness-dsl/slack';

const HeartbeatSchema = z.object({ service: z.string(), url: z.string() });
const BackupSchema = z.object({ database: z.string(), host: z.enum(['db-a', 'db-b']) });
type BackupAttrs = z.infer<typeof BackupSchema>;
const RenewalSchema = z.object({ domain: z.string(), host: z.enum(['db-a', 'db-b']) });
type RenewalAttrs = z.infer<typeof RenewalSchema>;
const IncidentSchema = z.object({ title: z.string(), source: z.string() });

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Probing = H.state('Probing', 'active');
const HeartbeatOk = H.terminal('HeartbeatOk', 'success');
const HeartbeatFailed = H.terminal('HeartbeatFailed', 'failure');

const Heartbeat = H.kind('Heartbeat')
  .attributes(HeartbeatSchema)
  .states(HeartbeatDue, Probing, HeartbeatOk, HeartbeatFailed)
  .key(a => a.service)
  .initial(HeartbeatDue)
  .onAttemptFailed(HeartbeatFailed);

const BackupDue = H.state('BackupDue', 'pending');
const BackingUp = H.state('BackingUp', 'active');
const BackupSucceeded = H.terminal('BackupSucceeded', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');

const Backup = H.kind('Backup')
  .attributes(BackupSchema)
  .states(BackupDue, BackingUp, BackupSucceeded, BackupFailed)
  .key(a => a.database)
  .initial(BackupDue)
  .onAttemptFailed(BackupFailed);

const RenewalDue = H.state('RenewalDue', 'pending');
const CheckingExpiry = H.state('CheckingExpiry', 'active');
const Renewing = H.state('Renewing', 'active');
const CertificateValid = H.terminal('CertificateValid', 'success');
const CertificateRenewed = H.terminal('CertificateRenewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');

const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(RenewalSchema)
  .states(RenewalDue, CheckingExpiry, Renewing, CertificateValid, CertificateRenewed, RenewalFailed)
  .key(a => a.domain)
  .initial(RenewalDue)
  .onAttemptFailed(RenewalFailed);

const IncidentOpen = H.state('IncidentOpen', 'pending');
const Acknowledging = H.state('Acknowledging', 'active');
const Remediating = H.state('Remediating', 'active');
const AwaitingResolution = H.state('AwaitingResolution', 'active');
const IncidentResolved = H.terminal('IncidentResolved', 'success');
const IncidentDismissed = H.terminal('IncidentDismissed', 'neutral');

const Incident = H.kind('Incident')
  .attributes(IncidentSchema)
  .states(IncidentOpen, Acknowledging, Remediating, AwaitingResolution, IncidentResolved, IncidentDismissed)
  .key(a => a.source)
  .initial(IncidentOpen)
  .onCancelled(IncidentDismissed);

const diskSpace = H.command('diskSpacePreflight')
  .argv(['sh', '-c', 'test "$(df --output=avail -k /var/backups | tail -1)" -gt 52428800']);

const localRunner = local.runner('local').slots(4);

const hostA = ssh.host('db-a', { host: 'db-a.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpace);

const hostB = ssh.host('db-b', { host: 'db-b.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpace);

const hostFor = (host: 'db-a' | 'db-b') => (host === 'db-a' ? hostA : hostB);

const heartbeatProbe = H.command('heartbeatProbe')
  .input(HeartbeatSchema)
  .argv(i => ['curl', '--fail', '--max-time', '10', i.url])
  .runner(localRunner);

const backupDatabase = H.command('backupDatabase')
  .input(BackupSchema)
  .argv(i => ['/opt/ops/backup.sh', i.database])
  .runner(i => hostFor(i.host));

const certificateExpiry = H.command('certificateExpiry')
  .input(RenewalSchema)
  .argv(i => ['/opt/ops/cert-days-left.sh', i.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(i => hostFor(i.host));

const renewCertificate = H.command('renewCertificate')
  .input(RenewalSchema)
  .argv(i => ['/opt/ops/renew-cert.sh', i.domain])
  .runner(i => hostFor(i.host));

const runbook = H.command('incidentRunbook')
  .input(IncidentSchema)
  .argv(i => ['/opt/ops/runbook.sh', '--source', i.source])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(HeartbeatSchema)
  .step('probe', heartbeatProbe, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('healthy');

const backupFlow = H.flow('backup')
  .input(BackupSchema)
  .step('backup', backupDatabase, ctx => ctx.unit.attributes, { afterCrash: 'rerun', timeoutMs: 6 * 3_600_000 })
  .exit('backedUp');

const renewalFlow = H.flow('certificateRenewal')
  .input(RenewalSchema)
  .step('check', certificateExpiry, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('stillValid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', renewCertificate, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('renewed');

const incidentFlow = H.flow('incident')
  .input(IncidentSchema)
  .halt('acknowledge', {
    ask: ctx => `Incident: ${ctx.unit.attributes.title}. Acknowledge to run the runbook.`,
    decision: z.object({ acknowledgedBy: z.string() }),
  })
  .step('runbook', runbook, ctx => ctx.unit.attributes)
  .halt('confirmResolution', {
    ask: ctx => `Runbook finished for ${ctx.unit.attributes.title} (exit ${ctx.steps.runbook.exitCode}). Is the incident resolved?`,
    decision: z.object({ resolved: z.boolean(), notes: z.string() }),
  })
  .exit('resolved', ctx => ctx.steps.confirmResolution.resolved)
  .exit('unresolved');

const services: readonly z.infer<typeof HeartbeatSchema>[] = [
  { service: 'api', url: 'https://api.internal/health' },
  { service: 'web', url: 'https://web.internal/health' },
  { service: 'queue', url: 'https://queue.internal/health' },
];

const databases: readonly BackupAttrs[] = [
  { database: 'orders', host: 'db-a' },
  { database: 'customers', host: 'db-a' },
  { database: 'analytics', host: 'db-b' },
];

const certificates: readonly RenewalAttrs[] = [
  { domain: 'api.example.com', host: 'db-a' },
  { domain: 'www.example.com', host: 'db-b' },
];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('everyFiveMinutes').every({ minutes: 5 }), (_tick, to) => services.map(s => to.create(s)))
  .handler(heartbeatFlow, { exits: { healthy: HeartbeatOk }, during: { probe: Probing } });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly').daily('01:00', { tz: 'UTC' }), (_tick, to) => databases.map(d => to.create(d)))
  .handler(backupFlow, { exits: { backedUp: BackupSucceeded }, during: { backup: BackingUp } });

const renewals = H.lane('certificateRenewals', CertificateRenewal)
  .supply(H.clock('weekly').weekly('mon', '03:00', { tz: 'UTC' }), (_tick, to) => certificates.map(c => to.create(c)))
  .handler(renewalFlow, {
    exits: { stillValid: CertificateValid, renewed: CertificateRenewed },
    during: { check: CheckingExpiry, renew: Renewing },
  });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(incidentFlow, {
    exits: { resolved: IncidentResolved, unresolved: IncidentOpen },
    during: { acknowledge: Acknowledging, runbook: Remediating, confirmResolution: AwaitingResolution },
  });

const OperationalExperience = H.memory('operationalExperience').trust('experience');

const opsJournal = H.journal('operationalExperience', OperationalExperience)
  .store(jsonl.memoryStore({ path: '.harness/memory/operations.jsonl' }))
  .recall(H.recall('bySpecificity', { by: 'specificity', limit: 20 }));

const failingServiceOpensIncident = H.trigger('failingServiceOpensIncident')
  .on(H.when.pattern(heartbeats, { to: HeartbeatFailed, consecutive: 3, per: u => u.attributes.service }))
  .create(incidents, e => ({
    title: `${e.group} failed ${e.streak} consecutive heartbeats`,
    source: `heartbeat:${e.group}`,
  }));

const failedBackupOpensIncident = H.trigger('failedBackupOpensIncident')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, e => ({
    title: `Backup of ${e.unit.attributes.database} failed`,
    source: `backup:${e.unit.attributes.database}`,
  }));

const slowBackupNoted = H.trigger('slowBackupNoted')
  .on(H.when.transition(backups, {
    to: BackupSucceeded,
    if: e => e.attempt !== undefined && e.attempt.durationMs > 2 * 3_600_000,
  }))
  .record(opsJournal, e => ({
    body: {
      text: `When scheduling the backup of ${e.unit.attributes.database}, allow more than two hours on ${e.unit.attributes.host}, because the backup finishing ${e.at.toISOString()} took ${Math.round((e.attempt?.durationMs ?? 0) / 60_000)} minutes`,
    },
    when: { kinds: [Backup], resources: [e.unit.attributes.database, e.unit.attributes.host] },
  }));

const scheduler = H.scheduler('operations')
  .priority(incidents, heartbeats, renewals, backups)
  .admit(backups, ctx => ctx.active(incidents) === 0 && ctx.pending(incidents) === 0);

const controlApi = http.controlApi('opsControlApi', {
  port: H.slot.port(1),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(incidents, heartbeats, backups, renewals)
  .journals(opsJournal)
  .triggers(failingServiceOpensIncident, failedBackupOpensIncident, slowBackupNoted)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incidentAlerts', { webhookUrl: H.env('SLACK_INCIDENT_WEBHOOK'), lanes: [incidents] }),
    markdown.board({ path: '.harness/board.md' }),
  );

export const running = harness.start();
