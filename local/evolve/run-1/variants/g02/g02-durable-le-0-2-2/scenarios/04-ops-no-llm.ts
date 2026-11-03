import { z } from 'zod';
import { H } from 'harness-dsl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const Host = z.enum(['db-east', 'db-west']);
const ServiceSchema = z.object({ service: z.string() });
const BackupSchema = z.object({ database: z.string(), host: Host });
const RenewalSchema = z.object({ domain: z.string(), host: Host });
const IncidentSchema = z.object({ subject: z.string(), detail: z.string() });

const Cancelled = H.terminal('Cancelled', 'neutral');

const Due = H.state('Due', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const Scheduled = H.state('Scheduled', 'pending');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');

const Checking = H.state('Checking', 'pending');
const Valid = H.terminal('Valid', 'success');
const Renewed = H.terminal('Renewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');

const Open = H.state('Open', 'pending');
const Resolved = H.terminal('Resolved', 'success');

const Heartbeat = H.kind('Heartbeat')
  .attributes(ServiceSchema)
  .states(Due, Healthy, Unhealthy, Cancelled)
  .key(heartbeat => heartbeat.service)
  .initial(Due)
  .onCancelled(Cancelled);

const Backup = H.kind('Backup')
  .attributes(BackupSchema)
  .states(Scheduled, BackedUp, BackupFailed, Cancelled)
  .key(backup => backup.database)
  .initial(Scheduled)
  .onAttemptFailed(BackupFailed)
  .onCancelled(Cancelled);

const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(RenewalSchema)
  .states(Checking, Valid, Renewed, RenewalFailed, Cancelled)
  .key(renewal => renewal.domain)
  .initial(Checking)
  .onAttemptFailed(RenewalFailed)
  .onCancelled(Cancelled);

const Incident = H.kind('Incident')
  .attributes(IncidentSchema)
  .states(Open, Resolved, Cancelled)
  .key(incident => incident.subject)
  .initial(Open)
  .onCancelled(Cancelled);

const localRunner = local.runner('local').slots(4);

const diskSpacePreflight = H.command('diskSpacePreflight')
  .argv(['sh', '-c', 'test "$(df --output=avail -k /var/backups | tail -1)" -gt 52428800']);

const sshKey = H.env('OPS_SSH_KEY');
const dbEast = ssh.host('db-east', { host: 'db-east.internal', user: 'ops', key: sshKey })
  .slots(1)
  .preflight(diskSpacePreflight);
const dbWest = ssh.host('db-west', { host: 'db-west.internal', user: 'ops', key: sshKey })
  .slots(1)
  .preflight(diskSpacePreflight);

const probeService = H.command('probeService')
  .input(ServiceSchema)
  .argv(input => ['./ops/probe.sh', input.service])
  .runner(localRunner)
  .acceptExitCodes(1);

const backupDatabase = H.command('backupDatabase')
  .input(BackupSchema)
  .argv(input => ['/opt/ops/backup.sh', input.database])
  .runner(input => input.host === 'db-east' ? dbEast : dbWest);

const certificateDaysLeft = H.command('certificateDaysLeft')
  .input(RenewalSchema)
  .argv(input => ['/opt/ops/cert-days-left.sh', input.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => input.host === 'db-east' ? dbEast : dbWest);

const renewCertificate = H.command('renewCertificate')
  .input(RenewalSchema)
  .argv(input => ['/opt/ops/renew-cert.sh', input.domain])
  .runner(input => input.host === 'db-east' ? dbEast : dbWest);

const incidentRunbook = H.command('incidentRunbook')
  .input(z.object({ subject: z.string() }))
  .argv(input => ['./ops/runbook.sh', input.subject])
  .runner(localRunner)
  .acceptExitCodes(1);

const heartbeatFlow = H.flow('heartbeat')
  .input(ServiceSchema)
  .step('probe', probeService, ctx => ctx.unit.attributes)
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const backupFlow = H.flow('backup')
  .input(BackupSchema)
  .step('backup', backupDatabase, ctx => ctx.unit.attributes, {
    retry: H.retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600_000 }),
    afterCrash: 'rerun',
  })
  .exit('backedUp');

const renewalFlow = H.flow('certificateRenewal')
  .input(RenewalSchema)
  .step('check', certificateDaysLeft, ctx => ctx.unit.attributes)
  .exit('valid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', renewCertificate, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('renewed');

const incidentFlow = H.flow('incidentRunbook')
  .input(IncidentSchema)
  .halt('acknowledge', z.object({ acknowledgedBy: z.string() }), {
    ask: ctx => `Acknowledge incident ${ctx.unit.attributes.subject}:\n\n${ctx.unit.attributes.detail}`,
  })
  .step('runbook', incidentRunbook, ctx => ({ subject: ctx.unit.attributes.subject }), { afterCrash: 'park' })
  .halt('resolution', z.object({ notes: z.string() }), {
    ask: ctx => `Runbook for ${ctx.unit.attributes.subject} exited ${ctx.steps.runbook.exitCode}:\n\n${ctx.steps.runbook.stdout}\n\nConfirm the incident is resolved.`,
  })
  .exit('resolved');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('everyFiveMinutes').every({ minutes: 5 }), (_tick, to) =>
    ['api', 'web', 'queue'].map(service => to.create({ service })))
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy } });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly').daily('01:30', { tz: 'UTC' }), (_tick, to) => [
    to.create({ database: 'orders', host: 'db-east' }),
    to.create({ database: 'customers', host: 'db-west' }),
  ])
  .handler(backupFlow, { exits: { backedUp: BackedUp } });

const renewals = H.lane('renewals', CertificateRenewal)
  .supply(H.clock('weekly').weekly('mon', '04:00', { tz: 'UTC' }), (_tick, to) => [
    to.create({ domain: 'db-east.internal', host: 'db-east' }),
    to.create({ domain: 'db-west.internal', host: 'db-west' }),
  ])
  .handler(renewalFlow, { exits: { valid: Valid, renewed: Renewed } });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(incidentFlow, { exits: { resolved: Resolved } });

const OperationalExperience = H.memory('operationalExperience').trust('experience');

const operations = H.journal('operationalExperience', OperationalExperience)
  .store(jsonl.memoryStore({ path: '.harness/operations.jsonl' }))
  .recall(H.recall('mostSpecific', { by: 'specificity', limit: 20 }));

const heartbeatStreakOpensIncident = H.trigger('heartbeatStreakOpensIncident', H.when.pattern(heartbeats, {
  to: Unhealthy,
  consecutive: 3,
  per: unit => unit.attributes.service,
}))
  .create(incidents, event => ({
    subject: `heartbeat:${event.group}`,
    detail: `${event.group} failed ${event.streak} consecutive heartbeats, the last at ${event.at.toISOString()}.`,
  }));

const failedBackupOpensIncident = H.trigger('failedBackupOpensIncident', H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, event => ({
    subject: `backup:${event.unit.attributes.database}`,
    detail: `Backup of ${event.unit.attributes.database} on ${event.unit.attributes.host} failed at ${event.at.toISOString()}.`,
  }));

const slowBackupNoted = H.trigger('slowBackupNoted', H.when.transition(backups, {
  to: BackedUp,
  if: event => (event.attempt?.durationMs ?? 0) > 2 * 3_600_000,
}))
  .record(operations, event => ({
    body: {
      text: `When scheduling the ${event.unit.attributes.database} backup on ${event.unit.attributes.host}, allow more than two hours, because the run ending ${event.at.toISOString()} took ${Math.round((event.attempt?.durationMs ?? 0) / 60_000)} minutes.`,
    },
    when: { kinds: [Backup], resources: [event.unit.attributes.host] },
  }));

const scheduler = H.scheduler('operations')
  .priority(incidents, heartbeats, renewals, backups)
  .admit(backups, ctx => ctx.count(incidents) === 0);

const controlApi = http.controlApi('opsControl', {
  port: H.slot.port(0),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.blockersResolve, H.ops.memoryRead, H.ops.telemetryRead],
});

export const operationsHarness = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(heartbeats, backups, renewals, incidents)
  .journals(operations)
  .triggers(heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupNoted)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incidentNotifier', { webhookUrl: H.env('SLACK_INCIDENT_WEBHOOK'), lanes: [incidents] }),
    markdown.board({ path: 'BOARD.md' }),
  );
