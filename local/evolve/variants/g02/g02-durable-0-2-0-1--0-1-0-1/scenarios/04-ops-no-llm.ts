import { z } from 'zod';
import { H, Resource } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const services = ['api', 'web', 'worker'];
const databases = [
  { name: 'orders', host: 'db-a' },
  { name: 'billing', host: 'db-b' },
];
const certificates = [
  { domain: 'api.example.com', host: 'db-a' },
  { domain: 'www.example.com', host: 'db-b' },
];

const ordersDb = H.resource('orders-db');
const billingDb = H.resource('billing-db');
const databaseResources = (name: string): readonly Resource[] =>
  name === 'orders' ? [ordersDb] : name === 'billing' ? [billingDb] : [];

const Scheduled = H.state('Scheduled', 'pending');
const Running = H.state('Running', 'active');

const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');
const Heartbeat = H.kind('Heartbeat')
  .attributes(z.object({ service: z.string(), dueAt: z.string() }))
  .states(Scheduled, Running, Healthy, Unhealthy)
  .key(a => `${a.service}@${a.dueAt}`);

const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');
const backupSchema = z.object({ database: z.string(), host: z.string(), night: z.string() });
const Backup = H.kind('Backup')
  .attributes(backupSchema)
  .states(Scheduled, Running, BackedUp, BackupFailed)
  .key(a => `${a.database}@${a.night}`);

const CertificateValid = H.terminal('CertificateValid', 'success');
const CertificateRenewed = H.terminal('CertificateRenewed', 'success');
const RenewalFailed = H.terminal('RenewalFailed', 'failure');
const renewalSchema = z.object({ domain: z.string(), host: z.string(), week: z.string() });
const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(renewalSchema)
  .states(Scheduled, Running, CertificateValid, CertificateRenewed, RenewalFailed)
  .key(a => `${a.domain}@${a.week}`);

const IncidentOpen = H.state('IncidentOpen', 'pending');
const IncidentResolved = H.terminal('IncidentResolved', 'success');
const IncidentUnresolved = H.terminal('IncidentUnresolved', 'failure');
const incidentSchema = z.object({ source: z.string(), subject: z.string(), title: z.string(), runbook: z.string() });
const Incident = H.kind('Incident')
  .attributes(incidentSchema)
  .states(IncidentOpen, Running, IncidentResolved, IncidentUnresolved)
  .key(a => `${a.source}:${a.subject}`);

const acknowledgement = H.halt('incident-acknowledgement').decision(z.object({ by: z.string() }));
const resolutionCheck = H.halt('incident-resolution').decision(
  z.object({ resolved: z.boolean(), note: z.string().optional() }),
);

const localRunner = local.runner('local');
const sshKey = H.env('OPS_SSH_KEY');
const hostA = ssh.host('db-a', { host: 'db-a.internal', user: 'ops', key: sshKey }).slots(1);
const hostB = ssh.host('db-b', { host: 'db-b.internal', user: 'ops', key: sshKey }).slots(1);
const hostFor = (host: string) => (host === 'db-a' ? hostA : hostB);

const probe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./scripts/probe', i.service])
  .acceptExitCodes(0, 1)
  .runner(localRunner);

const diskSpace = H.command('disk-space-check')
  .input(z.object({ host: z.string(), database: z.string() }))
  .argv(i => ['./scripts/check-disk', '--min-free-gb', '50', i.database])
  .runner(i => hostFor(i.host));

const runBackup = H.command('backup')
  .input(z.object({ host: z.string(), database: z.string() }))
  .argv(i => ['./scripts/backup', i.database])
  .runner(i => hostFor(i.host));

const certCheck = H.command('certificate-check')
  .input(z.object({ host: z.string(), domain: z.string() }))
  .argv(i => ['./scripts/cert-days-left', i.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(i => hostFor(i.host));

const certRenew = H.command('certificate-renew')
  .input(z.object({ host: z.string(), domain: z.string() }))
  .argv(i => ['./scripts/cert-renew', i.domain])
  .runner(i => hostFor(i.host));

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(i => ['./scripts/page', i.title])
  .runner(localRunner);

const runbook = H.command('runbook')
  .input(z.object({ runbook: z.string(), subject: z.string() }))
  .argv(i => ['./runbooks/run', i.runbook, i.subject])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ service: z.string() }))
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const backupFlow = H.flow('backup')
  .input(backupSchema)
  .step('preflight', diskSpace, ctx => ({ host: ctx.unit.attributes.host, database: ctx.unit.attributes.database }))
  .step(
    'backup',
    runBackup,
    ctx => ({ host: ctx.unit.attributes.host, database: ctx.unit.attributes.database }),
    { afterCrash: 'rerun' },
  )
  .exit('done');

const renewalFlow = H.flow('certificate-renewal')
  .input(renewalSchema)
  .step('check', certCheck, ctx => ({ host: ctx.unit.attributes.host, domain: ctx.unit.attributes.domain }))
  .exit('fresh', ctx => ctx.steps.check.daysLeft >= 14)
  .step(
    'renew',
    certRenew,
    ctx => ({ host: ctx.unit.attributes.host, domain: ctx.unit.attributes.domain }),
    { afterCrash: 'rerun' },
  )
  .exit('renewed');

const incidentFlow = H.flow('incident-runbook')
  .input(incidentSchema)
  .step('page', pageOnCall, ctx => ({ title: ctx.unit.attributes.title }))
  .halt('acknowledge', acknowledgement, { ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.title}` })
  .loop(
    'remediation',
    f =>
      f
        .step(
          'runbook',
          runbook,
          ctx => ({ runbook: ctx.unit.attributes.runbook, subject: ctx.unit.attributes.subject }),
          { afterCrash: 'park' },
        )
        .halt('confirm', resolutionCheck, {
          ask: ctx => `Runbook ${ctx.unit.attributes.runbook} finished. Is "${ctx.unit.attributes.title}" resolved?`,
        }),
    { max: 3, until: ctx => ctx.steps.confirm.resolved },
  )
  .exit('unresolved', ctx => !ctx.steps.confirm.resolved)
  .exit('resolved');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('heartbeat-clock').every({ minutes: 5 }), (tick, to) =>
    services.map(service => to.create({ service, dueAt: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy }, during: { probe: Running } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: Unhealthy });

const opsStore = sqlite.store({ path: '.harness/store.sqlite' });

const backups = H.lane('backups', Backup)
  .supply(H.clock('nightly-backup').at('01:00', { tz: 'UTC' }), (tick, to) =>
    databases.map(db => to.create({ database: db.name, host: db.host, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(opsStore)
  .handler(backupFlow, { exits: { done: BackedUp }, during: { preflight: Running, backup: Running } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: BackupFailed });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply(H.clock('weekly-cert-check').at('04:00', { on: 'mon', tz: 'UTC' }), (tick, to) =>
    certificates.map(c => to.create({ domain: c.domain, host: c.host, week: tick.at.toISOString().slice(0, 10) })),
  )
  .store(opsStore)
  .handler(renewalFlow, {
    exits: { fresh: CertificateValid, renewed: CertificateRenewed },
    during: { check: Running, renew: Running },
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300_000, exhausted: RenewalFailed });

const incidents = H.lane('incidents', Incident)
  .supply(H.operator)
  .store(opsStore)
  .handler(incidentFlow, {
    exits: { resolved: IncidentResolved, unresolved: IncidentUnresolved },
    during: { page: Running, runbook: Running },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60_000, exhausted: IncidentUnresolved });

const operationalExperience = H.journal('operational-experience', H.memory('operational-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/operations.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const heartbeatStreak = H.trigger('three-failed-heartbeats')
  .on(
    H.when.pattern(heartbeats, {
      to: Unhealthy,
      consecutive: 3,
      per: u => u.attributes.service,
    }),
  )
  .create(incidents, e => ({
    source: 'heartbeat',
    subject: e.group,
    title: `${e.group} failed ${e.streak} consecutive heartbeats`,
    runbook: 'restart-service',
  }));

const backupFailure = H.trigger('backup-failure')
  .on(H.when.transition(backups, BackupFailed))
  .create(incidents, e => ({
    source: 'backup',
    subject: e.unit.attributes.database,
    title: `Backup of ${e.unit.attributes.database} failed on ${e.unit.attributes.night}`,
    runbook: 'investigate-backup',
  }));

const slowBackup = H.trigger('slow-backup')
  .on(H.when.transition(backups, BackedUp))
  .record(operationalExperience, e =>
    e.attempt !== undefined && e.attempt.durationMs > 2 * 3_600_000
      ? {
          text: `When scheduling the ${e.unit.attributes.database} backup, start it earlier and check table growth, because the backup on ${e.unit.attributes.night} took ${(e.attempt.durationMs / 3_600_000).toFixed(1)} hours.`,
          status: 'active',
          when: { kinds: [Backup], resources: databaseResources(e.unit.attributes.database) },
        }
      : undefined,
  );

const scheduler = H.scheduler('operations')
  .priority(incidents, heartbeats, renewals, backups)
  .admit(backups, ctx => ctx.count(incidents, 'pending', 'active', 'waiting') === 0);

const controlApi = http.controlApi('ops-control', {
  port: H.slot.port(1),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.resolve(acknowledgement),
    H.ops.resolve(resolutionCheck),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(incidents, heartbeats, renewals, backups)
  .journals(operationalExperience)
  .triggers(heartbeatStreak, backupFailure, slowBackup)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-notifier', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    markdown.board({ path: 'BOARD.md' }),
  );
