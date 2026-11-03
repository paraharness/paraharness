import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const localRunner = local.runner('local');

const diskSpace = H.command('diskSpace').argv(['sh', '-c', 'test "$(df --output=avail /var/backups | tail -1)" -gt 52428800']);

const sshKey = H.env('OPS_SSH_KEY');
const hostA = ssh.host('dbHostA', { host: 'db-a.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace);
const hostB = ssh.host('dbHostB', { host: 'db-b.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace);
const hostFor = (host: string) => (host === 'db-b' ? hostB : hostA);

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Up = H.terminal('Up', 'success');
const Down = H.terminal('Down', 'failure');
const BackingUp = H.state('BackingUp', 'active');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');
const Checking = H.state('Checking', 'active');
const Renewing = H.state('Renewing', 'active');
const Valid = H.terminal('Valid', 'success');
const Renewed = H.terminal('Renewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');
const Open = H.state('Open', 'pending');
const AwaitingAck = H.state('AwaitingAck', 'waiting');
const RunningRunbook = H.state('RunningRunbook', 'active');
const AwaitingResolution = H.state('AwaitingResolution', 'waiting');
const Resolved = H.terminal('Resolved', 'success');

const Heartbeat = H.kind('Heartbeat')
  .attributes(z.object({ service: z.string(), at: z.string() }))
  .states(Due, Probing, Up, Down)
  .key(a => `${a.service}@${a.at}`)
  .initial(Due)
  .onAttemptFailed(Down);

const Backup = H.kind('Backup')
  .attributes(z.object({ database: z.string(), host: z.string(), at: z.string() }))
  .states(Due, BackingUp, BackedUp, BackupFailed)
  .key(a => `${a.database}@${a.at.slice(0, 10)}`)
  .initial(Due)
  .onAttemptFailed(BackupFailed);

const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(z.object({ domain: z.string(), host: z.string(), at: z.string() }))
  .states(Due, Checking, Renewing, Valid, Renewed, RenewalFailed)
  .key(a => `${a.domain}@${a.at.slice(0, 10)}`)
  .initial(Due)
  .onAttemptFailed(RenewalFailed);

const Incident = H.kind('Incident')
  .attributes(z.object({ id: z.string(), title: z.string(), detail: z.string() }))
  .states(Open, AwaitingAck, RunningRunbook, AwaitingResolution, Resolved)
  .key(a => a.id)
  .initial(Open);

const probe = H.command('probe')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./ops/probe.sh', input.service])
  .runner(localRunner);

const backup = H.command('backup')
  .input(z.object({ database: z.string(), host: z.string() }))
  .argv(input => ['/opt/ops/backup.sh', input.database])
  .runner(input => hostFor(input.host));

const certificateCheck = H.command('certificateCheck')
  .input(z.object({ domain: z.string(), host: z.string() }))
  .argv(input => ['/opt/ops/cert-days-left.sh', input.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => hostFor(input.host));

const certificateRenew = H.command('certificateRenew')
  .input(z.object({ domain: z.string(), host: z.string() }))
  .argv(input => ['/opt/ops/cert-renew.sh', input.domain])
  .runner(input => hostFor(input.host));

const runbook = H.command('runbook')
  .input(z.object({ id: z.string() }))
  .argv(input => ['./ops/runbook.sh', input.id])
  .runner(localRunner);

const acknowledged = H.signal('acknowledged').payload(z.object({ responder: z.string() }));
const resolutionConfirmed = H.signal('resolutionConfirmed').payload(z.object({ note: z.string() }));

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ service: z.string() }))
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('up');

const backupFlow = H.flow('backup')
  .input(z.object({ database: z.string(), host: z.string() }))
  .step('dump', backup, ctx => ({ database: ctx.unit.attributes.database, host: ctx.unit.attributes.host }))
  .exit('done');

const renewalFlow = H.flow('renewal')
  .input(z.object({ domain: z.string(), host: z.string() }))
  .step('check', certificateCheck, ctx => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }))
  .exit('valid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', certificateRenew, ctx => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }))
  .exit('renewed');

const incidentFlow = H.flow('incident')
  .input(z.object({ id: z.string(), title: z.string(), detail: z.string() }))
  .await('acknowledge', acknowledged, {
    ask: ctx => `Incident ${ctx.unit.attributes.id}: ${ctx.unit.attributes.title}. ${ctx.unit.attributes.detail}. Acknowledge to run the runbook.`,
  })
  .step('runbook', runbook, ctx => ({ id: ctx.unit.attributes.id }))
  .await('confirmResolution', resolutionConfirmed, {
    ask: ctx => `Runbook finished for ${ctx.unit.attributes.id}:\n${ctx.steps.runbook.stdout}\nConfirm the incident is resolved.`,
  })
  .exit('resolved');

const services = ['api', 'web', 'queue'];
const databases = [
  { database: 'orders', host: 'db-a' },
  { database: 'customers', host: 'db-b' },
];
const certificates = [
  { domain: 'example.com', host: 'db-a' },
  { domain: 'api.example.com', host: 'db-b' },
];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('everyFiveMinutes').every({ minutes: 5 }), (tick, to) =>
    services.map(service => to.create({ service, at: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, { exits: { up: Up }, during: { probe: Probing } });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly').daily('01:00', { tz: 'UTC' }), (tick, to) =>
    databases.map(db => to.create({ database: db.database, host: db.host, at: tick.at.toISOString() })),
  )
  .store(sqlite.store({ path: '.harness/ops.db' }))
  .handler(backupFlow, { exits: { done: BackedUp }, during: { dump: BackingUp } });

const renewals = H.lane('renewals', CertificateRenewal)
  .supply(H.clock('weeklyCertificates').weekly('mon', '03:00', { tz: 'UTC' }), (tick, to) =>
    certificates.map(cert => to.create({ domain: cert.domain, host: cert.host, at: tick.at.toISOString() })),
  )
  .handler(renewalFlow, {
    exits: { valid: Valid, renewed: Renewed },
    during: { check: Checking, renew: Renewing },
  });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .store(sqlite.store({ path: '.harness/incidents.db' }))
  .handler(incidentFlow, {
    exits: { resolved: Resolved },
    during: { acknowledge: AwaitingAck, runbook: RunningRunbook, confirmResolution: AwaitingResolution },
  });

const OperationalExperience = H.memory('OperationalExperience').trust('experience');
const operations = H.journal('operations', OperationalExperience).store(
  jsonl.memoryStore({ path: '.harness/operations.jsonl' }),
);

const heartbeatStreakOpensIncident = H.trigger('heartbeatStreakOpensIncident')
  .on(H.when.pattern(heartbeats, { to: Down, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidents, event => ({
    id: `heartbeat-${event.group}`,
    title: `Service ${event.group} is down`,
    detail: `${event.streak} consecutive heartbeats failed, the last at ${event.unit.attributes.at}`,
  }));

const failedBackupOpensIncident = H.trigger('failedBackupOpensIncident')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, event => ({
    id: `backup-${event.unit.key}`,
    title: `Backup of ${event.unit.attributes.database} failed`,
    detail: `Nightly backup on ${event.unit.attributes.host} at ${event.unit.attributes.at} failed`,
  }));

const twoHoursMs = 2 * 3600000;

const slowBackupNote = H.trigger('slowBackupNote')
  .on(H.when.transition(backups, { to: BackedUp, if: event => (event.attempt?.durationMs ?? 0) > twoHoursMs }))
  .record(operations, event => ({
    body: {
      text: `when scheduling the ${event.unit.attributes.database} backup on ${event.unit.attributes.host}, allow more than two hours, because the run of ${event.unit.attributes.at} took ${Math.round((event.attempt?.durationMs ?? 0) / 60000)} minutes`,
    },
    when: { kinds: [Backup], resources: [event.unit.attributes.database] },
  }));

const scheduler = H.scheduler('opsScheduler')
  .priority(incidents, heartbeats, renewals, backups)
  .admit(backups, ctx => ctx.count(incidents, 'pending', 'active', 'waiting') === 0);

const controlApi = http.controlApi('controlApi', {
  port: H.slot.port(0),
  token: H.env('OPS_API_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.send(acknowledged, { lanes: [incidents] }),
    H.ops.send(resolutionConfirmed, { lanes: [incidents] }),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const operationsHarness = H.harness('operationsHarness')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(incidents, heartbeats, backups, renewals)
  .journals(operations)
  .triggers(heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupNote)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incidentNotifier', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    markdown.board({ path: 'BOARD.md' }),
  );
