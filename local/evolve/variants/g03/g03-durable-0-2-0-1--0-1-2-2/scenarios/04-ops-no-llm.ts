import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const serviceEnum = z.enum(['api', 'web', 'worker']);
const services = H.resources('service', serviceEnum.options);
const databaseEnum = z.enum(['orders', 'analytics']);
const databases = H.resources('database', databaseEnum.options);
const certificateDomains = ['example.com', 'api.example.com'];

const Scheduled = H.state('Scheduled', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const HeartbeatFailed = H.terminal('HeartbeatFailed', 'failure');
const BackupDue = H.state('BackupDue', 'pending');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');
const CheckDue = H.state('CheckDue', 'pending');
const Renewed = H.terminal('Renewed', 'success');
const NotDue = H.terminal('NotDue', 'neutral');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');
const IncidentOpen = H.state('IncidentOpen', 'pending');
const Resolved = H.terminal('Resolved', 'success');
const Unresolved = H.terminal('Unresolved', 'failure');

const heartbeatAttrs = z.object({ service: serviceEnum, checkedAt: z.date() });
const backupAttrs = z.object({ database: databaseEnum, night: z.date() });
const renewalAttrs = z.object({ domain: z.string(), week: z.date() });
const incidentAttrs = z.object({ ref: z.string(), title: z.string(), detail: z.string() });

const Heartbeat = H.kind('Heartbeat')
  .attributes(heartbeatAttrs)
  .states(Scheduled, Healthy, HeartbeatFailed)
  .key(a => `${a.service}@${a.checkedAt.toISOString()}`)
  .initial(Scheduled);
const Backup = H.kind('Backup')
  .attributes(backupAttrs)
  .states(BackupDue, BackedUp, BackupFailed)
  .key(a => `${a.database}@${a.night.toISOString().slice(0, 10)}`)
  .initial(BackupDue);
const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(renewalAttrs)
  .states(CheckDue, Renewed, NotDue, RenewalFailed)
  .key(a => `${a.domain}@${a.week.toISOString().slice(0, 10)}`)
  .initial(CheckDue);
const Incident = H.kind('Incident')
  .attributes(incidentAttrs)
  .states(IncidentOpen, Resolved, Unresolved)
  .key(a => a.ref)
  .initial(IncidentOpen);

const acknowledgement = H.halt('incident-acknowledgement').decision(z.object({ acknowledgedBy: z.string() }));
const resolutionConfirmed = H.halt('incident-resolution').decision(z.object({ resolved: z.boolean(), notes: z.string() }));

const localRunner = local.runner('local');
const diskSpacePreflight = H.command('disk-space-preflight').argv(['./ops/check-disk', '--min-free-gb', '50']);
const primaryHost = ssh
  .host('db-primary', { host: 'db1.internal', user: 'ops', key: H.env('SSH_KEY_DB_PRIMARY') })
  .slots(1)
  .preflight(diskSpacePreflight);
const analyticsHost = ssh
  .host('db-analytics', { host: 'db2.internal', user: 'ops', key: H.env('SSH_KEY_DB_ANALYTICS') })
  .slots(1)
  .preflight(diskSpacePreflight);

const heartbeatCheck = H.command('heartbeat-check')
  .input(z.object({ service: serviceEnum }))
  .argv(i => ['./ops/heartbeat', i.service])
  .runner(localRunner);
const backupDatabase = H.command('backup-database')
  .input(z.object({ database: databaseEnum }))
  .argv(i => ['./ops/backup', i.database])
  .runner(i => (i.database === 'orders' ? primaryHost : analyticsHost));
const certificateCheck = H.command('certificate-check')
  .input(z.object({ domain: z.string() }))
  .argv(i => ['./ops/cert-days-remaining', i.domain])
  .output(z.object({ daysRemaining: z.number() }))
  .runner(primaryHost);
const certificateRenew = H.command('certificate-renew')
  .input(z.object({ domain: z.string() }))
  .argv(i => ['./ops/cert-renew', i.domain])
  .runner(primaryHost);
const pageOnCall = H.command('page-on-call')
  .input(incidentAttrs)
  .argv(i => ['./ops/page', '--title', i.title, '--detail', i.detail])
  .runner(localRunner);
const incidentRunbook = H.command('incident-runbook')
  .input(incidentAttrs)
  .argv(i => ['./ops/runbook', i.ref])
  .runner(localRunner);

const renewalThresholdDays = 14;

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatAttrs)
  .step('check', heartbeatCheck, ctx => ({ service: ctx.unit.attributes.service }), { afterCrash: 'rerun' })
  .exit('healthy');

const backupFlow = H.flow('backup')
  .input(backupAttrs)
  .step('backup', backupDatabase, ctx => ({ database: ctx.unit.attributes.database }), { afterCrash: 'rerun' })
  .exit('backedUp');

const renewalFlow = H.flow('certificate-renewal')
  .input(renewalAttrs)
  .step('check', certificateCheck, ctx => ({ domain: ctx.unit.attributes.domain }), { afterCrash: 'rerun' })
  .exit('notDue', ctx => ctx.steps.check.daysRemaining >= renewalThresholdDays)
  .step('renew', certificateRenew, ctx => ({ domain: ctx.unit.attributes.domain }), { afterCrash: 'rerun' })
  .exit('renewed');

const incidentFlow = H.flow('incident-runbook')
  .input(incidentAttrs)
  .step('page', pageOnCall, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .halt('acknowledge', acknowledgement, { ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.title}` })
  .step('runbook', incidentRunbook, ctx => ctx.unit.attributes, { afterCrash: 'park' })
  .halt('confirmResolution', resolutionConfirmed, {
    ask: ctx => `Runbook exited ${ctx.steps.runbook.exitCode}. Is "${ctx.unit.attributes.title}" resolved?`,
  })
  .exit('resolved', ctx => ctx.steps.confirmResolution.resolved)
  .exit('unresolved');

const tz = 'UTC';

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    services.members.map(s => to.create({ service: s.value, checkedAt: tick.at })),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy } })
  .retry({ maxAttempts: 1, exhausted: HeartbeatFailed });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly-backup').at('01:00', { tz }), (tick, to) =>
    databases.members.map(d => to.create({ database: d.value, night: tick.at })),
  )
  .handler(backupFlow, { exits: { backedUp: BackedUp } })
  .retry({ maxAttempts: 1, exhausted: BackupFailed });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply(H.clock('weekly-certificate-check').at('03:00', { on: 'sun', tz }), (tick, to) =>
    certificateDomains.map(domain => to.create({ domain, week: tick.at })),
  )
  .handler(renewalFlow, { exits: { notDue: NotDue, renewed: Renewed } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: RenewalFailed });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(incidentFlow, { exits: { resolved: Resolved, unresolved: Unresolved } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000, exhausted: Unresolved });

const operationalExperience = H.journal('operational-experience', H.memory('operational-experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/operations.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const slowBackupMs = 2 * 3_600_000;

const repeatedHeartbeatFailureOpensIncident = H.trigger('repeated-heartbeat-failure-opens-incident')
  .on(
    H.when.pattern(heartbeats, {
      to: HeartbeatFailed,
      consecutive: 3,
      per: u => services.of(u.attributes.service),
    }),
  )
  .create(incidents, e => ({
    ref: `heartbeat-${e.resource.value}`,
    title: `${e.resource.value} failed ${e.streak} consecutive heartbeats`,
    detail: `Latest failure at ${e.at.toISOString()}`,
  }));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, e => ({
    ref: `backup-${e.unit.key}`,
    title: `Backup of ${e.unit.attributes.database} failed`,
    detail: `Backup unit ${e.unit.key} failed at ${e.at.toISOString()}`,
  }));

const slowBackupRecordsExperience = H.trigger('slow-backup-records-experience')
  .on(H.when.transition(backups, { to: BackedUp, if: e => (e.attempt?.durationMs ?? 0) > slowBackupMs }))
  .record(operationalExperience, e => ({
    text: `When backing up ${e.unit.attributes.database}, check disk throughput and start earlier, because the backup of ${e.unit.key} took ${Math.round((e.attempt?.durationMs ?? 0) / 60_000)} minutes.`,
    when: { kinds: [Backup], resources: [databases.of(e.unit.attributes.database)] },
  }));

const scheduler = H.scheduler('operations')
  .expedite(incidents, { holds: [backups] })
  .standard(heartbeats, renewals, backups);

const controlApi = http.controlApi('ops-control-api', {
  port: H.slot.port(1),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.resolve(acknowledgement, resolutionConfirmed),
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('operations')
  .ledger(sqlite.ledger({ path: 'operations.sqlite' }))
  .lanes(heartbeats, backups, renewals, incidents)
  .journals(operationalExperience)
  .triggers(repeatedHeartbeatFailureOpensIncident, failedBackupOpensIncident, slowBackupRecordsExperience)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-notifier', { webhookUrl: H.env('SLACK_INCIDENT_WEBHOOK'), lanes: [incidents] }),
    markdown.board({ path: 'BOARD.md' }),
  );
