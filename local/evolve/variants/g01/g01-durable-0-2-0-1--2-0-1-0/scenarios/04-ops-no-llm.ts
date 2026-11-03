import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const localRunner = local.runner('local').slots(4);

const diskSpacePreflight = H.command('disk-space-preflight').argv([
  'sh',
  '-c',
  'test "$(df --output=avail -BG /var/backups | tail -1 | tr -dc 0-9)" -ge 50',
]);

const dbHostA = ssh
  .host('db-a', { host: 'db-a.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpacePreflight);
const dbHostB = ssh
  .host('db-b', { host: 'db-b.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpacePreflight);

const hostFor = (host: string) => (host === 'db-a' ? dbHostA : dbHostB);

const ordersDb = H.resource('orders-db');
const billingDb = H.resource('billing-db');
const resourceFor = (database: string) => (database === 'orders' ? ordersDb : billingDb);

const databases = [
  { database: 'orders', host: 'db-a' },
  { database: 'billing', host: 'db-b' },
];
const certificates = [
  { domain: 'api.example.com', host: 'db-a' },
  { domain: 'www.example.com', host: 'db-b' },
];
const services = ['api', 'worker', 'web'];

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Up = H.terminal('Up', 'success');
const Down = H.terminal('Down', 'failure');

const Heartbeat = H.kind('Heartbeat')
  .attributes(z.object({ service: z.string(), scheduledAt: z.string() }))
  .states(Due, Probing, Up, Down)
  .key((beat) => `${beat.service}@${beat.scheduledAt}`)
  .initial(Due);

const BackupQueued = H.state('BackupQueued', 'pending');
const BackingUp = H.state('BackingUp', 'active');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');

const backupSchema = z.object({ database: z.string(), host: z.string(), night: z.string() });

const Backup = H.kind('Backup')
  .attributes(backupSchema)
  .states(BackupQueued, BackingUp, BackedUp, BackupFailed)
  .key((backup) => `${backup.database}@${backup.night}`)
  .initial(BackupQueued);

const CheckScheduled = H.state('CheckScheduled', 'pending');
const Checking = H.state('Checking', 'active');
const Renewing = H.state('Renewing', 'active');
const StillValid = H.terminal('StillValid', 'success');
const Renewed = H.terminal('Renewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');

const certificateSchema = z.object({ domain: z.string(), host: z.string(), week: z.string() });

const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(certificateSchema)
  .states(CheckScheduled, Checking, Renewing, StillValid, Renewed, RenewalFailed)
  .key((renewal) => `${renewal.domain}@${renewal.week}`)
  .initial(CheckScheduled);

const IncidentOpen = H.state('IncidentOpen', 'pending');
const AwaitingAck = H.state('AwaitingAck', 'waiting');
const Mitigating = H.state('Mitigating', 'active');
const AwaitingConfirmation = H.state('AwaitingConfirmation', 'waiting');
const Resolved = H.terminal('Resolved', 'success');
const Unresolved = H.terminal('Unresolved', 'failure');

const incidentSchema = z.object({ key: z.string(), title: z.string(), detail: z.string() });

const Incident = H.kind('Incident')
  .attributes(incidentSchema)
  .states(IncidentOpen, AwaitingAck, Mitigating, AwaitingConfirmation, Resolved, Unresolved)
  .key((incident) => incident.key)
  .initial(IncidentOpen);

const heartbeatCommand = H.command('heartbeat')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['./bin/heartbeat', input.service])
  .runner(localRunner);

const backupCommand = H.command('backup')
  .input(z.object({ database: z.string(), host: z.string() }))
  .argv((input) => ['/usr/local/bin/backup-db', input.database])
  .runner((input) => hostFor(input.host));

const certificateCheck = H.command('certificate-check')
  .input(z.object({ domain: z.string(), host: z.string() }))
  .argv((input) => ['/usr/local/bin/cert-days-left', input.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner((input) => hostFor(input.host));

const certificateRenew = H.command('certificate-renew')
  .input(z.object({ domain: z.string(), host: z.string() }))
  .argv((input) => ['/usr/local/bin/cert-renew', input.domain])
  .runner((input) => hostFor(input.host));

const runbook = H.command('incident-runbook')
  .input(z.object({ key: z.string(), detail: z.string() }))
  .argv((input) => ['./runbooks/run', input.key, input.detail])
  .runner(localRunner);

const incidentAcknowledged = H.halt('incident-acknowledged').decision(z.object({ responder: z.string() }));
const incidentResolution = H.halt('incident-resolution').decision(
  z.object({ resolved: z.boolean(), note: z.string() }),
);

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ service: z.string(), scheduledAt: z.string() }))
  .step('probe', heartbeatCommand, (ctx) => ({ service: ctx.unit.attributes.service }))
  .exit('up');

const backupFlow = H.flow('backup')
  .input(backupSchema)
  .step(
    'backup',
    backupCommand,
    (ctx) => ({ database: ctx.unit.attributes.database, host: ctx.unit.attributes.host }),
    { afterCrash: 'rerun' },
  )
  .exit('done');

const renewalFlow = H.flow('certificate-renewal')
  .input(certificateSchema)
  .step('check', certificateCheck, (ctx) => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }))
  .exit('stillValid', (ctx) => ctx.steps.check.daysLeft >= 14)
  .step('renew', certificateRenew, (ctx) => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }))
  .exit('renewed');

const incidentFlow = H.flow('incident-runbook')
  .input(incidentSchema)
  .halt('acknowledge', incidentAcknowledged, {
    ask: (ctx) => `Incident ${ctx.unit.attributes.key}: ${ctx.unit.attributes.title}. Acknowledge to run the runbook.`,
  })
  .step('runbook', runbook, (ctx) => ({ key: ctx.unit.attributes.key, detail: ctx.unit.attributes.detail }), {
    afterCrash: 'park',
  })
  .halt('confirm', incidentResolution, {
    ask: (ctx) => `Runbook finished for ${ctx.unit.attributes.key}. Confirm the incident is resolved.`,
  })
  .exit('resolved', (ctx) => ctx.steps.confirm.resolved)
  .exit('unresolved');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    services.map((service) => to.create({ service, scheduledAt: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, { exits: { up: Up }, during: { probe: Probing } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: Down });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly').at('01:00', { tz: 'UTC' }), (tick, to) =>
    databases.map((db) => to.create({ ...db, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/store.sqlite' }))
  .handler(backupFlow, { exits: { done: BackedUp }, during: { backup: BackingUp } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: BackupFailed });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply(H.clock('weekly-certificate-check').at('04:00', { on: 'mon', tz: 'UTC' }), (tick, to) =>
    certificates.map((cert) => to.create({ ...cert, week: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/store.sqlite' }))
  .handler(renewalFlow, {
    exits: { stillValid: StillValid, renewed: Renewed },
    during: { check: Checking, renew: Renewing },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600_000, exhausted: RenewalFailed });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .store(sqlite.store({ path: '.harness/store.sqlite' }))
  .handler(incidentFlow, {
    exits: { resolved: Resolved, unresolved: Unresolved },
    during: { acknowledge: AwaitingAck, runbook: Mitigating, confirm: AwaitingConfirmation },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000, exhausted: Unresolved });

const operationalExperience = H.memory('operational-experience', 'experience');

const operationsJournal = H.journal('operations', operationalExperience)
  .store(jsonl.memoryStore({ path: 'memory/operations.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const missedHeartbeatsOpenIncident = H.trigger('three-missed-heartbeats-open-incident')
  .on(H.when.pattern(heartbeats, { to: Down, consecutive: 3, per: (unit) => unit.attributes.service }))
  .create(incidents, (event) => ({
    key: `heartbeat:${event.group}`,
    title: `${event.group} missed ${event.streak} consecutive heartbeats`,
    detail: `Last failed heartbeat recorded at ${event.at.toISOString()}`,
  }));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, (event) => ({
    key: `backup:${event.unit.attributes.database}:${event.unit.attributes.night}`,
    title: `Backup of ${event.unit.attributes.database} failed`,
    detail: `Night ${event.unit.attributes.night} on ${event.unit.attributes.host}`,
  }));

const twoHoursMs = 2 * 60 * 60 * 1000;

const slowBackupNoted = H.trigger('slow-backup-noted')
  .on(
    H.when.transition(backups, {
      to: BackedUp,
      if: (event) => (event.attempt?.durationMs ?? 0) > twoHoursMs,
    }),
  )
  .record(operationsJournal, (event) => ({
    text: `When scheduling the ${event.unit.attributes.database} backup, start it earlier or split it, because the ${event.unit.attributes.night} run took ${((event.attempt?.durationMs ?? 0) / 3_600_000).toFixed(1)} hours.`,
    status: 'active',
    when: { kinds: [Backup], resources: [resourceFor(event.unit.attributes.database)] },
  }));

const scheduler = H.scheduler('operations')
  .priority(incidents, heartbeats, renewals, backups)
  .admit(backups, ({ count }) => count(incidents, 'active', 'waiting') === 0);

const controlApi = http.controlApi('operator-http', {
  port: H.slot.port(1),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.resolve(incidentAcknowledged),
    H.ops.resolve(incidentResolution),
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const harness = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(incidents, heartbeats, renewals, backups)
  .journals(operationsJournal)
  .triggers(missedHeartbeatsOpenIncident, failedBackupOpensIncident, slowBackupNoted)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-feed', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    markdown.board({ path: 'BOARD.md' }),
  );

void harness.start();
