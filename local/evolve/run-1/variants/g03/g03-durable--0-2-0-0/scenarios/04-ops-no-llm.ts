import { H } from 'harness-dsl';
import { z } from 'zod';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Up = H.terminal('Up', 'success');
const Down = H.terminal('Down', 'failure');

const Scheduled = H.state('Scheduled', 'pending');
const BackingUp = H.state('BackingUp', 'active');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');

const CheckingCertificate = H.state('CheckingCertificate', 'active');
const Renewing = H.state('Renewing', 'active');
const StillValid = H.terminal('StillValid', 'success');
const Renewed = H.terminal('Renewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');

const Open = H.state('Open', 'pending');
const Paging = H.state('Paging', 'active');
const AwaitingAcknowledgement = H.state('AwaitingAcknowledgement', 'waiting');
const RunningRunbook = H.state('RunningRunbook', 'active');
const AwaitingConfirmation = H.state('AwaitingConfirmation', 'waiting');
const IncidentResolved = H.terminal('IncidentResolved', 'success');
const IncidentUnresolved = H.terminal('IncidentUnresolved', 'failure');

const heartbeatSchema = z.object({ service: z.string(), at: z.string() });
const backupSchema = z.object({ database: z.string(), host: z.enum(['a', 'b']), night: z.string() });
const renewalSchema = z.object({ domain: z.string(), host: z.enum(['a', 'b']), week: z.string() });
const incidentSchema = z.object({ title: z.string(), source: z.string(), detail: z.string() });

const Heartbeat = H.kind('Heartbeat')
  .attributes(heartbeatSchema)
  .states(Due, Probing, Up, Down)
  .key(a => `${a.service}@${a.at}`)
  .initial(Due)
  .onAttemptFailed(Down);

const Backup = H.kind('Backup')
  .attributes(backupSchema)
  .states(Scheduled, BackingUp, BackedUp, BackupFailed)
  .key(a => `${a.database}@${a.night}`)
  .initial(Scheduled)
  .onAttemptFailed(BackupFailed);

const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(renewalSchema)
  .states(Scheduled, CheckingCertificate, Renewing, StillValid, Renewed, RenewalFailed)
  .key(a => `${a.domain}@${a.week}`)
  .initial(Scheduled)
  .onAttemptFailed(RenewalFailed);

const Incident = H.kind('Incident')
  .attributes(incidentSchema)
  .states(Open, Paging, AwaitingAcknowledgement, RunningRunbook, AwaitingConfirmation, IncidentResolved, IncidentUnresolved)
  .key(a => a.title)
  .initial(Open)
  .onAttemptFailed(IncidentUnresolved);

const localRunner = local.runner('local');

const diskSpace = H.command('diskSpacePreflight')
  .argv(['sh', '-c', 'test "$(df --output=avail -BG /var/backups | tail -1 | tr -dc 0-9)" -ge 50']);

const hostA = ssh.host('hostA', { host: 'db-a.internal', user: 'ops', key: H.env('SSH_KEY_A') })
  .slots(1)
  .preflight(diskSpace);

const hostB = ssh.host('hostB', { host: 'db-b.internal', user: 'ops', key: H.env('SSH_KEY_B') })
  .slots(1)
  .preflight(diskSpace);

const probe = H.command('heartbeatProbe')
  .input(z.object({ service: z.string() }))
  .argv(i => ['curl', '-fsS', '--max-time', '10', `https://${i.service}.internal/health`])
  .runner(localRunner);

const backup = H.command('backupDatabase')
  .input(z.object({ database: z.string(), host: z.enum(['a', 'b']) }))
  .argv(i => ['backup-db', i.database])
  .runner(i => i.host === 'a' ? hostA : hostB);

const checkCertificate = H.command('checkCertificate')
  .input(z.object({ domain: z.string(), host: z.enum(['a', 'b']) }))
  .argv(i => ['cert-days-left', '--json', i.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(i => i.host === 'a' ? hostA : hostB);

const renewCertificate = H.command('renewCertificate')
  .input(z.object({ domain: z.string(), host: z.enum(['a', 'b']) }))
  .argv(i => ['renew-cert', i.domain])
  .runner(i => i.host === 'a' ? hostA : hostB);

const pageOnCall = H.command('pageOnCall')
  .input(z.object({ title: z.string() }))
  .argv(i => ['page-oncall', '--summary', i.title])
  .runner(localRunner);

const runbook = H.command('runbook')
  .input(z.object({ source: z.string(), detail: z.string() }))
  .argv(i => ['run-runbook', i.source, i.detail])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatSchema)
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('up');

const backupFlow = H.flow('backup')
  .input(backupSchema)
  .step('backup', backup, ctx => ({ database: ctx.unit.attributes.database, host: ctx.unit.attributes.host }))
  .exit('done');

const renewalFlow = H.flow('certificateRenewal')
  .input(renewalSchema)
  .step('check', checkCertificate, ctx => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }))
  .exit('stillValid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', renewCertificate, ctx => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }))
  .exit('renewed');

const incidentFlow = H.flow('incidentRunbook')
  .input(incidentSchema)
  .step('page', pageOnCall, ctx => ({ title: ctx.unit.attributes.title }))
  .halt('acknowledge', {
    ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.title}\n${ctx.unit.attributes.detail}`,
    decision: z.object({ by: z.string() }),
  })
  .loop(
    'remediate',
    f => f
      .step('runbook', runbook, ctx => ({ source: ctx.unit.attributes.source, detail: ctx.unit.attributes.detail }))
      .halt('confirm', {
        ask: ctx => `Runbook finished for "${ctx.unit.attributes.title}". Is the incident resolved?`,
        decision: z.object({ resolved: z.boolean(), note: z.string() }),
      }),
    { max: 3, until: ctx => ctx.steps.confirm.resolved },
  )
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const services = ['api', 'web', 'queue'];
const databases = [
  { database: 'orders', host: 'a' as const },
  { database: 'customers', host: 'b' as const },
];
const domains = [
  { domain: 'example.com', host: 'a' as const },
  { domain: 'api.example.com', host: 'b' as const },
];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(
    H.clock('everyFiveMinutes').every({ minutes: 5 }),
    (tick, to) => services.map(service => to.create({ service, at: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, { exits: { up: Up }, during: { probe: Probing } });

const backups = H.lane('backups', Backup)
  .supply(
    H.clock('nightly').at('01:00', { tz: 'UTC' }),
    (tick, to) => databases.map(d => to.create({ database: d.database, host: d.host, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/store.db' }))
  .handler(backupFlow, { exits: { done: BackedUp }, during: { backup: BackingUp } });

const renewals = H.lane('renewals', CertificateRenewal)
  .supply(
    H.clock('weekly').at('04:00', { on: 'mon', tz: 'UTC' }),
    (tick, to) => domains.map(d => to.create({ domain: d.domain, host: d.host, week: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/store.db' }))
  .handler(renewalFlow, {
    exits: { stillValid: StillValid, renewed: Renewed },
    during: { check: CheckingCertificate, renew: Renewing },
  });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .store(sqlite.store({ path: '.harness/store.db' }))
  .handler(incidentFlow, {
    exits: { resolved: IncidentResolved, unresolved: IncidentUnresolved },
    during: {
      page: Paging,
      acknowledge: AwaitingAcknowledgement,
      runbook: RunningRunbook,
      confirm: AwaitingConfirmation,
    },
  });

const operationalExperience = H.journal('operationalExperience', H.memory('operationalExperience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/operations.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const repeatedHeartbeatFailure = H.trigger('repeatedHeartbeatFailure')
  .on(H.when.pattern(heartbeats, { to: Down, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidents, e => ({
    title: `Service ${e.group} failed ${e.streak} consecutive heartbeats`,
    source: 'heartbeat',
    detail: `Last failure at ${e.unit.attributes.at}`,
  }));

const failedBackup = H.trigger('failedBackup')
  .on(H.when.transition(backups, { to: BackupFailed }))
  .create(incidents, e => ({
    title: `Backup of ${e.unit.attributes.database} failed on ${e.unit.attributes.night}`,
    source: 'backup',
    detail: e.unit.attributes.database,
  }));

const slowBackupNote = H.trigger('slowBackupNote')
  .on(H.when.transition(backups, {
    to: BackedUp,
    if: e => e.attempt !== undefined && e.attempt.durationMs > 2 * 3600000,
  }))
  .record(operationalExperience, e => e.attempt === undefined ? undefined : {
    text: `When scheduling the ${e.unit.attributes.database} backup, allow more than two hours, because the run on ${e.unit.attributes.night} took ${Math.round(e.attempt.durationMs / 60000)} minutes.`,
    when: { kinds: [Backup], resources: [e.unit.attributes.database] },
    status: 'active',
  });

const scheduler = H.scheduler('operations')
  .priority(incidents, heartbeats, renewals, backups)
  .admit(backups, ctx => ctx.count(incidents) === 0);

const controlApi = http.controlApi('opsControl', {
  port: H.slot.port(0),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeats, backups, renewals, incidents)
  .journals(operationalExperience)
  .triggers(repeatedHeartbeatFailure, failedBackup, slowBackupNote)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incidentNotifier', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    markdown.board({ path: '.harness/board.md' }),
  );

void operations.start();
