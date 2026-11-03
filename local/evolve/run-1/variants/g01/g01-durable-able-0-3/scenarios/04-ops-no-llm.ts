import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Probing = H.state('Probing', 'active');
const HeartbeatUp = H.state('HeartbeatUp', 'terminal', 'success');
const HeartbeatDown = H.state('HeartbeatDown', 'terminal', 'failure');

const BackupDue = H.state('BackupDue', 'pending');
const BackingUp = H.state('BackingUp', 'active');
const BackupDone = H.state('BackupDone', 'terminal', 'success');
const BackupFailed = H.state('BackupFailed', 'terminal', 'failure');

const RenewalDue = H.state('RenewalDue', 'pending');
const Inspecting = H.state('Inspecting', 'active');
const Renewing = H.state('Renewing', 'active');
const CertificateFresh = H.state('CertificateFresh', 'terminal', 'success');
const CertificateRenewed = H.state('CertificateRenewed', 'terminal', 'success');
const RenewalFailed = H.state('RenewalFailed', 'terminal', 'failure');

const IncidentOpen = H.state('IncidentOpen', 'pending');
const Paging = H.state('Paging', 'active');
const AwaitingAcknowledgement = H.state('AwaitingAcknowledgement', 'active');
const RunningRunbook = H.state('RunningRunbook', 'active');
const AwaitingResolution = H.state('AwaitingResolution', 'active');
const IncidentResolved = H.state('IncidentResolved', 'terminal', 'success');
const IncidentUnresolved = H.state('IncidentUnresolved', 'terminal', 'failure');

const heartbeatAttrs = z.object({ service: z.string() });
const backupAttrs = z.object({ database: z.string(), host: z.string(), night: z.string() });
const renewalAttrs = z.object({ domain: z.string(), host: z.string(), week: z.string() });
const incidentAttrs = z.object({ ref: z.string(), title: z.string(), detail: z.string() });

const Heartbeat = H.kind('Heartbeat')
  .attributes(heartbeatAttrs)
  .states(HeartbeatDue, Probing, HeartbeatUp, HeartbeatDown)
  .key(a => a.service);
const Backup = H.kind('Backup')
  .attributes(backupAttrs)
  .states(BackupDue, BackingUp, BackupDone, BackupFailed)
  .key(a => `${a.database}:${a.night}`);
const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(renewalAttrs)
  .states(RenewalDue, Inspecting, Renewing, CertificateFresh, CertificateRenewed, RenewalFailed)
  .key(a => `${a.domain}:${a.week}`);
const Incident = H.kind('Incident')
  .attributes(incidentAttrs)
  .states(IncidentOpen, Paging, AwaitingAcknowledgement, RunningRunbook, AwaitingResolution, IncidentResolved, IncidentUnresolved)
  .key(a => a.ref);

const localRunner = local.runner('local');
const sshKey = H.env('OPS_SSH_KEY');
const diskSpace = H.command('diskSpacePreflight').argv(['./bin/check-disk', '--min-free-gb', '50']);
const hostA = ssh.host('db-a', { host: 'db-a.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace);
const hostB = ssh.host('db-b', { host: 'db-b.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace);
const hostFor = (host: string) => host === 'db-a' ? hostA : hostB;

const probe = H.command('heartbeatProbe')
  .input(heartbeatAttrs)
  .argv(i => ['./bin/probe', i.service])
  .runner(localRunner);

const backup = H.command('backup')
  .input(backupAttrs)
  .argv(i => ['/opt/ops/backup.sh', i.database])
  .runner(i => hostFor(i.host));

const inspectCertificate = H.command('inspectCertificate')
  .input(renewalAttrs)
  .argv(i => ['/opt/ops/cert-days-left.sh', i.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(i => hostFor(i.host));

const renewCertificate = H.command('renewCertificate')
  .input(renewalAttrs)
  .argv(i => ['/opt/ops/cert-renew.sh', i.domain])
  .runner(i => hostFor(i.host));

const pageOnCall = H.command('pageOnCall')
  .input(z.object({ title: z.string() }))
  .argv(i => ['./bin/page', i.title])
  .env({ PAGER_TOKEN: H.env('PAGER_TOKEN') })
  .runner(localRunner);

const runbook = H.command('runbook')
  .input(incidentAttrs)
  .argv(i => ['./runbooks/run', i.ref])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatAttrs)
  .step('probe', probe, ctx => ctx.unit.attributes)
  .exit('up');

const backupFlow = H.flow('backup')
  .input(backupAttrs)
  .step('backup', backup, ctx => ctx.unit.attributes)
  .exit('done');

const renewalFlow = H.flow('certificateRenewal')
  .input(renewalAttrs)
  .step('inspect', inspectCertificate, ctx => ctx.unit.attributes)
  .exit('fresh', ctx => ctx.steps.inspect.daysLeft >= 14)
  .step('renew', renewCertificate, ctx => ctx.unit.attributes)
  .exit('renewed');

const incidentFlow = H.flow('incidentRunbook')
  .input(incidentAttrs)
  .step('page', pageOnCall, ctx => ({ title: ctx.unit.attributes.title }))
  .halt('acknowledge', {
    ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.title}\n${ctx.unit.attributes.detail}`,
    decision: z.object({ acknowledgedBy: z.string() }),
  })
  .step('runbook', runbook, ctx => ctx.unit.attributes)
  .halt('confirmResolved', {
    ask: ctx => `Runbook finished for ${ctx.unit.attributes.title}. Is the incident resolved?`,
    decision: z.object({ resolved: z.boolean(), note: z.string().optional() }),
  })
  .exit('resolved', ctx => ctx.steps.confirmResolved.resolved)
  .exit('unresolved');

const services = ['api', 'web', 'queue'];
const databases = [
  { database: 'orders', host: 'db-a' },
  { database: 'billing', host: 'db-a' },
  { database: 'analytics', host: 'db-b' },
];
const certificates = [
  { domain: 'example.com', host: 'db-a' },
  { domain: 'api.example.com', host: 'db-b' },
];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('everyFiveMinutes').every({ minutes: 5 }), (_tick, to) =>
    services.map(service => to.create({ service })))
  .handler(heartbeatFlow, { during: { probe: Probing }, exits: { up: HeartbeatUp }, failure: HeartbeatDown });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly').daily('01:00', { tz: 'UTC' }), (tick, to) =>
    databases.map(db => to.create({ ...db, night: tick.at.toISOString().slice(0, 10) })))
  .handler(backupFlow, { during: { backup: BackingUp }, exits: { done: BackupDone }, failure: BackupFailed });

const renewals = H.lane('certificateRenewals', CertificateRenewal)
  .supply(H.clock('weeklyCertificateCheck').weekly('mon', '06:00', { tz: 'UTC' }), (tick, to) =>
    certificates.map(cert => to.create({ ...cert, week: tick.at.toISOString().slice(0, 10) })))
  .handler(renewalFlow, {
    during: { inspect: Inspecting, renew: Renewing },
    exits: { fresh: CertificateFresh, renewed: CertificateRenewed },
    failure: RenewalFailed,
  });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(incidentFlow, {
    during: { page: Paging, acknowledge: AwaitingAcknowledgement, runbook: RunningRunbook, confirmResolved: AwaitingResolution },
    exits: { resolved: IncidentResolved, unresolved: IncidentUnresolved },
    failure: IncidentOpen,
  });

const OperationalExperience = H.memory('operationalExperience').trust('experience');

const operations = H.journal('operations', OperationalExperience)
  .store(jsonl.memoryStore({ path: '.harness/memory/operations.jsonl' }))
  .recall(H.recall('operationsBySpecificity', { by: 'specificity', limit: 20 }));

const twoHoursMs = 2 * 60 * 60 * 1000;

const heartbeatOutage = H.trigger('heartbeatOutage')
  .on(H.when.pattern(heartbeats, { to: HeartbeatDown, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidents, e => ({
    ref: `heartbeat:${e.group}`,
    title: `${e.group} failed ${e.streak} consecutive heartbeats`,
    detail: `Last failure at ${e.at.toISOString()}`,
  }));

const backupFailure = H.trigger('backupFailure')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, e => ({
    ref: `backup:${e.unit.attributes.database}:${e.unit.attributes.night}`,
    title: `Backup of ${e.unit.attributes.database} failed`,
    detail: `Host ${e.unit.attributes.host}, night ${e.unit.attributes.night}`,
  }));

const slowBackup = H.trigger('slowBackup')
  .on(H.when.transition(backups, { to: BackupDone, if: e => (e.attempt?.durationMs ?? 0) > twoHoursMs }))
  .record(operations, e => ({
    body: {
      text: `When scheduling the ${e.unit.attributes.database} backup, start it earlier or split it, because the backup of ${e.unit.attributes.night} took ${Math.round((e.attempt?.durationMs ?? 0) / 60000)} minutes.`,
    },
    when: { kinds: [Backup], resources: [e.unit.attributes.database, e.unit.attributes.host] },
  }));

const scheduler = H.scheduler('operations')
  .priority(incidents, heartbeats, renewals, backups)
  .admit(backups, ctx => ctx.count(incidents, ['pending', 'active']) === 0);

const controlApi = http.controlApi('operator', {
  port: H.slot.port(1),
  token: H.env('CONTROL_API_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.blockersResolve, H.ops.memoryRead, H.ops.telemetryRead],
});

export const operationsHarness = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(heartbeats, backups, renewals, incidents)
  .journals(operations)
  .triggers(heartbeatOutage, backupFailure, slowBackup)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incidentFeed', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    markdown.board({ path: '.harness/BOARD.md' }),
  );
