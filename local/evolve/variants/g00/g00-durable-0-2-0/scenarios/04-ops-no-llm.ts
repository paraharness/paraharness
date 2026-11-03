import { z } from 'zod';
import { H } from 'harness-dsl';
import { http } from 'harness-dsl/http';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { slack } from 'harness-dsl/slack';
import { sqlite } from 'harness-dsl/sqlite';
import { ssh } from 'harness-dsl/ssh';

const heartbeatSchema = z.object({ service: z.string() });
const backupSchema = z.object({ database: z.string(), host: z.string() });
const renewalSchema = z.object({ domain: z.string(), host: z.string() });
const incidentSchema = z.object({ title: z.string(), service: z.string(), source: z.string() });

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Up = H.terminal('Up', 'success');
const Down = H.terminal('Down', 'failure');

const Scheduled = H.state('Scheduled', 'pending');
const BackingUp = H.state('BackingUp', 'active');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');

const CheckDue = H.state('CheckDue', 'pending');
const Inspecting = H.state('Inspecting', 'active');
const Renewing = H.state('Renewing', 'active');
const StillValid = H.terminal('StillValid', 'success');
const Renewed = H.terminal('Renewed', 'success');

const Open = H.state('Open', 'pending');
const Responding = H.state('Responding', 'active');
const Resolved = H.terminal('Resolved', 'success');
const Unresolved = H.terminal('Unresolved', 'failure');

const Heartbeat = H.kind('Heartbeat')
  .attributes(heartbeatSchema)
  .states(Due, Probing, Up, Down)
  .key(attrs => attrs.service)
  .initial(Due);

const Backup = H.kind('Backup')
  .attributes(backupSchema)
  .states(Scheduled, BackingUp, BackedUp, BackupFailed)
  .key(attrs => attrs.database)
  .initial(Scheduled)
  .onAttemptFailed(BackupFailed);

const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(renewalSchema)
  .states(CheckDue, Inspecting, Renewing, StillValid, Renewed)
  .key(attrs => attrs.domain)
  .initial(CheckDue);

const Incident = H.kind('Incident')
  .attributes(incidentSchema)
  .states(Open, Responding, Resolved, Unresolved)
  .key(attrs => `${attrs.source}:${attrs.service}`)
  .initial(Open);

const diskSpace = H.command('disk-space-preflight')
  .argv(['sh', '-c', 'test "$(df --output=pcent /var/backups | tail -1 | tr -dc 0-9)" -lt 85']);

const sshKey = H.env('OPS_SSH_KEY');
const localRunner = local.runner('local').slots(8);
const dbHostOne = ssh.host('db-1', { host: 'db-1.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace);
const dbHostTwo = ssh.host('db-2', { host: 'db-2.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace);
const hostRunner = (host: string) => (host === 'db-1' ? dbHostOne : dbHostTwo);

const probe = H.command('probe-service')
  .input(heartbeatSchema)
  .argv(input => ['./bin/healthcheck', input.service])
  .runner(localRunner)
  .acceptExitCodes(0, 1);

const runBackup = H.command('run-backup')
  .input(backupSchema)
  .argv(input => ['/opt/ops/backup.sh', input.database])
  .runner(input => hostRunner(input.host));

const inspectCertificate = H.command('inspect-certificate')
  .input(renewalSchema)
  .argv(input => ['/opt/ops/cert-days-left.sh', input.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => hostRunner(input.host));

const renewCertificate = H.command('renew-certificate')
  .input(renewalSchema)
  .argv(input => ['/opt/ops/renew-cert.sh', input.domain])
  .runner(input => hostRunner(input.host));

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string(), service: z.string() }))
  .argv(input => ['./bin/page', '--service', input.service, '--title', input.title])
  .runner(localRunner);

const runbook = H.command('incident-runbook')
  .input(z.object({ service: z.string(), responder: z.string() }))
  .argv(input => ['./runbooks/run.sh', input.service, '--responder', input.responder])
  .runner(localRunner)
  .acceptExitCodes(0, 1, 2);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatSchema)
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('up', ctx => ctx.steps.probe.exitCode === 0)
  .exit('down');

const backupFlow = H.flow('backup')
  .input(backupSchema)
  .step('backup', runBackup, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('done');

const renewalFlow = H.flow('certificate-renewal')
  .input(renewalSchema)
  .step('inspect', inspectCertificate, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('valid', ctx => ctx.steps.inspect.daysLeft >= 14)
  .step('renew', renewCertificate, ctx => ctx.unit.attributes)
  .exit('renewed');

const incidentFlow = H.flow('incident')
  .input(incidentSchema)
  .step('page', pageOnCall, ctx => ({ title: ctx.unit.attributes.title, service: ctx.unit.attributes.service }))
  .halt('acknowledge', {
    ask: ctx => `Acknowledge incident "${ctx.unit.attributes.title}" on ${ctx.unit.attributes.service}`,
    decision: z.object({ responder: z.string() }),
  })
  .loop(
    'remediate',
    flow => flow
      .step('runbook', runbook, ctx => ({
        service: ctx.unit.attributes.service,
        responder: ctx.steps.acknowledge.responder,
      }))
      .halt('confirm', {
        ask: ctx => `Runbook for ${ctx.unit.attributes.service} exited ${ctx.steps.runbook.exitCode}:\n${ctx.steps.runbook.stdout}\nIs the incident resolved?`,
        decision: z.object({ resolved: z.boolean(), notes: z.string().optional() }),
      }),
    { max: 3, until: ctx => ctx.steps.confirm.resolved },
  )
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const services = ['api', 'web', 'worker'];
const databases = [
  { database: 'orders', host: 'db-1' },
  { database: 'users', host: 'db-1' },
  { database: 'analytics', host: 'db-2' },
];
const domains = [
  { domain: 'example.com', host: 'db-1' },
  { domain: 'api.example.com', host: 'db-2' },
];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (_tick, to) =>
    services.map(service => to.create({ service })),
  )
  .handler(heartbeatFlow, { exits: { up: Up, down: Down }, during: { probe: Probing } });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly').at('01:00', { tz: 'UTC' }), (_tick, to) =>
    databases.map(target => to.create(target)),
  )
  .handler(backupFlow, { exits: { done: BackedUp }, during: { backup: BackingUp } });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply(H.clock('weekly').at('03:00', { on: 'sun', tz: 'UTC' }), (_tick, to) =>
    domains.map(target => to.create(target)),
  )
  .handler(renewalFlow, {
    exits: { valid: StillValid, renewed: Renewed },
    during: { inspect: Inspecting, renew: Renewing },
  });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .store(sqlite.store({ path: '.harness/incidents.db' }))
  .handler(incidentFlow, {
    exits: { resolved: Resolved, unresolved: Unresolved },
    during: { page: Responding },
  });

const operations = H.journal('operational-experience', H.memory('operational-experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/operations.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const twoHoursMs = 2 * 60 * 60 * 1000;

const heartbeatStreakOpensIncident = H.trigger('heartbeat-streak-opens-incident')
  .on(H.when.pattern(heartbeats, { to: Down, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidents, event => ({
    title: `${event.group} failed ${event.streak} consecutive heartbeats`,
    service: event.group,
    source: 'heartbeat',
  }));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, event => ({
    title: `Backup of ${event.unit.attributes.database} failed`,
    service: event.unit.attributes.database,
    source: 'backup',
  }));

const slowBackupNote = H.trigger('slow-backup-note')
  .on(H.when.transition(backups, {
    to: BackedUp,
    if: event => (event.attempt?.durationMs ?? 0) > twoHoursMs,
  }))
  .record(operations, event => ({
    text: `When scheduling the backup of ${event.unit.attributes.database} on ${event.unit.attributes.host}, check host load first, because it took ${Math.round((event.attempt?.durationMs ?? 0) / 60000)} minutes on ${event.at.toISOString()}`,
    when: { kinds: [Backup], resources: [event.unit.attributes.host] },
  }));

const scheduler = H.scheduler('ops')
  .priority(incidents, heartbeats, renewals, backups)
  .admit(backups, ctx => ctx.active(incidents) === 0);

const controlApi = http.controlApi('ops-control', {
  port: H.slot.port(0),
  token: H.env('OPS_API_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.blockersResolve, H.ops.memoryRead, H.ops.telemetryRead],
});

export const harness = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeats, backups, renewals, incidents)
  .journals(operations)
  .triggers(heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupNote)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-alerts', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    markdown.board({ path: 'BOARD.md' }),
  );

void harness.start();
