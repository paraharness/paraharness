import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const hostSchema = z.enum(['db-1', 'db-2']);
type Host = z.infer<typeof hostSchema>;

const heartbeatItem = z.object({ service: z.string() });
const backupItem = z.object({ database: z.string(), host: hostSchema, night: z.string() });
const renewalItem = z.object({ domain: z.string(), host: hostSchema });
const incidentItem = z.object({ ref: z.string(), title: z.string(), detail: z.string() });

const services = ['api', 'web', 'worker'];
const databases: { readonly database: string; readonly host: Host }[] = [
  { database: 'orders', host: 'db-1' },
  { database: 'accounts', host: 'db-1' },
  { database: 'analytics', host: 'db-2' },
];
const certificates: { readonly domain: string; readonly host: Host }[] = [
  { domain: 'api.example.com', host: 'db-1' },
  { domain: 'www.example.com', host: 'db-2' },
];

const Due = H.state('Due', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');
const Scheduled = H.state('Scheduled', 'pending');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');
const CheckDue = H.state('CheckDue', 'pending');
const StillValid = H.terminal('StillValid', 'success');
const Renewed = H.terminal('Renewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');
const IncidentOpen = H.state('IncidentOpen', 'pending');
const IncidentResolved = H.terminal('IncidentResolved', 'success');
const IncidentAbandoned = H.terminal('IncidentAbandoned', 'failure');

const Heartbeat = H.kind('Heartbeat').attributes(heartbeatItem).states(Due, Healthy, Unhealthy).key(a => a.service);
const Backup = H.kind('Backup').attributes(backupItem).states(Scheduled, BackedUp, BackupFailed).key(a => `${a.database}:${a.night}`);
const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(renewalItem)
  .states(CheckDue, StillValid, Renewed, RenewalFailed)
  .key(a => a.domain);
const Incident = H.kind('Incident')
  .attributes(incidentItem)
  .states(IncidentOpen, IncidentResolved, IncidentAbandoned)
  .key(a => a.ref);

const localRunner = local.runner('local').slots(4);
const sshKey = H.env('OPS_SSH_KEY');
const hosts = {
  'db-1': ssh.host('db-1', { host: 'db-1.internal', user: 'ops', key: sshKey }).slots(1),
  'db-2': ssh.host('db-2', { host: 'db-2.internal', user: 'ops', key: sshKey }).slots(1),
};

const probe = H.command('probe-service')
  .input(heartbeatItem)
  .argv(i => ['./bin/probe', i.service])
  .output(z.object({ healthy: z.boolean() }))
  .runner(localRunner);
const diskSpace = H.command('disk-space-preflight')
  .input(z.object({ host: hostSchema, minFreeGb: z.number() }))
  .argv(i => ['./bin/check-disk', '--min-free-gb', String(i.minFreeGb)])
  .runner(i => hosts[i.host]);
const backupDatabase = H.command('backup-database')
  .input(z.object({ host: hostSchema, database: z.string() }))
  .argv(i => ['./bin/backup', i.database])
  .runner(i => hosts[i.host]);
const checkCertificate = H.command('check-certificate')
  .input(renewalItem)
  .argv(i => ['./bin/cert-days-left', i.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(i => hosts[i.host]);
const renewCertificate = H.command('renew-certificate')
  .input(renewalItem)
  .argv(i => ['./bin/renew-cert', i.domain])
  .runner(i => hosts[i.host]);
const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(i => ['./bin/page', i.title])
  .runner(localRunner);
const pageSecondary = H.command('page-secondary').argv(['./bin/page', '--secondary']).runner(localRunner);
const runRunbook = H.command('run-runbook')
  .input(z.object({ ref: z.string() }))
  .argv(i => ['./bin/runbook', i.ref])
  .runner(localRunner);

const acknowledgement = H.halt('incident-acknowledged').decision(z.object({ acknowledgedBy: z.string() }));
const resolution = H.halt('incident-resolution').decision(z.object({ resolved: z.boolean(), notes: z.string() }));

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatItem)
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy', ctx => ctx.steps.probe.healthy)
  .exit('unhealthy');

const backupFlow = H.flow('backup')
  .input(backupItem)
  .step('preflight', diskSpace, ctx => ({ host: ctx.unit.attributes.host, minFreeGb: 50 }))
  .step('backup', backupDatabase, ctx => ({ host: ctx.unit.attributes.host, database: ctx.unit.attributes.database }), {
    afterCrash: 'rerun',
  })
  .exit('backedUp');

const renewalFlow = H.flow('certificate-renewal')
  .input(renewalItem)
  .step('check', checkCertificate, ctx => ctx.unit.attributes)
  .exit('stillValid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', renewCertificate, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('renewed');

const incidentFlow = H.flow('incident-runbook')
  .input(incidentItem)
  .step('page', pageOnCall, ctx => ({ title: ctx.unit.attributes.title }))
  .halt('acknowledge', acknowledgement, {
    ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.detail}`,
    escalate: { afterMinutes: 15, run: pageSecondary },
  })
  .step('runbook', runRunbook, ctx => ({ ref: ctx.unit.attributes.ref }), { afterCrash: 'park' })
  .halt('confirm', resolution, { ask: ctx => `Is "${ctx.unit.attributes.title}" resolved?` })
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (_tick, to) => services.map(service => to.create({ service })))
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly').at('01:00', { tz: 'UTC' }), (tick, to) =>
    databases.map(d => to.create({ database: d.database, host: d.host, night: tick.at.toISOString().slice(0, 10) })))
  .handler(backupFlow, { exits: { backedUp: BackedUp } })
  .retry({ maxAttempts: 1, exhausted: BackupFailed });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply(H.clock('weekly').at('06:00', { on: 'mon', tz: 'UTC' }), (_tick, to) =>
    certificates.map(c => to.create({ domain: c.domain, host: c.host })))
  .handler(renewalFlow, { exits: { stillValid: StillValid, renewed: Renewed } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600000, exhausted: RenewalFailed });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(incidentFlow, { exits: { resolved: IncidentResolved, unresolved: IncidentOpen } })
  .retry({ maxAttempts: 3, backoff: 'fixed', initialDelayMs: 60000, exhausted: IncidentAbandoned });

const operationalExperience = H.journal('operational-experience', H.memory('operational-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/operations.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const repeatedHeartbeatFailures = H.trigger('three-failed-heartbeats-open-incident')
  .on(H.when.pattern(heartbeats, { to: Unhealthy, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidents, event => ({
    ref: `heartbeat:${event.group}`,
    title: `${event.group} failed ${event.streak} heartbeats in a row`,
    detail: `Latest failure at ${event.at.toISOString()}`,
  }));

const failedBackup = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, event => ({
    ref: `backup:${event.unit.attributes.database}:${event.unit.attributes.night}`,
    title: `Backup of ${event.unit.attributes.database} failed`,
    detail: `Host ${event.unit.attributes.host}, night ${event.unit.attributes.night}`,
  }));

const slowBackup = H.trigger('slow-backup-records-note')
  .on(H.when.transition(backups, { to: BackedUp, if: event => (event.attempt?.durationMs ?? 0) > 7200000 }))
  .record(operationalExperience, event => ({
    text: `When scheduling the backup of ${event.unit.attributes.database} on ${event.unit.attributes.host}, start it earlier or split it, because it took ${((event.attempt?.durationMs ?? 0) / 3600000).toFixed(1)} hours on ${event.unit.attributes.night}`,
    status: 'active',
  }));

const scheduler = H.scheduler('operations')
  .expedite(incidents, { holds: [backups] })
  .standard(heartbeats, renewals, backups);

const controlApi = http.controlApi('ops-control', {
  port: H.slot.port(1),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.resolve(acknowledgement, resolution),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

const harness = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeats, backups, renewals, incidents)
  .journals(operationalExperience)
  .triggers(repeatedHeartbeatFailures, failedBackup, slowBackup)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-transitions', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    markdown.board({ path: 'BOARD.md' }),
  );

void harness.start();
