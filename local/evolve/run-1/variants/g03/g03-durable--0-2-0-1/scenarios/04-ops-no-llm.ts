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

const serviceAttrs = z.object({ service: z.string() });
const backupAttrs = z.object({ database: z.string(), host: z.enum(['db-1', 'db-2']) });
const certificateAttrs = z.object({ domain: z.string(), host: z.enum(['db-1', 'db-2']) });
const incidentAttrs = z.object({ source: z.string(), title: z.string(), detail: z.string() });

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Probing = H.state('Probing', 'active');
const Up = H.terminal('Up', 'success');
const Down = H.terminal('Down', 'failure');

const Heartbeat = H.kind('Heartbeat')
  .attributes(serviceAttrs)
  .states(HeartbeatDue, Probing, Up, Down)
  .key((attrs) => attrs.service)
  .initial(HeartbeatDue)
  .onAttemptFailed(Down);

const BackupDue = H.state('BackupDue', 'pending');
const BackingUp = H.state('BackingUp', 'active');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');

const Backup = H.kind('Backup')
  .attributes(backupAttrs)
  .states(BackupDue, BackingUp, BackedUp, BackupFailed)
  .key((attrs) => attrs.database)
  .initial(BackupDue)
  .onAttemptFailed(BackupFailed);

const RenewalDue = H.state('RenewalDue', 'pending');
const CheckingExpiry = H.state('CheckingExpiry', 'active');
const Renewing = H.state('Renewing', 'active');
const StillValid = H.terminal('StillValid', 'success');
const Renewed = H.terminal('Renewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');

const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(certificateAttrs)
  .states(RenewalDue, CheckingExpiry, Renewing, StillValid, Renewed, RenewalFailed)
  .key((attrs) => attrs.domain)
  .initial(RenewalDue)
  .onAttemptFailed(RenewalFailed);

const Reported = H.state('Reported', 'pending');
const Paging = H.state('Paging', 'active');
const AwaitingAcknowledgement = H.state('AwaitingAcknowledgement', 'waiting');
const RunningRunbook = H.state('RunningRunbook', 'active');
const AwaitingResolution = H.state('AwaitingResolution', 'waiting');
const Resolved = H.terminal('Resolved', 'success');
const Unresolved = H.terminal('Unresolved', 'failure');
const Withdrawn = H.terminal('Withdrawn', 'neutral');

const Incident = H.kind('Incident')
  .attributes(incidentAttrs)
  .states(Reported, Paging, AwaitingAcknowledgement, RunningRunbook, AwaitingResolution, Resolved, Unresolved, Withdrawn)
  .key((attrs) => attrs.source)
  .initial(Reported)
  .onAttemptFailed(Unresolved)
  .onCancelled(Withdrawn);

const diskSpacePreflight = H.command('disk-space-preflight').argv(['./ops/check-disk-space.sh', '/var/backups', '20G']);

const localRunner = local.runner('local');
const dbOne = ssh
  .host('db-1', { host: 'db-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpacePreflight);
const dbTwo = ssh
  .host('db-2', { host: 'db-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpacePreflight);

const hostRunner = (host: 'db-1' | 'db-2') => (host === 'db-1' ? dbOne : dbTwo);

const heartbeatProbe = H.command('heartbeat-probe')
  .input(serviceAttrs)
  .argv((input) => ['./ops/probe.sh', input.service])
  .runner(localRunner);

const backupDatabase = H.command('backup-database')
  .input(backupAttrs)
  .argv((input) => ['./ops/backup.sh', input.database])
  .runner((input) => hostRunner(input.host));

const certificateCheck = H.command('certificate-check')
  .input(certificateAttrs)
  .argv((input) => ['./ops/cert-days-left.sh', input.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner((input) => hostRunner(input.host));

const certificateRenew = H.command('certificate-renew')
  .input(certificateAttrs)
  .argv((input) => ['./ops/cert-renew.sh', input.domain])
  .runner((input) => hostRunner(input.host));

const pageOnCall = H.command('page-on-call')
  .input(incidentAttrs)
  .argv((input) => ['./ops/page.sh', input.title, input.detail])
  .runner(localRunner);

const incidentRunbook = H.command('incident-runbook')
  .input(incidentAttrs)
  .argv((input) => ['./ops/runbook.sh', input.source])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(serviceAttrs)
  .step('probe', heartbeatProbe, (ctx) => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('up');

const backupFlow = H.flow('backup')
  .input(backupAttrs)
  .step('backup', backupDatabase, (ctx) => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('backedUp');

const certificateFlow = H.flow('certificate-renewal')
  .input(certificateAttrs)
  .step('check', certificateCheck, (ctx) => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('stillValid', (ctx) => ctx.steps.check.daysLeft >= 14)
  .step('renew', certificateRenew, (ctx) => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('renewed');

const incidentFlow = H.flow('incident-runbook')
  .input(incidentAttrs)
  .step('page', pageOnCall, (ctx) => ctx.unit.attributes, { afterCrash: 'park' })
  .halt('acknowledge', {
    ask: (ctx) => `Acknowledge incident: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.detail}`,
    decision: z.object({ acknowledgedBy: z.string() }),
  })
  .loop(
    'remediation',
    (round) =>
      round
        .step('runbook', incidentRunbook, (ctx) => ctx.unit.attributes, { afterCrash: 'park' })
        .halt('confirm', {
          ask: (ctx) => `Runbook finished for ${ctx.unit.attributes.title}:\n\n${ctx.steps.runbook.stdout}\n\nIs the incident resolved?`,
          decision: z.object({ resolved: z.boolean(), note: z.string() }),
        }),
    { max: 3, until: (ctx) => ctx.steps.confirm.resolved },
  )
  .exit('resolved', (ctx) => ctx.steps.confirm.resolved)
  .exit('unresolved');

const services = ['api', 'web', 'queue'];
const databases: readonly z.infer<typeof backupAttrs>[] = [
  { database: 'orders', host: 'db-1' },
  { database: 'customers', host: 'db-1' },
  { database: 'analytics', host: 'db-2' },
];
const certificates: readonly z.infer<typeof certificateAttrs>[] = [
  { domain: 'api.example.com', host: 'db-1' },
  { domain: 'www.example.com', host: 'db-2' },
];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    services.map((service) => to.create({ service })),
  )
  .handler(heartbeatFlow, { exits: { up: Up }, during: { probe: Probing } });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly').at('01:00', { tz: 'UTC' }), (tick, to) =>
    databases.map((database) => to.create(database)),
  )
  .handler(backupFlow, { exits: { backedUp: BackedUp }, during: { backup: BackingUp } });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply(H.clock('weekly-certificates').at('03:00', { on: 'mon', tz: 'UTC' }), (tick, to) =>
    certificates.map((certificate) => to.create(certificate)),
  )
  .handler(certificateFlow, {
    exits: { stillValid: StillValid, renewed: Renewed },
    during: { check: CheckingExpiry, renew: Renewing },
  });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(incidentFlow, {
    exits: { resolved: Resolved, unresolved: Unresolved },
    during: {
      page: Paging,
      acknowledge: AwaitingAcknowledgement,
      runbook: RunningRunbook,
      confirm: AwaitingResolution,
    },
  });

const operationalExperience = H.journal('operational-experience', H.memory('operational-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/operations.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const threeMissedHeartbeatsOpenIncident = H.trigger('three-missed-heartbeats-open-incident')
  .on(H.when.pattern(heartbeats, { to: Down, consecutive: 3, per: (unit) => unit.attributes.service }))
  .create(incidents, (event) => ({
    source: `heartbeat:${event.group}`,
    title: `${event.group} failed ${event.streak} consecutive heartbeats`,
    detail: `Latest failure at ${event.at.toISOString()}`,
  }));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, (event) => ({
    source: `backup:${event.unit.attributes.database}:${event.at.toISOString().slice(0, 10)}`,
    title: `Backup of ${event.unit.attributes.database} failed`,
    detail: `Backup on ${event.unit.attributes.host} failed at ${event.at.toISOString()}`,
  }));

const slowBackupRecordsNote = H.trigger('slow-backup-records-note')
  .on(H.when.transition(backups, { to: BackedUp, if: (event) => (event.attempt?.durationMs ?? 0) > twoHoursMs }))
  .record(operationalExperience, (event) => ({
    text: `When scheduling the nightly backup of ${event.unit.attributes.database}, allow more than two hours, because the backup on ${event.at.toISOString().slice(0, 10)} took ${Math.round((event.attempt?.durationMs ?? 0) / 60_000)} minutes`,
    when: { kinds: [Backup], resources: [event.unit.attributes.database] },
  }));

const scheduler = H.scheduler('operations')
  .priority(incidents, heartbeats, renewals, backups)
  .admit(backups, (ctx) => ctx.count(incidents, 'pending', 'active', 'waiting') === 0);

const operatorApi = http.controlApi('operator-http', {
  port: H.slot.port(0),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeats, backups, renewals, incidents)
  .journals(operationalExperience)
  .triggers(threeMissedHeartbeatsOpenIncident, failedBackupOpensIncident, slowBackupRecordsNote)
  .scheduler(scheduler)
  .clients(operatorApi)
  .observers(
    slack.notifier('incident-alerts', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    markdown.board({ path: '.harness/BOARD.md' }),
  );

void operations.start();
