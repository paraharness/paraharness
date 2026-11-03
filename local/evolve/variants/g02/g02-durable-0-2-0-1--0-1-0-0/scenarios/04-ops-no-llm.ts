import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';
import { slack } from 'harness-dsl/slack';

const workstation = local.runner('local').slots(8);
const diskSpace = H.command('diskSpace').argv(['sh', '-c', 'test "$(df -Pk / | awk \'NR==2 {print $4}\')" -gt 10485760']);
const db1 = ssh.host('db1', { host: 'db1.internal', user: 'ops', key: H.env('SSH_KEY_DB1') }).slots(1).preflight(diskSpace);
const db2 = ssh.host('db2', { host: 'db2.internal', user: 'ops', key: H.env('SSH_KEY_DB2') }).slots(1).preflight(diskSpace);

const hostName = z.enum(['db1', 'db2']);
const onHost = (host: z.infer<typeof hostName>) => (host === 'db1' ? db1 : db2);

const Scheduled = H.state('Scheduled', 'pending');
const Up = H.terminal('Up', 'success');
const Down = H.terminal('Down', 'failure');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');
const StillValid = H.terminal('StillValid', 'success');
const Renewed = H.terminal('Renewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');
const Reported = H.state('Reported', 'pending');
const Resolved = H.terminal('Resolved', 'success');
const Unresolved = H.terminal('Unresolved', 'failure');

const heartbeatAttrs = z.object({ service: z.string() });
const backupAttrs = z.object({ database: z.string(), host: hostName });
const renewalAttrs = z.object({ domain: z.string(), host: hostName });
const incidentAttrs = z.object({ ref: z.string(), title: z.string(), detail: z.string() });

const Heartbeat = H.kind('Heartbeat').attributes(heartbeatAttrs).states(Scheduled, Up, Down).key(h => h.service).initial(Scheduled);
const Backup = H.kind('Backup')
  .attributes(backupAttrs)
  .states(Scheduled, BackedUp, BackupFailed)
  .key(b => b.database)
  .initial(Scheduled);
const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(renewalAttrs)
  .states(Scheduled, StillValid, Renewed, RenewalFailed)
  .key(c => c.domain)
  .initial(Scheduled);
const Incident = H.kind('Incident')
  .attributes(incidentAttrs)
  .states(Reported, Resolved, Unresolved)
  .key(i => i.ref)
  .initial(Reported);

const acknowledgement = H.halt('acknowledgement').decision(z.object({ responder: z.string() }));
const resolutionConfirmed = H.halt('resolutionConfirmed').decision(z.object({ resolved: z.boolean(), note: z.string() }));

const serviceProbe = H.command('serviceProbe')
  .input(heartbeatAttrs)
  .argv(input => ['./ops/probe.sh', input.service])
  .acceptExitCodes(0, 1)
  .runner(workstation);
const databaseBackup = H.command('databaseBackup')
  .input(backupAttrs)
  .argv(input => ['/opt/ops/backup.sh', input.database])
  .runner(input => onHost(input.host));
const certificateCheck = H.command('certificateCheck')
  .input(renewalAttrs)
  .argv(input => ['/opt/ops/cert-days-left.sh', input.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => onHost(input.host));
const certificateRenew = H.command('certificateRenew')
  .input(renewalAttrs)
  .argv(input => ['/opt/ops/cert-renew.sh', input.domain])
  .runner(input => onHost(input.host));
const pageOnCall = H.command('pageOnCall')
  .input(z.object({ title: z.string() }))
  .argv(input => ['./ops/page.sh', input.title])
  .runner(workstation);
const runbook = H.command('runbook')
  .input(z.object({ ref: z.string() }))
  .argv(input => ['./ops/runbook.sh', input.ref])
  .runner(workstation);

const heartbeat = H.flow('heartbeat')
  .input(heartbeatAttrs)
  .step('probe', serviceProbe, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('up', ctx => ctx.steps.probe.exitCode === 0)
  .exit('down');

const backup = H.flow('backup')
  .input(backupAttrs)
  .step('dump', databaseBackup, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('done');

const renewal = H.flow('renewal')
  .input(renewalAttrs)
  .step('check', certificateCheck, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('fresh', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', certificateRenew, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('renewed');

const incidentResponse = H.flow('incidentResponse')
  .input(incidentAttrs)
  .step('page', pageOnCall, ctx => ({ title: ctx.unit.attributes.title }), { afterCrash: 'rerun' })
  .halt('acknowledge', acknowledgement, { ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.title}` })
  .step('runbook', runbook, ctx => ({ ref: ctx.unit.attributes.ref }), { afterCrash: 'park' })
  .halt('confirm', resolutionConfirmed, {
    ask: ctx => `Runbook finished for ${ctx.unit.attributes.title}:\n${ctx.steps.runbook.stdout}\nIs it resolved?`,
  })
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const services = ['api', 'billing', 'search', 'auth'];
const databases: readonly z.infer<typeof backupAttrs>[] = [
  { database: 'orders', host: 'db1' },
  { database: 'customers', host: 'db1' },
  { database: 'analytics', host: 'db2' },
];
const certificates: readonly z.infer<typeof renewalAttrs>[] = [
  { domain: 'example.com', host: 'db1' },
  { domain: 'api.example.com', host: 'db2' },
];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('everyFiveMinutes').every({ minutes: 5 }), (_tick, to) => services.map(service => to.create({ service })))
  .handler(heartbeat, {
    ends: { up: Up, down: Down },
    retry: { maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: Down },
  });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly').at('01:00', { tz: 'UTC' }), (_tick, to) => databases.map(entry => to.create(entry)))
  .handler(backup, {
    ends: { done: BackedUp },
    retry: { maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: BackupFailed },
  });

const renewals = H.lane('renewals', CertificateRenewal)
  .supply(H.clock('weekly').at('04:00', { on: 'sun', tz: 'UTC' }), (_tick, to) => certificates.map(entry => to.create(entry)))
  .handler(renewal, {
    ends: { fresh: StillValid, renewed: Renewed },
    retry: { maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600000, exhausted: RenewalFailed },
  });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(incidentResponse, {
    ends: { resolved: Resolved, unresolved: Unresolved },
    retry: { maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60000, exhausted: Unresolved },
  });

const operationalExperience = H.journal('operationalExperience', H.memory('operationalExperience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/operations.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const twoHoursMs = 2 * 60 * 60 * 1000;

const heartbeatOutage = H.trigger('heartbeatOutage')
  .on(H.when.pattern(heartbeats, { to: Down, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidents, event => ({
    ref: `heartbeat-${event.group}`,
    title: `${event.group} failed ${event.streak} heartbeats in a row`,
    detail: `Last failure at ${event.at.toISOString()}.`,
  }));

const backupFailure = H.trigger('backupFailure')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, event => ({
    ref: `backup-${event.unit.attributes.database}`,
    title: `Backup of ${event.unit.attributes.database} failed`,
    detail: `Failed on ${event.unit.attributes.host} at ${event.at.toISOString()}.`,
  }));

const slowBackup = H.trigger('slowBackup')
  .on(H.when.transition(backups, { to: BackedUp, if: event => (event.attempt?.durationMs ?? 0) > twoHoursMs }))
  .record(operationalExperience, event => ({
    text: `When scheduling the ${event.unit.attributes.database} backup on ${event.unit.attributes.host}, allow more than two hours, because the run on ${event.at.toISOString()} took ${Math.round((event.attempt?.durationMs ?? 0) / 60000)} minutes.`,
    when: { kinds: [Backup] },
  }));

const scheduler = H.scheduler('operations')
  .priority(incidents, heartbeats, renewals, backups)
  .admit(backups, ctx => ctx.count(incidents, 'pending', 'active', 'waiting') === 0);

const controlApi = http.controlApi('ops-control', {
  port: H.slot.port(0),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.resolve(acknowledgement),
    H.ops.resolve(resolutionConfirmed),
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(incidents, heartbeats, renewals, backups)
  .journals(operationalExperience)
  .triggers(heartbeatOutage, backupFailure, slowBackup)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-channel', { webhookUrl: H.env('SLACK_INCIDENT_WEBHOOK'), lanes: [incidents] }),
    markdown.board({ path: 'BOARD.md' }),
  );

void operations.start();
