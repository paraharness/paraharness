import { H, Runner } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const serviceSchema = z.enum(['api', 'web', 'worker']);
const databaseSchema = z.enum(['orders', 'users']);
const domainSchema = z.enum(['example.com', 'api.example.com']);
const incidentSchema = z.object({
  ref: z.string(),
  title: z.string(),
  source: z.enum(['heartbeat', 'backup', 'operator']),
});

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');
const Heartbeat = H.kind('Heartbeat')
  .attributes(z.object({ service: serviceSchema }))
  .states(HeartbeatDue, Healthy, Unhealthy)
  .key(a => a.service)
  .initial(HeartbeatDue);

const BackupDue = H.state('BackupDue', 'pending');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');
const Backup = H.kind('Backup')
  .attributes(z.object({ database: databaseSchema }))
  .states(BackupDue, BackedUp, BackupFailed)
  .key(a => a.database)
  .initial(BackupDue);

const RenewalDue = H.state('RenewalDue', 'pending');
const CertificateValid = H.terminal('CertificateValid', 'success');
const CertificateRenewed = H.terminal('CertificateRenewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');
const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(z.object({ domain: domainSchema }))
  .states(RenewalDue, CertificateValid, CertificateRenewed, RenewalFailed)
  .key(a => a.domain)
  .initial(RenewalDue);

const IncidentOpen = H.state('IncidentOpen', 'pending');
const IncidentResolved = H.terminal('IncidentResolved', 'success');
const IncidentUnresolved = H.terminal('IncidentUnresolved', 'failure');
const Incident = H.kind('Incident')
  .attributes(incidentSchema)
  .states(IncidentOpen, IncidentResolved, IncidentUnresolved)
  .key(a => a.ref)
  .initial(IncidentOpen);

const localRunner = local.runner('local');
const diskCheck = H.command('disk-space-preflight').argv(['sh', '-c', 'test "$(df --output=avail -k / | tail -1)" -gt 10485760']);
const sshKey = H.env('OPS_SSH_KEY');
const opsA = ssh.host('ops-a', { host: 'ops-a.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskCheck);
const opsB = ssh.host('ops-b', { host: 'ops-b.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskCheck);

const backupHost: Record<z.infer<typeof databaseSchema>, Runner> = { orders: opsA, users: opsB };
const renewalHost: Record<z.infer<typeof domainSchema>, Runner> = { 'example.com': opsA, 'api.example.com': opsB };
const databaseResource = { orders: H.resource('orders-db'), users: H.resource('users-db') };

const probe = H.command('heartbeat-probe')
  .input(z.object({ service: serviceSchema }))
  .argv(i => ['./probe.sh', i.service])
  .runner(localRunner);
const runBackup = H.command('backup')
  .input(z.object({ database: databaseSchema }))
  .argv(i => ['./backup.sh', i.database])
  .runner(i => backupHost[i.database]);
const checkExpiry = H.command('certificate-days-left')
  .input(z.object({ domain: domainSchema }))
  .argv(i => ['./cert-days-left.sh', i.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(i => renewalHost[i.domain]);
const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: domainSchema }))
  .argv(i => ['./renew-cert.sh', i.domain])
  .runner(i => renewalHost[i.domain]);
const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(i => ['./page.sh', i.title])
  .runner(localRunner);
const runbook = H.command('incident-runbook')
  .input(z.object({ ref: z.string(), source: z.string() }))
  .argv(i => ['./runbook.sh', i.source, i.ref])
  .runner(localRunner);

const acknowledgement = H.halt('incident-acknowledgement').decision(z.object({ note: z.string().optional() }));
const resolutionCheck = H.halt('incident-resolution').decision(z.object({ resolved: z.boolean(), note: z.string().optional() }));

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ service: serviceSchema }))
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

const backupFlow = H.flow('backup')
  .input(z.object({ database: databaseSchema }))
  .step('backup', runBackup, ctx => ({ database: ctx.unit.attributes.database }))
  .exit('backedUp');

const renewalFlow = H.flow('certificate-renewal')
  .input(z.object({ domain: domainSchema }))
  .step('check', checkExpiry, ctx => ({ domain: ctx.unit.attributes.domain }))
  .exit('stillValid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', renewCertificate, ctx => ({ domain: ctx.unit.attributes.domain }))
  .exit('renewed');

const incidentFlow = H.flow('incident-runbook')
  .input(incidentSchema)
  .step('page', pageOnCall, ctx => ({ title: ctx.unit.attributes.title }))
  .halt('acknowledge', acknowledgement, { ask: ctx => `Acknowledge incident ${ctx.unit.key}: ${ctx.unit.attributes.title}` })
  .loop(
    'remediation',
    round =>
      round
        .step('runbook', runbook, ctx => ({ ref: ctx.unit.attributes.ref, source: ctx.unit.attributes.source }))
        .halt('confirm', resolutionCheck, { ask: ctx => `The runbook ran for ${ctx.unit.key}. Is the incident resolved?` }),
    { max: 3, until: ctx => ctx.steps.confirm.resolved },
  )
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    serviceSchema.options.map(service => to.create({ service })),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly-backup').at('01:00', { tz: 'UTC' }), (tick, to) =>
    databaseSchema.options.map(database => to.create({ database })),
  )
  .handler(backupFlow, { exits: { backedUp: BackedUp } })
  .retry({ maxAttempts: 1, exhausted: BackupFailed });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply(H.clock('weekly-certificates').at('03:00', { on: 'mon', tz: 'UTC' }), (tick, to) =>
    domainSchema.options.map(domain => to.create({ domain })),
  )
  .handler(renewalFlow, { exits: { stillValid: CertificateValid, renewed: CertificateRenewed } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: RenewalFailed });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(incidentFlow, { exits: { resolved: IncidentResolved, unresolved: IncidentUnresolved } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000, exhausted: IncidentUnresolved });

const opsExperienceKind = H.memory('operational-experience', 'experience');
const opsNotes = H.journal('operational-experience', opsExperienceKind)
  .store(jsonl.memoryStore({ path: './memory/ops.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const twoHoursMs = 2 * 60 * 60 * 1000;

const heartbeatStreak = H.trigger('three-failed-heartbeats-open-incident')
  .on(H.when.pattern(heartbeats, { to: Unhealthy, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidents, e => ({
    ref: `heartbeat-${e.group}`,
    title: `${e.group} failed ${e.streak} consecutive heartbeats`,
    source: 'heartbeat',
  }));

const backupFailure = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, e => ({
    ref: `backup-${e.unit.attributes.database}-${e.at.toISOString().slice(0, 10)}`,
    title: `Backup of ${e.unit.attributes.database} failed`,
    source: 'backup',
  }));

const slowBackup = H.trigger('slow-backup-records-note')
  .on(H.when.transition(backups, { to: BackedUp, if: e => (e.attempt ? e.attempt.durationMs : 0) > twoHoursMs }))
  .record(opsNotes, e => ({
    text: `When scheduling the ${e.unit.attributes.database} backup, allow more than two hours, because the run finishing ${e.at.toISOString()} took ${Math.round((e.attempt ? e.attempt.durationMs : 0) / 60_000)} minutes.`,
    status: 'active',
    when: { kinds: [Backup], resources: [databaseResource[e.unit.attributes.database]] },
  }));

const scheduler = H.scheduler('operations')
  .expedite(incidents, { holds: [backups] })
  .standard(heartbeats, renewals, backups);

const controlApi = http.controlApi('ops-control-api', {
  port: H.slot.port(0),
  token: H.env('OPS_API_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.resolve(acknowledgement, resolutionCheck),
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

const operations = H.harness('operations')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(heartbeats, backups, renewals, incidents)
  .journals(opsNotes)
  .triggers(heartbeatStreak, backupFailure, slowBackup)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-alerts', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    markdown.board({ path: './BOARD.md' }),
  );

void operations.start();
