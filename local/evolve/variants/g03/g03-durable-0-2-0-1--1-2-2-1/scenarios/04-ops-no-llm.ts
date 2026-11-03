import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const service = H.facet('service', ['api', 'web', 'worker', 'queue']);
const database = H.facet('database', ['orders', 'billing']);
const domain = H.facet('domain', ['acme.com', 'api.acme.com']);

const localRunner = local.runner('local').slots(8);
const diskSpace = H.command('disk-space-preflight').argv(['./bin/check-disk', '--min-gb', '50']);
const hostA = ssh.host('ops-host-a', { host: 'db-a.internal', user: 'ops', key: H.env('OPS_SSH_KEY') }).slots(1).preflight(diskSpace);
const hostB = ssh.host('ops-host-b', { host: 'db-b.internal', user: 'ops', key: H.env('OPS_SSH_KEY') }).slots(1).preflight(diskSpace);

const due = H.state('due', 'pending');
const healthy = H.terminal('healthy', 'success');
const down = H.terminal('down', 'failure');
const heartbeatSchema = z.object({ service: service.schema });
const heartbeat = H.kind('Heartbeat').attributes(heartbeatSchema).states(due, healthy, down).initial(due);

const scheduled = H.state('scheduled', 'pending');
const backedUp = H.terminal('backed-up', 'success');
const backupFailed = H.terminal('backup-failed', 'failure');
const backupSchema = z.object({ database: database.schema, night: z.string() });
const backup = H.kind('Backup')
  .attributes(backupSchema)
  .states(scheduled, backedUp, backupFailed)
  .initial(scheduled)
  .key(attrs => `${attrs.database}@${attrs.night}`);

const checkDue = H.state('check-due', 'pending');
const stillValid = H.terminal('still-valid', 'success');
const renewed = H.terminal('renewed', 'success');
const renewalFailed = H.terminal('renewal-failed', 'failure');
const renewalSchema = z.object({ domain: domain.schema });
const renewal = H.kind('CertificateRenewal').attributes(renewalSchema).states(checkDue, stillValid, renewed, renewalFailed).initial(checkDue);

const incidentOpen = H.state('open', 'pending');
const stalled = H.state('stalled', 'waiting');
const closed = H.terminal('closed', 'success');
const incidentSchema = z.object({
  subject: z.string(),
  origin: z.enum(['heartbeat', 'backup', 'operator']),
  detail: z.string(),
});
const incident = H.kind('Incident')
  .attributes(incidentSchema)
  .states(incidentOpen, stalled, closed)
  .initial(incidentOpen)
  .key(attrs => `${attrs.origin}:${attrs.subject}`);

const probe = H.command('probe-service')
  .input(heartbeatSchema)
  .argv(input => ['./bin/probe', input.service])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatSchema)
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }), { afterCrash: 'rerun' })
  .exit('healthy');

const heartbeatLane = H.lane('heartbeats', heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) => service.values.map(name => to.create({ service: name })))
  .handler(heartbeatFlow, { exits: { healthy } })
  .retry({ maxAttempts: 1, exhausted: down });

const dump = H.command('backup-dump')
  .input(z.object({ database: database.schema }))
  .argv(input => ['/opt/ops/backup', input.database])
  .runner(input => input.database === 'orders' ? hostA : hostB);

const backupFlow = H.flow('backup')
  .input(backupSchema)
  .step('dump', dump, ctx => ({ database: ctx.unit.attributes.database }), { afterCrash: 'rerun' })
  .exit('backedUp');

const backupLane = H.lane('backups', backup)
  .supply(H.clock('nightly').at('01:00', { tz: 'UTC' }), (tick, to) => database.values.map(name => to.create({
    database: name,
    night: tick.at.toISOString().slice(0, 10),
  })))
  .handler(backupFlow, { exits: { backedUp } })
  .retry({ maxAttempts: 1, exhausted: backupFailed });

const certificateCheck = H.command('certificate-check')
  .input(renewalSchema)
  .argv(input => ['/opt/ops/cert-days-left', input.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => input.domain === 'acme.com' ? hostA : hostB);

const certificateRenew = H.command('certificate-renew')
  .input(renewalSchema)
  .argv(input => ['/opt/ops/cert-renew', input.domain])
  .runner(input => input.domain === 'acme.com' ? hostA : hostB);

const renewalFlow = H.flow('certificate-renewal')
  .input(renewalSchema)
  .step('check', certificateCheck, ctx => ({ domain: ctx.unit.attributes.domain }), { afterCrash: 'rerun' })
  .exit('stillValid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', certificateRenew, ctx => ({ domain: ctx.unit.attributes.domain }), { afterCrash: 'rerun' })
  .exit('renewed');

const renewalLane = H.lane('certificate-renewals', renewal)
  .supply(H.clock('weekly-certificates').at('03:00', { on: 'mon', tz: 'UTC' }), (tick, to) => domain.values.map(name => to.create({ domain: name })))
  .handler(renewalFlow, { exits: { stillValid, renewed } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 900000, exhausted: renewalFailed });

const acknowledgement = H.halt('incident-acknowledgement').decision(z.object({ responder: z.string() }));
const resolution = H.halt('incident-resolution').decision(z.object({ resolved: z.boolean(), notes: z.string() }));

const page = H.command('page-on-call')
  .input(incidentSchema)
  .argv(input => ['./bin/page', '--subject', input.subject, '--detail', input.detail])
  .runner(localRunner);

const runbook = H.command('incident-runbook')
  .input(incidentSchema)
  .argv(input => ['./runbooks/run', input.origin, input.subject])
  .runner(localRunner);

const incidentFlow = H.flow('incident-runbook')
  .input(incidentSchema)
  .step('page', page, ctx => ctx.unit.attributes, { afterCrash: 'park' })
  .halt('acknowledge', acknowledgement, { ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.subject}` })
  .step('runbook', runbook, ctx => ctx.unit.attributes, { afterCrash: 'park' })
  .halt('confirm', resolution, { ask: ctx => `Is the incident resolved? ${ctx.unit.attributes.subject}` })
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const incidentLane = H.lane('incidents', incident)
  .supply(H.operator)
  .handler(incidentFlow, { exits: { resolved: closed, unresolved: incidentOpen } })
  .store(sqlite.store({ path: '.harness/incidents.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60000, exhausted: stalled });

const repeatedDownOpensIncident = H.trigger('three-down-heartbeats-open-incident')
  .on(H.when.pattern(heartbeatLane, { to: down, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidentLane, event => ({
    subject: `${event.group} down`,
    origin: 'heartbeat',
    detail: `${event.streak} consecutive failed heartbeats, latest at ${event.at.toISOString()}`,
  }));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backupLane, { to: backupFailed }))
  .create(incidentLane, event => ({
    subject: `${event.unit.attributes.database} backup failed`,
    origin: 'backup',
    detail: `Backup for night ${event.unit.attributes.night} failed at ${event.at.toISOString()}`,
  }));

const operations = H.memory('operational-experience', 'experience');
const operationsJournal = H.journal('operational-experience', operations)
  .store(jsonl.memoryStore({ path: 'memory/operations.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const slowBackupNoted = H.trigger('slow-backup-noted')
  .on(H.when.transition(backupLane, {
    to: backedUp,
    if: event => (event.attempt?.durationMs ?? 0) > 2 * 60 * 60 * 1000,
  }))
  .record(operationsJournal, event => ({
    text: `When scheduling the ${event.unit.attributes.database} backup, start it earlier or move it off peak, because it took ${Math.round((event.attempt?.durationMs ?? 0) / 60000)} minutes on ${event.unit.attributes.night}`,
    when: { kinds: [backup] },
  }));

const scheduler = H.scheduler('operations')
  .expedite(incidentLane, { holds: [backupLane] })
  .standard(heartbeatLane, backupLane, renewalLane);

const operatorApi = http.controlApi('operator-api', {
  port: H.slot.port(0),
  token: H.env('OPS_API_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workMove,
    H.ops.resolve(acknowledgement, resolution),
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const operationsHarness = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(heartbeatLane, backupLane, renewalLane, incidentLane)
  .journals(operationsJournal)
  .triggers(repeatedDownOpensIncident, failedBackupOpensIncident, slowBackupNoted)
  .scheduler(scheduler)
  .clients(operatorApi)
  .observers(
    slack.notifier('incident-feed', { webhookUrl: H.env('SLACK_INCIDENT_WEBHOOK'), lanes: [incidentLane] }),
    markdown.board({ path: 'BOARD.md' }),
  );

void operationsHarness.start();
