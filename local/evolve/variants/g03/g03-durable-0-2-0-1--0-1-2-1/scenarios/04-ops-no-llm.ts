import { z } from 'zod';
import { H, Runner } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const serviceSchema = z.enum(['api', 'web', 'worker']);
const databaseSchema = z.enum(['orders', 'users', 'analytics', 'billing']);
const domainSchema = z.enum(['example.com', 'api.example.com']);
type Database = z.infer<typeof databaseSchema>;
type Domain = z.infer<typeof domainSchema>;

const services = H.facet('service', serviceSchema.options);
const databases = H.resources('database', databaseSchema.options);

const heartbeatItem = z.object({ service: serviceSchema });
const backupItem = z.object({ database: databaseSchema, night: z.string() });
const certItem = z.object({ domain: domainSchema });
const incidentItem = z.object({
  ref: z.string(),
  title: z.string(),
  detail: z.string(),
  runbook: z.enum(['restart-service', 'investigate-backup', 'generic']),
});

const BeatDue = H.state('BeatDue', 'pending');
const Up = H.terminal('Up', 'success');
const Down = H.terminal('Down', 'failure');
const BackupDue = H.state('BackupDue', 'pending');
const BackedUp = H.terminal('BackedUp', 'success');
const BackupFailed = H.terminal('BackupFailed', 'failure');
const CertDue = H.state('CertDue', 'pending');
const CertFresh = H.terminal('CertFresh', 'success');
const CertRenewed = H.terminal('CertRenewed', 'success');
const CertRenewalFailed = H.terminal('CertRenewalFailed', 'failure');
const IncidentOpen = H.state('IncidentOpen', 'pending');
const IncidentResolved = H.terminal('IncidentResolved', 'success');
const IncidentUnresolved = H.terminal('IncidentUnresolved', 'failure');

const Heartbeat = H.kind('Heartbeat').attributes(heartbeatItem).states(BeatDue, Up, Down).key(a => a.service).initial(BeatDue);
const Backup = H.kind('Backup')
  .attributes(backupItem)
  .states(BackupDue, BackedUp, BackupFailed)
  .key(a => `${a.database}@${a.night}`)
  .initial(BackupDue);
const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(certItem)
  .states(CertDue, CertFresh, CertRenewed, CertRenewalFailed)
  .key(a => a.domain)
  .initial(CertDue);
const Incident = H.kind('Incident')
  .attributes(incidentItem)
  .states(IncidentOpen, IncidentResolved, IncidentUnresolved)
  .key(a => a.ref)
  .initial(IncidentOpen);

const localRunner = local.runner('local').slots(8);
const diskSpace = H.command('disk-space-preflight').argv(['./scripts/check-disk.sh', '--min-free-gb', '50']);
const hostA = ssh
  .host('ops-host-a', { host: 'ops-a.internal', user: 'ops', key: H.env('SSH_KEY_OPS_A') })
  .slots(1)
  .preflight(diskSpace);
const hostB = ssh
  .host('ops-host-b', { host: 'ops-b.internal', user: 'ops', key: H.env('SSH_KEY_OPS_B') })
  .slots(1)
  .preflight(diskSpace);

const hostForDatabase = (database: Database): Runner => (database === 'orders' || database === 'users' ? hostA : hostB);
const hostForDomain = (domain: Domain): Runner => (domain === 'example.com' ? hostA : hostB);

const probe = H.command('heartbeat-probe')
  .input(heartbeatItem)
  .argv(i => ['./scripts/heartbeat.sh', i.service])
  .runner(localRunner)
  .acceptExitCodes(0, 1);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatItem)
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }), { afterCrash: 'rerun' })
  .exit('up', ctx => ctx.steps.probe.exitCode === 0)
  .exit('down');

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (_tick, to) =>
    serviceSchema.options.map(service => to.create({ service })),
  )
  .handler(heartbeatFlow, { exits: { up: Up, down: Down } })
  .retry({ maxAttempts: 1, exhausted: Down });

const backupCommand = H.command('backup')
  .input(z.object({ database: databaseSchema }))
  .argv(i => ['./scripts/backup.sh', i.database])
  .runner(i => hostForDatabase(i.database));

const backupFlow = H.flow('backup')
  .input(backupItem)
  .step('dump', backupCommand, ctx => ({ database: ctx.unit.attributes.database }), { afterCrash: 'rerun' })
  .exit('done');

const opsStore = sqlite.store({ path: './.harness/ops.sqlite' });

const backupLane = H.lane('backups', Backup)
  .supply(H.clock('nightly-backup').at('01:00', { tz: 'UTC' }), (tick, to) =>
    databaseSchema.options.map(database => to.create({ database, night: tick.at.toISOString().slice(0, 10) })),
  )
  .handler(backupFlow, { exits: { done: BackedUp } })
  .store(opsStore)
  .retry({ maxAttempts: 1, exhausted: BackupFailed })
  .lease(u => ({ resource: databases.of(u.attributes.database), mode: 'exclusive' }));

const certCheck = H.command('certificate-days-left')
  .input(certItem)
  .argv(i => ['./scripts/cert-days-left.sh', i.domain])
  .runner(i => hostForDomain(i.domain))
  .output(z.object({ daysLeft: z.number() }));
const certRenew = H.command('certificate-renew')
  .input(certItem)
  .argv(i => ['./scripts/cert-renew.sh', i.domain])
  .runner(i => hostForDomain(i.domain));

const certFlow = H.flow('certificate-renewal')
  .input(certItem)
  .step('check', certCheck, ctx => ({ domain: ctx.unit.attributes.domain }), { afterCrash: 'rerun' })
  .exit('fresh', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', certRenew, ctx => ({ domain: ctx.unit.attributes.domain }), { afterCrash: 'rerun' })
  .exit('renewed');

const certLane = H.lane('certificates', CertificateRenewal)
  .supply(H.clock('weekly-cert-check').at('03:00', { on: 'mon', tz: 'UTC' }), (_tick, to) =>
    domainSchema.options.map(domain => to.create({ domain })),
  )
  .handler(certFlow, { exits: { fresh: CertFresh, renewed: CertRenewed } })
  .store(opsStore)
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 600000, exhausted: CertRenewalFailed });

const acknowledge = H.halt('incident-acknowledge').decision(z.object({ by: z.string() }));
const confirmResolved = H.halt('incident-resolved').decision(z.object({ resolved: z.boolean(), note: z.string() }));

const page = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(i => ['./scripts/page.sh', i.title])
  .runner(localRunner);
const runbook = H.command('runbook')
  .input(z.object({ runbook: z.string(), detail: z.string() }))
  .argv(i => [`./runbooks/${i.runbook}.sh`, i.detail])
  .runner(localRunner)
  .acceptExitCodes(0, 1);

const incidentFlow = H.flow('incident-runbook')
  .input(incidentItem)
  .step('page', page, ctx => ({ title: ctx.unit.attributes.title }), { afterCrash: 'park' })
  .halt('acknowledge', acknowledge, { ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.title}` })
  .step(
    'runbook',
    runbook,
    ctx => ({ runbook: ctx.unit.attributes.runbook, detail: ctx.unit.attributes.detail }),
    { afterCrash: 'park' },
  )
  .halt('confirm', confirmResolved, {
    ask: ctx => `Runbook ${ctx.unit.attributes.runbook} output:\n${ctx.steps.runbook.stdout}\nIs the incident resolved?`,
  })
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const incidentLane = H.lane('incidents', Incident)
  .supply(H.operator)
  .handler(incidentFlow, { exits: { resolved: IncidentResolved, unresolved: IncidentUnresolved } })
  .store(opsStore)
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60000, exhausted: IncidentUnresolved });

const threeDownOpensIncident = H.trigger('three-failed-heartbeats')
  .on(H.when.pattern(heartbeatLane, { to: Down, consecutive: 3, per: u => services.of(u.attributes.service) }))
  .create(incidentLane, e => ({
    ref: `heartbeat-${e.group.value}`,
    title: `${e.group.value} failed ${e.streak} consecutive heartbeats`,
    detail: `Last failure at ${e.at.toISOString()}`,
    runbook: 'restart-service',
  }));

const failedBackupOpensIncident = H.trigger('failed-backup')
  .on(H.when.transition(backupLane, { to: BackupFailed }))
  .create(incidentLane, e => ({
    ref: `backup-${e.unit.attributes.database}-${e.unit.attributes.night}`,
    title: `Backup of ${e.unit.attributes.database} failed`,
    detail: `Nightly backup of ${e.unit.attributes.night} failed at ${e.at.toISOString()}`,
    runbook: 'investigate-backup',
  }));

const opsJournal = H.journal('operational-experience', H.memory('operational-experience', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/ops.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const twoHoursMs = 2 * 60 * 60 * 1000;

const slowBackupNote = H.trigger('slow-backup-note')
  .on(
    H.when.transition(backupLane, {
      to: BackedUp,
      if: e => e.attempt !== undefined && e.attempt.durationMs > twoHoursMs,
    }),
  )
  .record(opsJournal, e => ({
    text: `When scheduling the nightly backup of ${e.unit.attributes.database}, start it earlier or split it, because the run of ${e.unit.attributes.night} took ${((e.attempt === undefined ? 0 : e.attempt.durationMs) / 3600000).toFixed(1)} hours.`,
    when: { kinds: [Backup], resources: [databases.of(e.unit.attributes.database)] },
  }));

const scheduler = H.scheduler('ops')
  .expedite(incidentLane, { holds: [backupLane] })
  .standard(heartbeatLane, certLane, backupLane);

const controlApi = http.controlApi('ops-control', {
  port: H.slot.port(0),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.resolve(acknowledge, confirmResolved),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.telemetryRead,
  ],
});

export const ops = H.harness('operations')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(heartbeatLane, backupLane, certLane, incidentLane)
  .journals(opsJournal)
  .triggers(threeDownOpensIncident, failedBackupOpensIncident, slowBackupNote)
  .scheduler(scheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-notifier', { webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidentLane] }),
    markdown.board({ path: './BOARD.md' }),
  );

void ops.start();
