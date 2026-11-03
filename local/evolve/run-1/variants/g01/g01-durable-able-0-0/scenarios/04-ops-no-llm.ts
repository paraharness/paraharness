import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Up = H.state('Up', 'terminal', 'success');
const Down = H.state('Down', 'terminal', 'failure');

const Scheduled = H.state('Scheduled', 'pending');
const BackingUp = H.state('BackingUp', 'active');
const BackedUp = H.state('BackedUp', 'terminal', 'success');
const BackupFailed = H.state('BackupFailed', 'terminal', 'failure');

const CheckDue = H.state('CheckDue', 'pending');
const Checking = H.state('Checking', 'active');
const Renewing = H.state('Renewing', 'active');
const StillValid = H.state('StillValid', 'terminal', 'success');
const Renewed = H.state('Renewed', 'terminal', 'success');
const RenewalFailed = H.state('RenewalFailed', 'terminal', 'failure');

const Open = H.state('Open', 'pending');
const Paging = H.state('Paging', 'active');
const AwaitingAck = H.state('AwaitingAck', 'waiting');
const RunningRunbook = H.state('RunningRunbook', 'active');
const AwaitingConfirmation = H.state('AwaitingConfirmation', 'waiting');
const Resolved = H.state('Resolved', 'terminal', 'success');

const host = z.enum(['db1', 'db2']);

const Heartbeat = H.kind('Heartbeat')
  .attributes(z.object({ service: z.string(), url: z.string() }))
  .states(Due, Probing, Up, Down)
  .key(attrs => attrs.service);

const Backup = H.kind('Backup')
  .attributes(z.object({ database: z.string(), host, night: z.string() }))
  .states(Scheduled, BackingUp, BackedUp, BackupFailed)
  .key(attrs => `${attrs.database}/${attrs.night}`);

const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(z.object({ domain: z.string(), host }))
  .states(CheckDue, Checking, Renewing, StillValid, Renewed, RenewalFailed)
  .key(attrs => attrs.domain);

const incident = z.object({ title: z.string(), service: z.string(), detail: z.string() });

const Incident = H.kind('Incident')
  .attributes(incident)
  .states(Open, Paging, AwaitingAck, RunningRunbook, AwaitingConfirmation, Resolved)
  .key(attrs => attrs.service);

const sshKey = H.env('OPS_SSH_KEY');

const diskSpacePreflight = H.command('disk-space-preflight')
  .argv(['sh', '-c', 'test "$(df --output=avail -k /var/backups | tail -1)" -gt 52428800']);

const localRunner = local.runner('local');
const hosts = {
  db1: ssh.host('db1', { host: 'db1.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpacePreflight),
  db2: ssh.host('db2', { host: 'db2.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpacePreflight),
};

const probe = H.command('probe-service')
  .input(z.object({ url: z.string() }))
  .argv(input => ['curl', '--fail', '--silent', '--max-time', '10', input.url])
  .runner(localRunner);

const runBackup = H.command('run-backup')
  .input(z.object({ database: z.string(), host }))
  .argv(input => ['/opt/ops/backup.sh', input.database])
  .runner(input => hosts[input.host]);

const checkCertificate = H.command('check-certificate')
  .input(z.object({ domain: z.string(), host }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['/opt/ops/cert-days-left.sh', input.domain])
  .runner(input => hosts[input.host]);

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string(), host }))
  .argv(input => ['/opt/ops/renew-cert.sh', input.domain])
  .runner(input => hosts[input.host]);

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(input => ['/opt/ops/page.sh', input.title])
  .env({ PAGER_TOKEN: H.env('PAGER_TOKEN') })
  .runner(localRunner);

const runRunbook = H.command('run-runbook')
  .input(z.object({ service: z.string() }))
  .argv(input => ['/opt/ops/runbook.sh', input.service])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ url: z.string() }))
  .step('probe', probe, ctx => ({ url: ctx.unit.attributes.url }), { restart: 'rerun' })
  .exit('up');

const backupFlow = H.flow('backup')
  .input(z.object({ database: z.string(), host }))
  .step('backup', runBackup, ctx => ({ database: ctx.unit.attributes.database, host: ctx.unit.attributes.host }), {
    timeoutMs: 6 * 3_600_000,
    restart: 'park',
  })
  .exit('backedUp');

const renewalFlow = H.flow('certificate-renewal')
  .input(z.object({ domain: z.string(), host }))
  .step('check', checkCertificate, ctx => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }), { restart: 'rerun' })
  .exit('stillValid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', renewCertificate, ctx => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }), { restart: 'rerun' })
  .exit('renewed');

const incidentFlow = H.flow('incident-runbook')
  .input(incident)
  .step('page', pageOnCall, ctx => ({ title: ctx.unit.attributes.title }), { restart: 'park' })
  .halt('acknowledge', {
    ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.detail}`,
    decision: z.object({ acknowledgedBy: z.string() }),
  })
  .step('runbook', runRunbook, ctx => ({ service: ctx.unit.attributes.service }), { restart: 'park' })
  .halt('confirm', {
    ask: ctx => `Runbook finished for ${ctx.unit.attributes.service}. Is the incident resolved?`,
    decision: z.object({ resolved: z.boolean(), notes: z.string().optional() }),
  })
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('reopened');

const services = [
  { service: 'api', url: 'https://api.internal/health' },
  { service: 'queue', url: 'https://queue.internal/health' },
];
const databases = [
  { database: 'orders', host: 'db1' as const },
  { database: 'billing', host: 'db2' as const },
];
const domains = [
  { domain: 'example.com', host: 'db1' as const },
  { domain: 'api.example.com', host: 'db2' as const },
];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (_tick, to) =>
    services.map(service => to.create(service)),
  )
  .handler(heartbeatFlow, { exits: { up: Up }, during: { probe: Probing }, failure: Down });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly').daily('01:00', { tz: 'UTC' }), (tick, to) =>
    databases.map(db => to.create({ database: db.database, host: db.host, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/ops.sqlite' }))
  .handler(backupFlow, { exits: { backedUp: BackedUp }, during: { backup: BackingUp }, failure: BackupFailed });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply(H.clock('weekly-certificates').weekly('mon', '03:00', { tz: 'UTC' }), (_tick, to) =>
    domains.map(domain => to.create(domain)),
  )
  .handler(renewalFlow, {
    exits: { stillValid: StillValid, renewed: Renewed },
    during: { check: Checking, renew: Renewing },
    failure: RenewalFailed,
  });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .store(sqlite.store({ path: '.harness/ops.sqlite' }))
  .handler(incidentFlow, {
    exits: { resolved: Resolved, reopened: Open },
    during: { page: Paging, acknowledge: AwaitingAck, runbook: RunningRunbook, confirm: AwaitingConfirmation },
  });

const opsNotes = H.memory('ops-notes').trust('experience');

const opsPlaybook = H.playbook('ops-notes', opsNotes)
  .store(jsonl.memoryStore({ path: '.harness/memory/ops-notes.jsonl' }))
  .recall(H.recall('ops-notes-by-specificity', { by: 'specificity', limit: 20 }));

const twoHoursMs = 2 * 3_600_000;

const repeatedHeartbeatFailure = H.trigger('three-failed-heartbeats')
  .on(H.when.pattern(heartbeats, { to: Down, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidents, event => ({
    title: `${event.group} failed ${event.streak} heartbeats in a row`,
    service: event.group,
    detail: `Last probe of ${event.unit.attributes.url} failed at ${event.at.toISOString()}.`,
  }));

const failedBackup = H.trigger('failed-backup')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, event => ({
    title: `Backup of ${event.unit.attributes.database} failed`,
    service: `backup/${event.unit.attributes.database}`,
    detail: `Night ${event.unit.attributes.night} on ${event.unit.attributes.host}.`,
  }));

const slowBackupNote = H.trigger('slow-backup-note')
  .on(H.when.transition(backups, {
    to: BackedUp,
    if: event => (event.attempt?.durationMs ?? 0) > twoHoursMs,
  }))
  .record(opsPlaybook, event => ({
    body: {
      text: `When scheduling the backup of ${event.unit.attributes.database}, start it earlier or split it, because the ${event.unit.attributes.night} run took ${((event.attempt?.durationMs ?? 0) / 3_600_000).toFixed(1)} hours`,
    },
    when: { kinds: [Backup], resources: [event.unit.attributes.database] },
  }));

const scheduler = H.scheduler('ops')
  .priority(incidents, backups, renewals, heartbeats)
  .admit(backups, ctx => ctx.open(incidents) === 0);

const controlApi = http.controlApi('ops-control-api', {
  port: H.slot.port(0),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(incidents, backups, renewals, heartbeats)
  .playbooks(opsPlaybook)
  .triggers(repeatedHeartbeatFailure, failedBackup, slowBackupNote)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-alerts', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    markdown.board({ path: 'BOARD.md' }),
  );
