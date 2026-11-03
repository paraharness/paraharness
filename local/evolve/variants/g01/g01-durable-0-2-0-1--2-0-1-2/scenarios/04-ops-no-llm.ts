import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { markdown } from 'harness-dsl/markdown';
import { slack } from 'harness-dsl/slack';

const localRunner = local.runner('local').slots(8);

const diskSpace = H.command('disk-space-preflight').argv(['./ops/check-disk.sh', '--min-free-gb', '50']);

const hostA = ssh
  .host('db-host-a', { host: 'db-a.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpace);
const hostB = ssh
  .host('db-host-b', { host: 'db-b.internal', user: 'ops', key: H.env('OPS_SSH_KEY') })
  .slots(1)
  .preflight(diskSpace);

const hostFor = (host: 'a' | 'b') => (host === 'a' ? hostA : hostB);

const Heartbeat = z.object({ service: z.string(), slot: z.string() });
const Backup = z.object({ database: z.string(), host: z.enum(['a', 'b']), night: z.string() });
const Renewal = z.object({ domain: z.string(), host: z.enum(['a', 'b']), week: z.string() });
const Incident = z.object({ ref: z.string(), title: z.string(), detail: z.string() });

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const HeartbeatOk = H.terminal('HeartbeatOk', 'success');
const HeartbeatFailed = H.terminal('HeartbeatFailed', 'failure');

const BackupDue = H.state('BackupDue', 'pending');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');

const RenewalDue = H.state('RenewalDue', 'pending');
const StillValid = H.terminal('StillValid', 'success');
const Renewed = H.terminal('Renewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');

const IncidentOpen = H.state('IncidentOpen', 'pending');
const RunbookStuck = H.state('RunbookStuck', 'waiting');
const IncidentResolved = H.terminal('IncidentResolved', 'success');

const heartbeatKind = H.kind('Heartbeat').attributes(Heartbeat).states(HeartbeatDue, HeartbeatOk, HeartbeatFailed).initial(HeartbeatDue);
const backupKind = H.kind('Backup')
  .attributes(Backup)
  .states(BackupDue, BackedUp, BackupFailed)
  .key(attrs => `${attrs.database}:${attrs.night}`)
  .initial(BackupDue);
const renewalKind = H.kind('CertificateRenewal')
  .attributes(Renewal)
  .states(RenewalDue, StillValid, Renewed, RenewalFailed)
  .key(attrs => `${attrs.domain}:${attrs.week}`)
  .initial(RenewalDue);
const incidentKind = H.kind('Incident')
  .attributes(Incident)
  .states(IncidentOpen, RunbookStuck, IncidentResolved)
  .key(attrs => attrs.ref)
  .initial(IncidentOpen);

const probe = H.command('heartbeat-probe')
  .input(Heartbeat)
  .argv(input => ['./ops/heartbeat.sh', input.service])
  .runner(localRunner);

const backup = H.command('backup')
  .input(Backup)
  .argv(input => ['./ops/backup.sh', input.database])
  .runner(input => hostFor(input.host));

const certificateCheck = H.command('certificate-check')
  .input(Renewal)
  .argv(input => ['./ops/cert-days-left.sh', input.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => hostFor(input.host));

const certificateRenew = H.command('certificate-renew')
  .input(Renewal)
  .argv(input => ['./ops/cert-renew.sh', input.domain])
  .runner(input => hostFor(input.host));

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(input => ['./ops/page.sh', input.title])
  .runner(localRunner);

const runbook = H.command('incident-runbook')
  .input(z.object({ ref: z.string() }))
  .argv(input => ['./ops/runbook.sh', input.ref])
  .runner(localRunner);

const acknowledgement = H.halt('incident-acknowledged').decision(z.object({ responder: z.string() }));
const resolution = H.halt('incident-resolution').decision(z.object({ resolved: z.boolean(), note: z.string() }));

const heartbeatFlow = H.flow('heartbeat')
  .input(Heartbeat)
  .step('probe', probe, ctx => ctx.unit.attributes)
  .exit('ok');

const backupFlow = H.flow('backup')
  .input(Backup)
  .step('backup', backup, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('done');

const renewalFlow = H.flow('certificate-renewal')
  .input(Renewal)
  .step('check', certificateCheck, ctx => ctx.unit.attributes)
  .exit('stillValid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', certificateRenew, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('renewed');

const incidentFlow = H.flow('incident-runbook')
  .input(Incident)
  .step('page', pageOnCall, ctx => ({ title: ctx.unit.attributes.title }))
  .halt('acknowledge', acknowledgement, { ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.title}\n${ctx.unit.attributes.detail}` })
  .step('runbook', runbook, ctx => ({ ref: ctx.unit.attributes.ref }), { afterCrash: 'park' })
  .halt('confirm', resolution, { ask: ctx => `Runbook finished for ${ctx.unit.attributes.title}. Is the incident resolved?` })
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const services = ['api', 'web', 'worker'];
const databases = [
  { database: 'orders', host: 'a' },
  { database: 'billing', host: 'b' },
] satisfies readonly { readonly database: string; readonly host: 'a' | 'b' }[];
const domains = [
  { domain: 'example.com', host: 'a' },
  { domain: 'api.example.com', host: 'b' },
] satisfies readonly { readonly domain: string; readonly host: 'a' | 'b' }[];

const heartbeatLane = H.lane('heartbeats', heartbeatKind)
  .handler(heartbeatFlow, { exits: { ok: HeartbeatOk } })
  .retry({ maxAttempts: 1, exhausted: HeartbeatFailed })
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    services.map(service => to.create({ service, slot: tick.at.toISOString() })),
  );

const backupLane = H.lane('backups', backupKind)
  .handler(backupFlow, { exits: { done: BackedUp } })
  .store(sqlite.store({ path: './state/ops.sqlite' }))
  .retry({ maxAttempts: 1, exhausted: BackupFailed })
  .supply(H.clock('nightly-backup').at('01:00', { tz: 'UTC' }), (tick, to) =>
    databases.map(entry => to.create({ database: entry.database, host: entry.host, night: tick.at.toISOString().slice(0, 10) })),
  );

const renewalLane = H.lane('certificate-renewals', renewalKind)
  .handler(renewalFlow, { exits: { stillValid: StillValid, renewed: Renewed } })
  .store(sqlite.store({ path: './state/ops.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 3_600_000, exhausted: RenewalFailed })
  .supply(H.clock('weekly-certificates').at('03:00', { on: 'sun', tz: 'UTC' }), (tick, to) =>
    domains.map(entry => to.create({ domain: entry.domain, host: entry.host, week: tick.at.toISOString().slice(0, 10) })),
  );

const incidentLane = H.lane('incidents', incidentKind)
  .handler(incidentFlow, { exits: { resolved: IncidentResolved, unresolved: IncidentOpen } })
  .store(sqlite.store({ path: './state/ops.sqlite' }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: RunbookStuck })
  .supply(H.operator);

const heartbeatIncident = H.trigger('three-failed-heartbeats-open-incident')
  .on(H.when.pattern(heartbeatLane, { to: HeartbeatFailed, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidentLane, event => ({
    ref: `heartbeat:${event.group}`,
    title: `Service ${event.group} failed ${event.streak} heartbeats in a row`,
    detail: `Last failure at ${event.at.toISOString()}`,
  }));

const backupIncident = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backupLane, { to: BackupFailed }))
  .create(incidentLane, event => ({
    ref: `backup:${event.unit.attributes.database}:${event.unit.attributes.night}`,
    title: `Backup of ${event.unit.attributes.database} failed`,
    detail: `Night ${event.unit.attributes.night}, host ${event.unit.attributes.host}`,
  }));

const operationalExperience = H.journal('operational-experience', H.memory('operational-experience', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/operations.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const slowBackupNote = H.trigger('slow-backup-note')
  .on(
    H.when.transition(backupLane, {
      to: BackedUp,
      if: event => (event.attempt?.durationMs ?? 0) > 2 * 3_600_000,
    }),
  )
  .record(operationalExperience, event => ({
    text: `When scheduling the ${event.unit.attributes.database} backup, start it earlier or split it, because on ${event.unit.attributes.night} it took ${((event.attempt?.durationMs ?? 0) / 3_600_000).toFixed(1)} hours`,
    when: { kinds: [backupKind] },
  }));

const scheduler = H.scheduler('operations')
  .expedite(incidentLane, { holds: [backupLane] })
  .standard(heartbeatLane, renewalLane, backupLane);

const controlApi = http.controlApi('ops-control', {
  port: H.slot.port(0),
  token: H.env('OPS_API_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.attemptsRecover,
    H.ops.resolve(acknowledgement, resolution),
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export default H.harness('operations')
  .ledger(sqlite.ledger({ path: './state/ledger.sqlite' }))
  .lanes(heartbeatLane, backupLane, renewalLane, incidentLane)
  .journals(operationalExperience)
  .triggers(heartbeatIncident, backupIncident, slowBackupNote)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-feed', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidentLane] }),
    markdown.board({ path: './BOARD.md' }),
  );
