import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const twoHoursMs = 2 * 60 * 60 * 1000;
const services = ['api', 'web', 'worker'];
const databases = [
  { database: 'orders', host: 'ops-1' },
  { database: 'billing', host: 'ops-2' },
];
const certificates = [
  { domain: 'api.example.com', host: 'ops-1' },
  { domain: 'www.example.com', host: 'ops-2' },
];

const localRunner = local.runner('local').slots(8);

const diskSpace = H.command('disk-space-preflight')
  .argv(['sh', '-c', 'test "$(df --output=avail / | tail -1)" -gt 10485760']);

const opsOne = ssh.host('ops-1', { host: 'ops-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpace);
const opsTwo = ssh.host('ops-2', { host: 'ops-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpace);

const hostRunner = (host: string) => (host === 'ops-1' ? opsOne : opsTwo);

const Due = H.state('Due', 'pending');
const Checking = H.state('Checking', 'active');
const Up = H.terminal('Up', 'success');
const Down = H.terminal('Down', 'failure');

const Heartbeat = H.kind('Heartbeat')
  .attributes(z.object({ service: z.string() }))
  .states(Due, Checking, Up, Down)
  .key(attrs => attrs.service)
  .initial(Due)
  .onAttemptFailed(Down)
  .onCancelled(Down);

const backupSchema = z.object({ database: z.string(), host: z.string() });

const Scheduled = H.state('Scheduled', 'pending');
const BackingUp = H.state('BackingUp', 'active');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');
const BackupSkipped = H.terminal('BackupSkipped', 'neutral');

const Backup = H.kind('Backup')
  .attributes(backupSchema)
  .states(Scheduled, BackingUp, BackedUp, BackupFailed, BackupSkipped)
  .key(attrs => attrs.database)
  .initial(Scheduled)
  .onAttemptFailed(BackupFailed)
  .onCancelled(BackupSkipped);

const renewalSchema = z.object({ domain: z.string(), host: z.string() });

const RenewalDue = H.state('RenewalDue', 'pending');
const Inspecting = H.state('Inspecting', 'active');
const Renewing = H.state('Renewing', 'active');
const StillValid = H.terminal('StillValid', 'success');
const Renewed = H.terminal('Renewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');
const RenewalSkipped = H.terminal('RenewalSkipped', 'neutral');

const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(renewalSchema)
  .states(RenewalDue, Inspecting, Renewing, StillValid, Renewed, RenewalFailed, RenewalSkipped)
  .key(attrs => attrs.domain)
  .initial(RenewalDue)
  .onAttemptFailed(RenewalFailed)
  .onCancelled(RenewalSkipped);

const incidentSchema = z.object({ service: z.string(), source: z.string(), title: z.string() });

const Open = H.state('Open', 'pending');
const AwaitingAcknowledgement = H.state('AwaitingAcknowledgement', 'waiting');
const Remediating = H.state('Remediating', 'active');
const AwaitingConfirmation = H.state('AwaitingConfirmation', 'waiting');
const IncidentResolved = H.terminal('IncidentResolved', 'success');
const IncidentUnresolved = H.terminal('IncidentUnresolved', 'failure');
const IncidentWithdrawn = H.terminal('IncidentWithdrawn', 'neutral');

const Incident = H.kind('Incident')
  .attributes(incidentSchema)
  .states(Open, AwaitingAcknowledgement, Remediating, AwaitingConfirmation, IncidentResolved, IncidentUnresolved, IncidentWithdrawn)
  .key(attrs => `${attrs.service}:${attrs.source}`)
  .initial(Open)
  .onAttemptFailed(IncidentUnresolved)
  .onCancelled(IncidentWithdrawn);

const heartbeatCheck = H.command('heartbeat-check')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./scripts/heartbeat.sh', input.service])
  .runner(localRunner)
  .acceptExitCodes(1);

const backupCommand = H.command('backup-database')
  .input(backupSchema)
  .argv(input => ['/opt/ops/backup.sh', input.database])
  .runner(input => hostRunner(input.host));

const certificateCheck = H.command('certificate-check')
  .input(renewalSchema)
  .argv(input => ['/opt/ops/cert-days-left.sh', input.domain])
  .runner(input => hostRunner(input.host))
  .output(z.object({ daysLeft: z.number() }));

const certificateRenew = H.command('certificate-renew')
  .input(renewalSchema)
  .argv(input => ['/opt/ops/cert-renew.sh', input.domain])
  .runner(input => hostRunner(input.host));

const runbook = H.command('incident-runbook')
  .input(incidentSchema)
  .argv(input => ['./runbooks/run.sh', input.service, input.source])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ service: z.string() }))
  .step('check', heartbeatCheck, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('up', ctx => ctx.steps.check.exitCode === 0)
  .exit('down');

const backupFlow = H.flow('backup')
  .input(backupSchema)
  .step('backup', backupCommand, ctx => ctx.unit.attributes)
  .exit('backedUp');

const renewalFlow = H.flow('certificate-renewal')
  .input(renewalSchema)
  .step('inspect', certificateCheck, ctx => ctx.unit.attributes)
  .exit('stillValid', ctx => ctx.steps.inspect.daysLeft >= 14)
  .step('renew', certificateRenew, ctx => ctx.unit.attributes)
  .exit('renewed');

const incidentFlow = H.flow('incident')
  .input(incidentSchema)
  .halt('acknowledge', {
    ask: ctx => `Incident: ${ctx.unit.attributes.title}. Acknowledge to run the runbook.`,
    decision: z.object({ acknowledgedBy: z.string() }),
  })
  .step('runbook', runbook, ctx => ctx.unit.attributes)
  .halt('confirm', {
    ask: ctx => `Runbook finished for ${ctx.unit.attributes.service}:\n${ctx.steps.runbook.stdout}\nIs the incident resolved?`,
    decision: z.object({ resolved: z.boolean(), note: z.string().optional() }),
  })
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(
    H.clock('every-five-minutes').every({ minutes: 5 }),
    (_tick, to) => services.map(service => to.create({ service })),
  )
  .handler(heartbeatFlow, { exits: { up: Up, down: Down }, during: { check: Checking } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0 });

const backups = H.lane('backups', Backup)
  .supply(
    H.clock('nightly').at('01:00', { tz: 'UTC' }),
    (_tick, to) => databases.map(target => to.create(target)),
  )
  .handler(backupFlow, { exits: { backedUp: BackedUp }, during: { backup: BackingUp } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0 });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply(
    H.clock('weekly').at('03:00', { on: 'mon', tz: 'UTC' }),
    (_tick, to) => certificates.map(target => to.create(target)),
  )
  .handler(renewalFlow, {
    exits: { stillValid: StillValid, renewed: Renewed },
    during: { inspect: Inspecting, renew: Renewing },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 3600000 });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(incidentFlow, {
    exits: { resolved: IncidentResolved, unresolved: IncidentUnresolved },
    during: { acknowledge: AwaitingAcknowledgement, runbook: Remediating, confirm: AwaitingConfirmation },
  })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0 });

const operations = H.corpus('operational-experience', H.memory('operational-experience', 'experience'))
  .store(jsonl.memoryStore({ path: './.harness/memory/operations.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const database = H.resource('database');

const heartbeatIncident = H.trigger('three-failed-heartbeats-open-incident')
  .on(H.when.pattern(heartbeats, { to: Down, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidents, event => ({
    service: event.group,
    source: 'heartbeat',
    title: `${event.group} failed ${event.streak} consecutive heartbeats`,
  }));

const backupIncident = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, event => ({
    service: event.unit.attributes.database,
    source: 'backup',
    title: `Backup of ${event.unit.attributes.database} failed`,
  }));

const slowBackupNote = H.trigger('slow-backup-records-experience')
  .on(H.when.transition(backups, {
    to: BackedUp,
    if: event => (event.attempt?.durationMs ?? 0) > twoHoursMs,
  }))
  .record(operations, event => ({
    text: `When planning the nightly backup of ${event.unit.attributes.database}, allow over two hours or split it, because it took ${Math.round((event.attempt?.durationMs ?? 0) / 60000)} minutes on ${event.at.toISOString().slice(0, 10)}`,
    status: 'candidate',
    when: { kinds: [Backup], resources: [database.of(event.unit.attributes.database)] },
  }));

const scheduler = H.scheduler('operations')
  .priority(incidents, heartbeats, renewals, backups)
  .admit(backups, ctx => ctx.count(incidents) === 0);

const controlApi = http.controlApi('ops-control-api', {
  port: H.slot.port(0),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.blockersResolve, H.ops.memoryRead, H.ops.telemetryRead],
});

export const operationsHarness = H.harness('operations')
  .ledger(sqlite.ledger({ path: './.harness/ledger.db' }))
  .lanes(heartbeats, backups, renewals, incidents)
  .corpora(operations)
  .triggers(heartbeatIncident, backupIncident, slowBackupNote)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-slack', { webhookUrl: H.env('SLACK_INCIDENT_WEBHOOK'), lanes: [incidents] }),
    markdown.board({ path: './.harness/board.md' }),
  );
