import { z } from 'zod';
import { H } from 'harness-dsl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';
import { slack } from 'harness-dsl/slack';

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.state('Healthy', 'succeeded');
const Unhealthy = H.state('Unhealthy', 'failed');
const Running = H.state('Running', 'active');
const BackedUp = H.state('BackedUp', 'succeeded');
const Checking = H.state('Checking', 'active');
const Renewing = H.state('Renewing', 'active');
const StillValid = H.state('StillValid', 'succeeded');
const Renewed = H.state('Renewed', 'succeeded');
const Open = H.state('Open', 'pending');
const Paging = H.state('Paging', 'active');
const AwaitingAck = H.state('AwaitingAck', 'active');
const Mitigating = H.state('Mitigating', 'active');
const AwaitingConfirmation = H.state('AwaitingConfirmation', 'active');
const Resolved = H.state('Resolved', 'succeeded');
const Unresolved = H.state('Unresolved', 'failed');
const Failed = H.state('Failed', 'failed');
const Cancelled = H.state('Cancelled', 'cancelled');

const heartbeatAttrs = z.object({ service: z.string(), dueAt: z.string() });
const backupAttrs = z.object({ database: z.string(), host: z.string(), night: z.string() });
const renewalAttrs = z.object({ domain: z.string(), host: z.string(), week: z.string() });
const incidentAttrs = z.object({ title: z.string(), service: z.string(), detail: z.string() });

const Heartbeat = H.kind('Heartbeat')
  .attributes(heartbeatAttrs)
  .states(Due, Probing, Healthy, Unhealthy, Cancelled)
  .key(a => `${a.service}@${a.dueAt}`);

const Backup = H.kind('Backup')
  .attributes(backupAttrs)
  .states(Due, Running, BackedUp, Failed, Cancelled)
  .key(a => `${a.database}@${a.night}`);

const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(renewalAttrs)
  .states(Due, Checking, Renewing, StillValid, Renewed, Failed, Cancelled)
  .key(a => `${a.domain}@${a.week}`);

const Incident = H.kind('Incident')
  .attributes(incidentAttrs)
  .states(Open, Paging, AwaitingAck, Mitigating, AwaitingConfirmation, Resolved, Unresolved, Cancelled);

const localRunner = local.runner('local').slots(8);

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

const backoff = H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, maxDelayMs: 900000 });

const probe = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./bin/probe', i.service])
  .runner(localRunner);

const backupDatabase = H.command('backup-database')
  .input(z.object({ database: z.string(), host: z.string() }))
  .argv(i => ['/opt/ops/backup', i.database])
  .runner(i => (i.host === 'db-a' ? dbHostA : dbHostB));

const checkCertificate = H.command('check-certificate')
  .input(z.object({ domain: z.string(), host: z.string() }))
  .argv(i => ['/opt/ops/cert-days-left', i.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(i => (i.host === 'db-a' ? dbHostA : dbHostB));

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string(), host: z.string() }))
  .argv(i => ['/opt/ops/cert-renew', i.domain])
  .runner(i => (i.host === 'db-a' ? dbHostA : dbHostB));

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(i => ['./bin/page', i.title])
  .env({ PAGER_TOKEN: H.env('PAGER_TOKEN') })
  .runner(localRunner);

const runbook = H.command('runbook')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./runbooks/mitigate', i.service])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatAttrs)
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }), { timeoutMs: 30000 })
  .exit('healthy');

const backupFlow = H.flow('backup')
  .input(backupAttrs)
  .step('backup', backupDatabase, ctx => ({ database: ctx.unit.attributes.database, host: ctx.unit.attributes.host }), {
    retry: backoff,
    timeoutMs: 6 * 3600000,
  })
  .exit('done');

const renewalFlow = H.flow('certificate-renewal')
  .input(renewalAttrs)
  .step('check', checkCertificate, ctx => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }))
  .exit('stillValid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', renewCertificate, ctx => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }), {
    retry: backoff,
  })
  .exit('renewed');

const incidentFlow = H.flow('incident-runbook')
  .input(incidentAttrs)
  .step('page', pageOnCall, ctx => ({ title: ctx.unit.attributes.title }))
  .halt('acknowledge', {
    ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.title}\n${ctx.unit.attributes.detail}`,
    decision: z.object({ responder: z.string() }),
  })
  .step('runbook', runbook, ctx => ({ service: ctx.unit.attributes.service }))
  .halt('confirmResolved', {
    ask: ctx => `Runbook ran for ${ctx.unit.attributes.service}. Is the incident resolved?`,
    decision: z.object({ resolved: z.boolean(), note: z.string() }),
  })
  .exit('resolved', ctx => ctx.steps.confirmResolved.resolved)
  .exit('unresolved');

const services = ['api', 'web', 'queue'];
const databases = [
  { database: 'orders', host: 'db-a' },
  { database: 'users', host: 'db-b' },
];
const certificates = [
  { domain: 'api.example.com', host: 'db-a' },
  { domain: 'www.example.com', host: 'db-b' },
];

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    services.map(service => to.create({ service, dueAt: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy }, during: { probe: Probing }, failure: Unhealthy });

const backupLane = H.lane('backups', Backup)
  .supply(H.clock('nightly').daily('01:00', { tz: 'UTC' }), (tick, to) =>
    databases.map(db => to.create({ database: db.database, host: db.host, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/ops.db' }))
  .handler(backupFlow, { exits: { done: BackedUp }, during: { backup: Running }, failure: Failed });

const renewalLane = H.lane('certificate-renewals', CertificateRenewal)
  .supply(H.clock('weekly').weekly('mon', '03:00', { tz: 'UTC' }), (tick, to) =>
    certificates.map(cert => to.create({ domain: cert.domain, host: cert.host, week: tick.at.toISOString().slice(0, 10) })),
  )
  .handler(renewalFlow, {
    exits: { stillValid: StillValid, renewed: Renewed },
    during: { check: Checking, renew: Renewing },
    failure: Failed,
  });

const incidentLane = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(incidentFlow, {
    exits: { resolved: Resolved, unresolved: Unresolved },
    during: { page: Paging, acknowledge: AwaitingAck, runbook: Mitigating, confirmResolved: AwaitingConfirmation },
    failure: Unresolved,
  });

const heartbeatStreakOpensIncident = H.trigger('three-failed-heartbeats-open-incident')
  .on(H.when.pattern(heartbeatLane, { to: Unhealthy, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidentLane, e => ({
    title: `${e.group} failed ${e.streak} consecutive heartbeats`,
    service: e.group,
    detail: `Last failure at ${e.at.toISOString()}`,
  }));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backupLane, { to: 'failed' }))
  .create(incidentLane, e => ({
    title: `Backup of ${e.unit.attributes.database} failed`,
    service: e.unit.attributes.database,
    detail: `Host ${e.unit.attributes.host}, night ${e.unit.attributes.night}`,
  }));

const opsExperience = H.memory('ops-experience').trust('experience');

const opsJournal = H.journal('ops-notes', opsExperience).store(jsonl.memoryStore({ path: '.harness/ops-notes.jsonl' }));

const slowBackupNotes = H.trigger('slow-backup-records-note')
  .on(H.when.transition(backupLane, {
    to: BackedUp,
    if: e => e.attempt !== undefined && e.attempt.durationMs > 2 * 3600000,
  }))
  .record(opsJournal, e => ({
    body: {
      text: `When scheduling the ${e.unit.attributes.database} backup on ${e.unit.attributes.host}, allow more than two hours, because the run on ${e.unit.attributes.night} took ${Math.round((e.attempt === undefined ? 0 : e.attempt.durationMs) / 60000)} minutes.`,
    },
    when: { kinds: [Backup], resources: [e.unit.attributes.database, e.unit.attributes.host] },
  }));

const scheduler = H.scheduler('incidents-first')
  .priority(incidentLane, heartbeatLane, renewalLane, backupLane)
  .admit(backupLane, ctx => ctx.active(incidentLane) === 0);

const controlApi = http.controlApi('ops-control-api', {
  port: H.slot.port(0),
  token: H.env('OPS_API_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.blockersResolve, H.ops.memoryRead, H.ops.telemetryRead],
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(incidentLane, heartbeatLane, renewalLane, backupLane)
  .journals(opsJournal)
  .triggers(heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupNotes)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-alerts', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidentLane] }),
    markdown.board({ path: 'BOARD.md' }),
  );

export const running = operations.start();
