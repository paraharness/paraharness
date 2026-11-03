import { H } from 'harness-dsl';
import { z } from 'zod';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const Database = z.enum(['orders', 'billing']);
const Host = z.enum(['alpha', 'beta']);

const databases = {
  orders: H.resource('orders-db'),
  billing: H.resource('billing-db'),
};

const services = ['api', 'web', 'worker'];
const certificates = [
  { domain: 'api.example.com', host: Host.enum.alpha },
  { domain: 'www.example.com', host: Host.enum.beta },
];

const HeartbeatAttributes = z.object({ service: z.string(), dueAt: z.string() });
const BackupAttributes = z.object({ database: Database, night: z.string() });
const RenewalAttributes = z.object({ domain: z.string(), host: Host, week: z.string() });
const IncidentAttributes = z.object({ service: z.string(), summary: z.string(), source: z.string() });

const BeatDue = H.state('BeatDue', 'pending');
const Beating = H.state('Beating', 'active');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const Heartbeat = H.kind('Heartbeat')
  .attributes(HeartbeatAttributes)
  .states(BeatDue, Beating, Healthy, Unhealthy)
  .key(beat => `${beat.service}@${beat.dueAt}`)
  .initial(BeatDue);

const BackupDue = H.state('BackupDue', 'pending');
const BackingUp = H.state('BackingUp', 'active');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');
const BackupSkipped = H.terminal('BackupSkipped', 'neutral');

const Backup = H.kind('Backup')
  .attributes(BackupAttributes)
  .states(BackupDue, BackingUp, BackedUp, BackupFailed, BackupSkipped)
  .key(backup => `${backup.database}@${backup.night}`)
  .initial(BackupDue);

const RenewalDue = H.state('RenewalDue', 'pending');
const Renewing = H.state('Renewing', 'active');
const StillValid = H.terminal('StillValid', 'neutral');
const Renewed = H.terminal('Renewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');
const RenewalSkipped = H.terminal('RenewalSkipped', 'neutral');

const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(RenewalAttributes)
  .states(RenewalDue, Renewing, StillValid, Renewed, RenewalFailed, RenewalSkipped)
  .key(renewal => `${renewal.domain}@${renewal.week}`)
  .initial(RenewalDue);

const IncidentOpen = H.state('IncidentOpen', 'pending');
const AwaitingAck = H.state('AwaitingAck', 'waiting');
const RunningRunbook = H.state('RunningRunbook', 'active');
const AwaitingConfirmation = H.state('AwaitingConfirmation', 'waiting');
const IncidentStalled = H.state('IncidentStalled', 'waiting');
const Resolved = H.terminal('Resolved', 'success');
const Dismissed = H.terminal('Dismissed', 'neutral');

const Incident = H.kind('Incident')
  .attributes(IncidentAttributes)
  .states(IncidentOpen, AwaitingAck, RunningRunbook, AwaitingConfirmation, IncidentStalled, Resolved, Dismissed)
  .key(incident => `${incident.source}:${incident.service}`)
  .initial(IncidentOpen);

const sshKey = H.env('OPS_SSH_KEY');
const diskSpace = H.command('disk-space-preflight').argv(['sh', '-c', 'test "$(df --output=pcent / | tail -1 | tr -dc 0-9)" -lt 85']);

const hosts = {
  alpha: ssh.host('alpha', { host: 'alpha.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace),
  beta: ssh.host('beta', { host: 'beta.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace),
};
const backupHost = { orders: hosts.alpha, billing: hosts.beta };

const localRunner = local.runner('ops-local').slots(8);

const heartbeatProbe = H.command('heartbeat-probe')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./ops/heartbeat.sh', input.service])
  .runner(localRunner);

const backupDatabase = H.command('backup-database')
  .input(z.object({ database: Database }))
  .argv(input => ['./ops/backup.sh', input.database])
  .runner(input => backupHost[input.database]);

const certificateCheck = H.command('certificate-check')
  .input(z.object({ domain: z.string(), host: Host }))
  .argv(input => ['./ops/cert-days-left.sh', input.domain])
  .runner(input => hosts[input.host])
  .output(z.object({ daysLeft: z.number() }));

const certificateRenew = H.command('certificate-renew')
  .input(z.object({ domain: z.string(), host: Host }))
  .argv(input => ['./ops/cert-renew.sh', input.domain])
  .runner(input => hosts[input.host]);

const runbook = H.command('incident-runbook')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./ops/runbook.sh', input.service])
  .runner(localRunner);

const IncidentAcknowledged = H.halt('incident-acknowledged').decision(z.object({ by: z.string() }));
const IncidentResolutionConfirmed = H.halt('incident-resolution-confirmed').decision(
  z.object({ resolved: z.boolean(), note: z.string().optional() }),
);

const heartbeatFlow = H.flow('heartbeat')
  .input(HeartbeatAttributes)
  .step('probe', heartbeatProbe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

const backupFlow = H.flow('backup')
  .input(BackupAttributes)
  .step('backup', backupDatabase, ctx => ({ database: ctx.unit.attributes.database }), { afterCrash: 'rerun' })
  .exit('backedUp');

const renewalFlow = H.flow('certificate-renewal')
  .input(RenewalAttributes)
  .step('check', certificateCheck, ctx => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }))
  .exit('stillValid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', certificateRenew, ctx => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }), {
    retry: { maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600_000 },
  })
  .exit('renewed');

const incidentFlow = H.flow('incident')
  .input(IncidentAttributes)
  .halt('acknowledge', IncidentAcknowledged, {
    ask: ctx => `Incident on ${ctx.unit.attributes.service}: ${ctx.unit.attributes.summary}. Acknowledge to run the runbook.`,
  })
  .step('runbook', runbook, ctx => ({ service: ctx.unit.attributes.service }), { afterCrash: 'park' })
  .halt('confirm', IncidentResolutionConfirmed, {
    ask: ctx => `Runbook finished for ${ctx.unit.attributes.service}:\n${ctx.steps.runbook.stdout}\nIs the incident resolved?`,
  })
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('heartbeat-every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    services.map(service => to.create({ service, dueAt: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy }, during: { probe: Beating } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly-backups').at('01:30', { tz: 'UTC' }), (tick, to) => [
    to.create({ database: 'orders', night: tick.at.toISOString().slice(0, 10) }),
    to.create({ database: 'billing', night: tick.at.toISOString().slice(0, 10) }),
  ])
  .handler(backupFlow, { exits: { backedUp: BackedUp }, during: { backup: BackingUp }, cancelled: BackupSkipped })
  .retry({ maxAttempts: 1, exhausted: BackupFailed });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply(H.clock('weekly-certificate-check').at('04:00', { on: 'mon', tz: 'UTC' }), (tick, to) =>
    certificates.map(certificate =>
      to.create({ domain: certificate.domain, host: certificate.host, week: tick.at.toISOString().slice(0, 10) }),
    ),
  )
  .handler(renewalFlow, {
    exits: { stillValid: StillValid, renewed: Renewed },
    during: { check: Renewing, renew: Renewing },
    cancelled: RenewalSkipped,
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 900_000, exhausted: RenewalFailed });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(incidentFlow, {
    exits: { resolved: Resolved, unresolved: IncidentStalled },
    during: { acknowledge: AwaitingAck, runbook: RunningRunbook, confirm: AwaitingConfirmation },
    cancelled: Dismissed,
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000, exhausted: IncidentStalled });

const operationalNotes = H.journal('operational-notes', H.memory('operational', 'experience')).store(
  jsonl.memoryStore({ path: './memory/operations.jsonl' }),
);

const twoHoursMs = 2 * 60 * 60 * 1000;

const repeatedHeartbeatFailure = H.trigger('three-failed-heartbeats-open-incident')
  .on(H.when.pattern(heartbeats, { to: Unhealthy, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidents, event => ({
    service: event.group,
    summary: `${event.streak} consecutive failed heartbeats`,
    source: 'heartbeat',
  }));

const failedBackup = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, event => ({
    service: databases[event.unit.attributes.database].name,
    summary: `Backup of ${event.unit.attributes.database} for ${event.unit.attributes.night} failed`,
    source: 'backup',
  }));

const slowBackup = H.trigger('slow-backup-notes-experience')
  .on(H.when.transition(backups, { to: BackedUp, if: event => (event.attempt?.durationMs ?? 0) > twoHoursMs }))
  .record(operationalNotes, event => ({
    text: `When scheduling the ${event.unit.attributes.database} backup, leave more than two hours before the next job, because the ${event.unit.attributes.night} backup took ${Math.round((event.attempt?.durationMs ?? 0) / 60_000)} minutes`,
    when: { kinds: [Backup], resources: [databases[event.unit.attributes.database]] },
  }));

const scheduler = H.scheduler('operations')
  .priority(incidents, heartbeats, renewals, backups)
  .admit(backups, ctx => ctx.count(incidents, 'pending', 'active', 'waiting') === 0);

const opsApi = H.client('ops-http', {
  transport: http.transport('ops-control', { port: H.slot.port(1), token: H.env('OPS_CONTROL_TOKEN') }),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.resolve(IncidentAcknowledged, IncidentResolutionConfirmed),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger({ path: './.harness/ops.db' }))
  .lanes(incidents, heartbeats, backups, renewals)
  .journals(operationalNotes)
  .triggers(repeatedHeartbeatFailure, failedBackup, slowBackup)
  .scheduler(scheduler)
  .clients(opsApi)
  .observers(
    slack.notifier('incident-channel', { webhookUrl: H.env('SLACK_INCIDENT_WEBHOOK'), lanes: [incidents] }),
    markdown.board({ path: './BOARD.md' }),
  );
