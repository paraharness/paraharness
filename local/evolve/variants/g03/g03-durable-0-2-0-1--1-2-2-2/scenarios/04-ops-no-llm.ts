import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const service = H.facet('service', ['api', 'web', 'worker']);
const database = H.facet('database', ['orders', 'analytics']);
const domain = H.facet('domain', ['example.com', 'api.example.com']);

const diskSpace = (host: string) =>
  H.command(`disk-space-${host}`).argv(['sh', '-c', 'test "$(df --output=avail -k / | tail -1)" -gt 20971520']);

const localRunner = local.runner('local');
const dbHost1 = ssh.host('db-1', { host: 'db-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpace('db-1'));
const dbHost2 = ssh.host('db-2', { host: 'db-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpace('db-2'));

const heartbeatAttrs = z.object({ service: service.schema });
const HeartbeatDue = H.state('heartbeat-due', 'pending');
const Healthy = H.terminal('healthy', 'success');
const Unhealthy = H.terminal('unhealthy', 'failure');
const heartbeatKind = H.kind('Heartbeat').attributes(heartbeatAttrs).states(HeartbeatDue, Healthy, Unhealthy).key(a => a.service).initial(HeartbeatDue);

const backupAttrs = z.object({ database: database.schema, night: z.string() });
const BackupScheduled = H.state('backup-scheduled', 'pending');
const BackedUp = H.terminal('backed-up', 'success');
const BackupFailed = H.terminal('backup-failed', 'failure');
const backupKind = H.kind('Backup').attributes(backupAttrs).states(BackupScheduled, BackedUp, BackupFailed).key(a => `${a.database}/${a.night}`).initial(BackupScheduled);

const renewalAttrs = z.object({ domain: domain.schema });
const CheckDue = H.state('check-due', 'pending');
const StillValid = H.terminal('valid', 'success');
const Renewed = H.terminal('renewed', 'success');
const RenewalFailed = H.terminal('renewal-failed', 'failure');
const renewalKind = H.kind('CertificateRenewal').attributes(renewalAttrs).states(CheckDue, StillValid, Renewed, RenewalFailed).key(a => a.domain).initial(CheckDue);

const incidentAttrs = z.object({ title: z.string(), origin: z.string(), detail: z.string() });
const IncidentOpen = H.state('incident-open', 'pending');
const NeedsHands = H.state('needs-hands', 'waiting');
const IncidentResolved = H.terminal('incident-resolved', 'success');
const incidentKind = H.kind('Incident').attributes(incidentAttrs).states(IncidentOpen, NeedsHands, IncidentResolved).key(a => a.origin).initial(IncidentOpen);

const incidentRetry = H.signal('incident-retry');
const acknowledged = H.halt('incident-acknowledged').decision(z.object({ by: z.string() }));
const resolutionConfirmed = H.halt('incident-resolution').decision(z.object({ resolved: z.boolean(), note: z.string() }));

const probeService = H.command('probe-service')
  .input(heartbeatAttrs)
  .argv(i => ['/opt/ops/probe.sh', i.service])
  .acceptExitCodes(0, 1)
  .runner(localRunner);

const runBackup = H.command('backup-database')
  .input(backupAttrs)
  .argv(i => ['/opt/ops/backup.sh', i.database])
  .runner(i => (i.database === 'orders' ? dbHost1 : dbHost2));

const checkCertificate = H.command('check-certificate')
  .input(renewalAttrs)
  .argv(i => ['/opt/ops/cert-days-left.sh', i.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(i => (i.domain === 'example.com' ? dbHost1 : dbHost2));

const renewCertificate = H.command('renew-certificate')
  .input(renewalAttrs)
  .argv(i => ['/opt/ops/renew-cert.sh', i.domain])
  .runner(i => (i.domain === 'example.com' ? dbHost1 : dbHost2));

const pageOnCall = H.command('page-on-call')
  .input(incidentAttrs)
  .argv(i => ['/opt/ops/page.sh', i.title])
  .runner(localRunner);

const runbook = H.command('incident-runbook')
  .input(incidentAttrs)
  .argv(i => ['/opt/ops/runbook.sh', i.origin])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatAttrs)
  .step('probe', probeService, ctx => ctx.unit.attributes)
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const backupFlow = H.flow('backup')
  .input(backupAttrs)
  .step('backup', runBackup, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('backed-up');

const renewalFlow = H.flow('certificate-renewal')
  .input(renewalAttrs)
  .step('check', checkCertificate, ctx => ctx.unit.attributes)
  .exit('valid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', renewCertificate, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('renewed');

const incidentFlow = H.flow('incident-runbook')
  .input(incidentAttrs)
  .step('page', pageOnCall, ctx => ctx.unit.attributes)
  .halt('acknowledge', acknowledged, { ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.title}\n${ctx.unit.attributes.detail}` })
  .step('runbook', runbook, ctx => ctx.unit.attributes, { afterCrash: 'park' })
  .halt('confirm', resolutionConfirmed, {
    ask: ctx => `Is "${ctx.unit.attributes.title}" resolved? Runbook exited ${ctx.steps.runbook.exitCode}.`,
  })
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const heartbeatLane = H.lane('heartbeats', heartbeatKind)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (_tick, to) => service.values.map(s => to.create({ service: s })))
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const backupLane = H.lane('backups', backupKind)
  .supply(H.clock('nightly').at('01:00', { tz: 'UTC' }), (tick, to) =>
    database.values.map(db => to.create({ database: db, night: tick.at.toISOString().slice(0, 10) })))
  .handler(backupFlow, { exits: { 'backed-up': BackedUp } })
  .store(sqlite.store({ path: '.harness/ops.db' }))
  .retry({ maxAttempts: 1, exhausted: BackupFailed });

const renewalLane = H.lane('certificate-renewals', renewalKind)
  .supply(H.clock('weekly').at('03:00', { on: 'mon', tz: 'UTC' }), (_tick, to) => domain.values.map(d => to.create({ domain: d })))
  .handler(renewalFlow, { exits: { valid: StillValid, renewed: Renewed } })
  .store(sqlite.store({ path: '.harness/ops.db' }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600000, exhausted: RenewalFailed });

const incidentLane = H.lane('incidents', incidentKind)
  .supply(H.operator)
  .handler(incidentFlow, { exits: { resolved: IncidentResolved, unresolved: NeedsHands } })
  .store(sqlite.store({ path: '.harness/ops.db' }))
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60000, exhausted: NeedsHands })
  .on(incidentRetry, { enter: IncidentOpen });

const operationalExperience = H.journal('ops-experience', H.memory('operational-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/ops-experience.jsonl' }));

const threeMissedHeartbeats = H.trigger('three-missed-heartbeats-open-incident')
  .on(H.when.pattern(heartbeatLane, { to: Unhealthy, consecutive: 3, per: u => u.attributes.service }))
  .create(incidentLane, e => ({
    title: `${e.group} failed ${e.streak} heartbeats in a row`,
    origin: `heartbeat/${e.group}`,
    detail: `Latest failure at ${e.at.toISOString()}`,
  }));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backupLane, { to: BackupFailed }))
  .create(incidentLane, e => ({
    title: `Backup of ${e.unit.attributes.database} failed`,
    origin: `backup/${e.unit.attributes.database}`,
    detail: `Night ${e.unit.attributes.night}, ${e.unit.failedAttempts} failed attempts`,
  }));

const slowBackupNote = H.trigger('slow-backup-note')
  .on(H.when.transition(backupLane, { to: BackedUp, if: e => (e.attempt?.durationMs ?? 0) > 2 * 3600000 }))
  .record(operationalExperience, e => ({
    text: `When scheduling the ${e.unit.attributes.database} backup, start it earlier or split it, because the run of ${e.unit.attributes.night} took ${Math.round((e.attempt?.durationMs ?? 0) / 60000)} minutes.`,
    when: { kinds: [backupKind] },
    status: 'active',
  }));

const scheduler = H.scheduler('ops')
  .expedite(incidentLane, { holds: [backupLane] })
  .standard(heartbeatLane, backupLane, renewalLane);

const controlApi = http.controlApi('ops-control', {
  port: H.slot.port(0),
  token: H.env('OPS_API_TOKEN'),
  grants: [
    H.ops.workCreate,
    H.ops.workRead,
    H.ops.workSignal,
    H.ops.resolve(acknowledged, resolutionConfirmed),
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export default H.harness('platform-ops')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeatLane, backupLane, renewalLane, incidentLane)
  .journals(operationalExperience)
  .triggers(threeMissedHeartbeats, failedBackupOpensIncident, slowBackupNote)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-channel', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidentLane] }),
    markdown.board({ path: 'BOARD.md' }),
  );
