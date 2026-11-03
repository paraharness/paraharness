import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const serviceName = z.enum(['api', 'web', 'worker']);
const databaseName = z.enum(['orders', 'billing']);
const domainName = z.enum(['shop.example.com', 'api.example.com']);
const databases = H.resources('database', databaseName.options);

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const HeartbeatOk = H.terminal('HeartbeatOk', 'success');
const HeartbeatFailed = H.terminal('HeartbeatFailed', 'failure');
const BackupDue = H.state('BackupDue', 'pending');
const BackupDone = H.terminal('BackupDone', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');
const RenewalDue = H.state('RenewalDue', 'pending');
const CertificateFresh = H.terminal('CertificateFresh', 'success');
const CertificateRenewed = H.terminal('CertificateRenewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');
const IncidentOpen = H.state('IncidentOpen', 'pending');
const IncidentResolved = H.terminal('IncidentResolved', 'success');

const heartbeatKind = H.kind('Heartbeat')
  .attributes(z.object({ service: serviceName }))
  .states(HeartbeatDue, HeartbeatOk, HeartbeatFailed)
  .initial(HeartbeatDue);

const backupKind = H.kind('Backup')
  .attributes(z.object({ database: databaseName }))
  .states(BackupDue, BackupDone, BackupFailed)
  .key(a => a.database)
  .initial(BackupDue);

const renewalKind = H.kind('CertificateRenewal')
  .attributes(z.object({ domain: domainName }))
  .states(RenewalDue, CertificateFresh, CertificateRenewed, RenewalFailed)
  .key(a => a.domain)
  .initial(RenewalDue);

const incidentAttrs = z.object({ service: z.string(), title: z.string(), cause: z.string() });

const incidentKind = H.kind('Incident')
  .attributes(incidentAttrs)
  .states(IncidentOpen, IncidentResolved)
  .key(a => a.service)
  .initial(IncidentOpen);

const acknowledgement = H.halt('incident-acknowledgement').decision(z.object({ acknowledgedBy: z.string() }));
const resolution = H.halt('incident-resolution').decision(z.object({ resolved: z.boolean(), note: z.string() }));

const localRunner = local.runner('local');

const diskSpace = H.command('disk-space-preflight').argv(['sh', '-c', 'test $(df --output=pcent / | tail -1 | tr -dc 0-9) -lt 85']);

const hostA = ssh.host('host-a', { host: 'host-a.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpace);
const hostB = ssh.host('host-b', { host: 'host-b.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpace);

const databaseHost = { orders: hostA, billing: hostB };
const domainHost = { 'shop.example.com': hostA, 'api.example.com': hostB };

const probe = H.command('heartbeat-probe')
  .input(z.object({ service: serviceName }))
  .argv(i => ['./bin/heartbeat', i.service])
  .acceptExitCodes(0, 1)
  .runner(localRunner);

const backupCommand = H.command('backup-database')
  .input(z.object({ database: databaseName }))
  .argv(i => ['/opt/ops/backup.sh', i.database])
  .runner(i => databaseHost[i.database]);

const certificateCheck = H.command('certificate-check')
  .input(z.object({ domain: domainName }))
  .argv(i => ['/opt/ops/cert-days-left.sh', i.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(i => domainHost[i.domain]);

const certificateRenew = H.command('certificate-renew')
  .input(z.object({ domain: domainName }))
  .argv(i => ['/opt/ops/cert-renew.sh', i.domain])
  .runner(i => domainHost[i.domain]);

const runbook = H.command('incident-runbook')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./runbooks/run.sh', i.service])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ service: serviceName }))
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('ok', ctx => ctx.steps.probe.exitCode === 0)
  .exit('failed');

const backupFlow = H.flow('backup')
  .input(z.object({ database: databaseName }))
  .step('backup', backupCommand, ctx => ({ database: ctx.unit.attributes.database }), { afterCrash: 'rerun' })
  .exit('done');

const renewalFlow = H.flow('certificate-renewal')
  .input(z.object({ domain: domainName }))
  .step('check', certificateCheck, ctx => ({ domain: ctx.unit.attributes.domain }))
  .exit('fresh', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', certificateRenew, ctx => ({ domain: ctx.unit.attributes.domain }), { afterCrash: 'rerun' })
  .exit('renewed');

const incidentFlow = H.flow('incident-runbook')
  .input(incidentAttrs)
  .halt('acknowledge', acknowledgement, {
    ask: ctx => `Acknowledge incident on ${ctx.unit.attributes.service}: ${ctx.unit.attributes.title}`,
  })
  .step('runbook', runbook, ctx => ({ service: ctx.unit.attributes.service }), { afterCrash: 'park' })
  .halt('confirm', resolution, {
    ask: ctx => `Runbook finished for ${ctx.unit.attributes.service}. Is the incident resolved?`,
  })
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const heartbeats = H.lane('heartbeats', heartbeatKind)
  .supply(H.clock('heartbeat-clock').every({ minutes: 5 }), (tick, to) =>
    serviceName.options.map(service => to.create({ service })))
  .handler(heartbeatFlow, { exits: { ok: HeartbeatOk, failed: HeartbeatFailed } })
  .retry({ maxAttempts: 1, exhausted: HeartbeatFailed });

const backups = H.lane('backups', backupKind)
  .supply(H.clock('nightly-backups').at('01:00', { tz: 'UTC' }), (tick, to) =>
    databaseName.options.map(database => to.create({ database })))
  .handler(backupFlow, { exits: { done: BackupDone } })
  .retry({ maxAttempts: 1, exhausted: BackupFailed });

const renewals = H.lane('certificate-renewals', renewalKind)
  .supply(H.clock('weekly-certificates').at('04:00', { on: 'sun', tz: 'UTC' }), (tick, to) =>
    domainName.options.map(domain => to.create({ domain })))
  .handler(renewalFlow, { exits: { fresh: CertificateFresh, renewed: CertificateRenewed } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 3_600_000, exhausted: RenewalFailed });

const incidents = H.lane('incidents', incidentKind)
  .supply(H.operator)
  .handler(incidentFlow, { exits: { resolved: IncidentResolved, unresolved: IncidentOpen } })
  .retry({ maxAttempts: 3, backoff: 'fixed', initialDelayMs: 60_000, exhausted: IncidentOpen });

const operationalExperience = H.journal('operational-experience', H.memory('operational-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/memory/operations.jsonl' }));

const heartbeatStreakOpensIncident = H.trigger('heartbeat-streak-opens-incident')
  .on(H.when.pattern(heartbeats, { to: HeartbeatFailed, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidents, e => ({
    service: e.group,
    title: `${e.group} failed ${e.streak} consecutive heartbeats`,
    cause: 'heartbeat',
  }));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, e => ({
    service: `backup-${e.unit.attributes.database}`,
    title: `Backup of ${e.unit.attributes.database} failed`,
    cause: 'backup',
  }));

const slowBackupNote = H.trigger('slow-backup-note')
  .on(H.when.transition(backups, {
    to: BackupDone,
    if: e => (e.attempt?.durationMs ?? 0) > 2 * 3_600_000,
  }))
  .record(operationalExperience, e => ({
    text: `When scheduling the ${e.unit.attributes.database} backup, start it earlier or split it, because it took ${Math.round((e.attempt?.durationMs ?? 0) / 60_000)} minutes.`,
    when: { kinds: [backupKind], resources: [databases.get(e.unit.attributes.database)] },
    status: 'active',
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
    H.ops.resolve(acknowledgement, resolution),
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(incidents, heartbeats, renewals, backups)
  .journals(operationalExperience)
  .triggers(heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupNote)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-notifier', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    markdown.board({ path: 'BOARD.md' }),
  );

void harness.start();
