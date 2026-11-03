import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const Due = H.state('due', 'pending');
const Healthy = H.terminal('healthy', 'success');
const HeartbeatFailed = H.terminal('heartbeat-failed', 'failure');
const BackedUp = H.terminal('backed-up', 'success');
const BackupFailed = H.terminal('backup-failed', 'failure');
const CertificateValid = H.terminal('certificate-valid', 'success');
const Renewed = H.terminal('renewed', 'success');
const RenewalFailed = H.terminal('renewal-failed', 'failure');
const Reported = H.state('reported', 'pending');
const Resolved = H.terminal('resolved', 'success');
const Unresolved = H.terminal('unresolved', 'failure');

const service = H.facet('service', ['api', 'worker', 'web']);
const database = H.facet('database', ['orders', 'users', 'metrics', 'billing']);
const domain = H.facet('domain', ['example.com', 'api.example.com']);
const databases = H.resources('database', database.values);

const heartbeat = z.object({ service: service.schema, tick: z.string() });
const backup = z.object({ database: database.schema, night: z.string() });
const renewal = z.object({ domain: domain.schema, week: z.string() });
const incident = z.object({ ref: z.string(), title: z.string(), detail: z.string() });

const Heartbeat = H.kind('heartbeat').attributes(heartbeat).states(Due, Healthy, HeartbeatFailed).key(a => `${a.service}@${a.tick}`).initial(Due);
const Backup = H.kind('backup').attributes(backup).states(Due, BackedUp, BackupFailed).key(a => `${a.database}@${a.night}`).initial(Due);
const CertificateRenewal = H.kind('certificate-renewal')
  .attributes(renewal)
  .states(Due, CertificateValid, Renewed, RenewalFailed)
  .key(a => `${a.domain}@${a.week}`)
  .initial(Due);
const Incident = H.kind('incident').attributes(incident).states(Reported, Resolved, Unresolved).key(a => a.ref).initial(Reported);

const localRunner = local.runner('local');
const diskSpace = H.command('disk-space-preflight').argv(['check-disk', '--min-free-gb', '50']);
const sshKey = H.env('OPS_SSH_KEY');
const hostA = ssh.host('db-host-a', { host: 'db-a.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace);
const hostB = ssh.host('db-host-b', { host: 'db-b.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace);
const hostOfDatabase = { orders: hostA, users: hostA, metrics: hostB, billing: hostB };
const hostOfDomain = { 'example.com': hostA, 'api.example.com': hostB };

const probeService = H.command('probe-service')
  .input(z.object({ service: service.schema }))
  .argv(input => ['probe', input.service])
  .acceptExitCodes(0, 1)
  .runner(localRunner);

const backupDatabase = H.command('backup-database')
  .input(z.object({ database: database.schema }))
  .argv(input => ['backup', '--database', input.database])
  .runner(input => hostOfDatabase[input.database]);

const checkCertificate = H.command('check-certificate')
  .input(z.object({ domain: domain.schema }))
  .argv(input => ['cert-days-left', input.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => hostOfDomain[input.domain]);

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: domain.schema }))
  .argv(input => ['cert-renew', input.domain])
  .runner(input => hostOfDomain[input.domain]);

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(input => ['page', '--title', input.title])
  .runner(localRunner);

const runRunbook = H.command('run-runbook')
  .input(z.object({ ref: z.string() }))
  .argv(input => ['runbook', input.ref])
  .acceptExitCodes(0, 1)
  .runner(localRunner);

const acknowledgement = H.halt('incident-acknowledgement').decision(z.object({ by: z.string() }));
const resolution = H.halt('incident-resolution').decision(z.object({ resolved: z.boolean(), notes: z.string() }));

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeat)
  .step('probe', probeService, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('failed');

const backupFlow = H.flow('backup')
  .input(backup)
  .step('backup', backupDatabase, ctx => ({ database: ctx.unit.attributes.database }), {
    retry: { maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300_000 },
    afterCrash: 'rerun',
  })
  .exit('backed-up');

const renewalFlow = H.flow('certificate-renewal')
  .input(renewal)
  .step('check', checkCertificate, ctx => ({ domain: ctx.unit.attributes.domain }))
  .exit('valid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', renewCertificate, ctx => ({ domain: ctx.unit.attributes.domain }), { afterCrash: 'rerun' })
  .exit('renewed');

const runbookFlow = H.flow('incident-runbook')
  .input(incident)
  .step('page', pageOnCall, ctx => ({ title: ctx.unit.attributes.title }))
  .halt('acknowledge', acknowledgement, { ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.title}\n${ctx.unit.attributes.detail}` })
  .step('runbook', runRunbook, ctx => ({ ref: ctx.unit.attributes.ref }), { afterCrash: 'park' })
  .halt('confirm', resolution, {
    ask: ctx => `Runbook finished with exit ${ctx.steps.runbook.exitCode}:\n${ctx.steps.runbook.stdout}\nIs the incident resolved?`,
  })
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    service.values.map(name => to.create({ service: name, tick: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy, failed: HeartbeatFailed } })
  .retry({ maxAttempts: 1, exhausted: HeartbeatFailed });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly').at('01:00', { tz: 'UTC' }), (tick, to) =>
    database.values.map(name => to.create({ database: name, night: tick.at.toISOString().slice(0, 10) })),
  )
  .handler(backupFlow, { exits: { 'backed-up': BackedUp } })
  .store(sqlite.store({ path: '.harness/ops.db' }))
  .retry({ maxAttempts: 1, exhausted: BackupFailed });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply(H.clock('weekly').at('04:00', { on: 'sun', tz: 'UTC' }), (tick, to) =>
    domain.values.map(name => to.create({ domain: name, week: tick.at.toISOString().slice(0, 10) })),
  )
  .handler(renewalFlow, { exits: { valid: CertificateValid, renewed: Renewed } })
  .store(sqlite.store({ path: '.harness/ops.db' }))
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 3_600_000, exhausted: RenewalFailed });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(runbookFlow, { exits: { resolved: Resolved, unresolved: Unresolved } })
  .store(sqlite.store({ path: '.harness/ops.db' }))
  .retry({ maxAttempts: 2, exhausted: Unresolved });

const operationalExperience = H.journal('operational-experience', H.memory('operations', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/operations.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const threeFailedHeartbeats = H.trigger('three-failed-heartbeats-open-incident')
  .on(H.when.pattern(heartbeats, { to: HeartbeatFailed, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidents, event => ({
    ref: `heartbeat/${event.group}`,
    title: `${event.group} failed ${event.streak} consecutive heartbeats`,
    detail: `Last failure at ${event.at.toISOString()}.`,
  }));

const failedBackup = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, event => ({
    ref: `backup/${event.unit.attributes.database}/${event.unit.attributes.night}`,
    title: `Backup of ${event.unit.attributes.database} failed`,
    detail: `Nightly backup for ${event.unit.attributes.night} failed.`,
  }));

const slowBackup = H.trigger('slow-backup-records-experience')
  .on(H.when.transition(backups, { to: BackedUp, if: event => (event.attempt?.durationMs ?? 0) > 2 * 3_600_000 }))
  .record(operationalExperience, event => ({
    text: `When backing up ${event.unit.attributes.database}, expect over two hours and keep the host free, because the backup of ${event.unit.attributes.night} took ${Math.round((event.attempt?.durationMs ?? 0) / 60_000)} minutes.`,
    when: { kinds: [Backup], resources: [databases.get(event.unit.attributes.database)] },
  }));

const scheduler = H.scheduler('ops').expedite(incidents, { holds: [backups] }).standard(heartbeats, backups, renewals);

const controlApi = http.controlApi('ops-control', {
  port: H.slot.port(1),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.resolve(acknowledgement, resolution),
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeats, backups, renewals, incidents)
  .journals(operationalExperience)
  .triggers(threeFailedHeartbeats, failedBackup, slowBackup)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-feed', { webhookUrl: H.env('SLACK_INCIDENT_WEBHOOK'), lanes: [incidents] }),
    markdown.board({ path: 'BOARD.md' }),
  );

void operations.start();
