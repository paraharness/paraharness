import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const Service = z.enum(['api', 'web', 'worker']);
const service = H.facet('service', Service.options);
const Database = z.enum(['orders', 'users']);
const Domain = z.enum(['example.com', 'shop.example.com']);

const databases = { orders: H.resource('orders-db'), users: H.resource('users-db') };

const localRunner = local.runner('local');
const diskSpace = H.command('disk-space-preflight').argv([
  'sh',
  '-c',
  'test "$(df --output=avail -BG / | tail -1 | tr -dc 0-9)" -ge 20',
]);
const hostA = ssh
  .host('host-a', { host: 'host-a.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpace);
const hostB = ssh
  .host('host-b', { host: 'host-b.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpace);
const backupHost = { orders: hostA, users: hostB };
const renewalHost = { 'example.com': hostA, 'shop.example.com': hostB };

const HeartbeatDue = H.state('heartbeat-due', 'pending');
const Healthy = H.terminal('healthy', 'success');
const Unhealthy = H.terminal('unhealthy', 'failure');

const BackupDue = H.state('backup-due', 'pending');
const BackedUp = H.terminal('backed-up', 'success');
const BackupFailed = H.terminal('backup-failed', 'failure');

const RenewalDue = H.state('renewal-due', 'pending');
const StillValid = H.terminal('still-valid', 'success');
const Renewed = H.terminal('renewed', 'success');
const RenewalFailed = H.terminal('renewal-failed', 'failure');

const IncidentOpen = H.state('incident-open', 'pending');
const Resolved = H.terminal('resolved', 'success');
const RunbookFailed = H.terminal('runbook-failed', 'failure');

const HeartbeatAttrs = z.object({ service: Service });
const BackupAttrs = z.object({ database: Database });
const RenewalAttrs = z.object({ domain: Domain });
const IncidentAttrs = z.object({ source: z.string(), subject: z.string(), detail: z.string() });

const Heartbeat = H.kind('Heartbeat')
  .attributes(HeartbeatAttrs)
  .states(HeartbeatDue, Healthy, Unhealthy)
  .key(attrs => attrs.service)
  .initial(HeartbeatDue);

const Backup = H.kind('Backup')
  .attributes(BackupAttrs)
  .states(BackupDue, BackedUp, BackupFailed)
  .key(attrs => attrs.database)
  .initial(BackupDue);

const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(RenewalAttrs)
  .states(RenewalDue, StillValid, Renewed, RenewalFailed)
  .key(attrs => attrs.domain)
  .initial(RenewalDue);

const Incident = H.kind('Incident')
  .attributes(IncidentAttrs)
  .states(IncidentOpen, Resolved, RunbookFailed)
  .key(attrs => `${attrs.source}:${attrs.subject}`)
  .initial(IncidentOpen);

const probe = H.command('heartbeat-probe')
  .input(HeartbeatAttrs)
  .argv(input => ['./ops/heartbeat.sh', input.service])
  .runner(localRunner);

const dump = H.command('database-backup')
  .input(BackupAttrs)
  .argv(input => ['./ops/backup.sh', input.database])
  .runner(input => backupHost[input.database]);

const certificateCheck = H.command('certificate-days-left')
  .input(RenewalAttrs)
  .argv(input => ['./ops/cert-days-left.sh', input.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => renewalHost[input.domain]);

const certificateRenew = H.command('certificate-renew')
  .input(RenewalAttrs)
  .argv(input => ['./ops/cert-renew.sh', input.domain])
  .runner(input => renewalHost[input.domain]);

const pageOnCall = H.command('page-on-call')
  .input(IncidentAttrs)
  .argv(input => ['./ops/page.sh', input.subject, input.detail])
  .runner(localRunner);

const runbook = H.command('runbook')
  .input(IncidentAttrs)
  .argv(input => ['./runbooks/run.sh', input.source, input.subject])
  .runner(localRunner);

const acknowledge = H.halt('acknowledge').decision(z.object({ acknowledgedBy: z.string() }));
const confirmResolution = H.halt('confirm-resolution').decision(
  z.object({ resolved: z.boolean(), note: z.string() }),
);

const heartbeatFlow = H.flow('heartbeat')
  .input(HeartbeatAttrs)
  .step('probe', probe, ctx => ctx.unit.attributes)
  .exit('healthy');

const backupFlow = H.flow('backup')
  .input(BackupAttrs)
  .step('dump', dump, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('backedUp');

const renewalFlow = H.flow('certificate-renewal')
  .input(RenewalAttrs)
  .step('check', certificateCheck, ctx => ctx.unit.attributes)
  .exit('stillValid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', certificateRenew, ctx => ctx.unit.attributes)
  .exit('renewed');

const incidentFlow = H.flow('incident-runbook')
  .input(IncidentAttrs)
  .step('page', pageOnCall, ctx => ctx.unit.attributes)
  .halt('acknowledge', acknowledge, {
    ask: ctx => `Acknowledge incident ${ctx.unit.attributes.subject}: ${ctx.unit.attributes.detail}`,
  })
  .step('runbook', runbook, ctx => ctx.unit.attributes, { afterCrash: 'park' })
  .halt('confirm', confirmResolution, {
    ask: ctx => `Runbook finished for ${ctx.unit.attributes.subject}. Is the incident resolved?`,
  })
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('reopened');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (_tick, to) =>
    Service.options.map(name => to.create({ service: name })),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly-0100').at('01:00', { tz: 'UTC' }), (_tick, to) =>
    Database.options.map(database => to.create({ database })),
  )
  .handler(backupFlow, { exits: { backedUp: BackedUp } })
  .retry({ maxAttempts: 1, exhausted: BackupFailed });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply(H.clock('weekly-sunday-0300').at('03:00', { on: 'sun', tz: 'UTC' }), (_tick, to) =>
    Domain.options.map(domain => to.create({ domain })),
  )
  .handler(renewalFlow, { exits: { stillValid: StillValid, renewed: Renewed } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 900_000, exhausted: RenewalFailed });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(incidentFlow, { exits: { resolved: Resolved, reopened: IncidentOpen } })
  .retry({ maxAttempts: 3, backoff: 'fixed', initialDelayMs: 60_000, exhausted: RunbookFailed });

const operationalExperience = H.journal('operational-experience', H.memory('operational', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/operational.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const threeFailedHeartbeatsOpenIncident = H.trigger('three-failed-heartbeats-open-incident')
  .on(
    H.when.pattern(heartbeats, {
      to: Unhealthy,
      consecutive: 3,
      per: unit => service.of(unit.attributes.service),
    }),
  )
  .create(incidents, event => ({
    source: 'heartbeat',
    subject: event.group.value,
    detail: `${event.streak} consecutive failed heartbeats for ${event.group.value}`,
  }));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, event => ({
    source: 'backup',
    subject: event.unit.attributes.database,
    detail: `Backup of ${event.unit.attributes.database} failed at ${event.at.toISOString()}`,
  }));

const slowBackupIsNoted = H.trigger('slow-backup-is-noted')
  .on(
    H.when.transition(backups, {
      to: BackedUp,
      if: event => (event.attempt?.durationMs ?? 0) > 2 * 3_600_000,
    }),
  )
  .record(operationalExperience, event => ({
    text: `When scheduling the ${event.unit.attributes.database} backup, allow more than two hours, because the run finishing ${event.at.toISOString()} took ${((event.attempt?.durationMs ?? 0) / 3_600_000).toFixed(1)} hours`,
    when: { kinds: [Backup], resources: [databases[event.unit.attributes.database]] },
    status: 'active',
  }));

const scheduler = H.scheduler('operations')
  .expedite(incidents, { holds: [backups] })
  .standard(heartbeats, backups, renewals);

const controlApi = http.controlApi('ops-control', {
  port: H.slot.port(0),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.resolve(acknowledge, confirmResolution),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export default H.harness('operations')
  .ledger(sqlite.ledger({ path: '/var/lib/harness/ledger.sqlite' }))
  .lanes(incidents, heartbeats, backups, renewals)
  .journals(operationalExperience)
  .triggers(threeFailedHeartbeatsOpenIncident, failedBackupOpensIncident, slowBackupIsNoted)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-channel', { webhookUrl: H.env('SLACK_INCIDENT_WEBHOOK'), lanes: [incidents] }),
    markdown.board({ path: '/var/lib/harness/BOARD.md' }),
  );
