import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { shell } from 'harness-dsl/shell';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const Heartbeat = H.kind('Heartbeat', {
  data: z.object({ service: z.string(), url: z.string().url() }),
  states: { due: 'pending', probing: 'active', up: 'succeeded', down: 'failed', skipped: 'cancelled' },
  initial: 'due',
  tags: (beat) => [beat.service],
});

const Backup = H.kind('Backup', {
  data: z.object({ database: z.string(), host: z.string() }),
  states: { queued: 'pending', dumping: 'active', done: 'succeeded', failed: 'failed', skipped: 'cancelled' },
  initial: 'queued',
  tags: (backup) => [backup.host, backup.database],
});

const CertificateRenewal = H.kind('CertificateRenewal', {
  data: z.object({ domain: z.string(), host: z.string() }),
  states: {
    due: 'pending',
    checking: 'active',
    renewing: 'active',
    valid: 'succeeded',
    renewed: 'succeeded',
    failed: 'failed',
    skipped: 'cancelled',
  },
  initial: 'due',
  tags: (cert) => [cert.host, cert.domain],
});

const Incident = H.kind('Incident', {
  data: z.object({ service: z.string(), summary: z.string(), runbook: z.string() }),
  states: {
    open: 'pending',
    paging: 'active',
    mitigating: 'active',
    confirming: 'active',
    resolved: 'succeeded',
    unresolved: 'failed',
    dismissed: 'cancelled',
  },
  initial: 'open',
  tags: (incident) => [incident.service],
});

const local = shell.local({ name: 'local', slots: 4 });
const diskPreflight = H.command('disk-preflight', {
  argv: ['sh', '-c', 'test "$(df --output=avail -k /var/backups | tail -1)" -gt 20971520'],
  timeoutSeconds: 30,
});
const dbHost1 = shell.ssh({ name: 'db-host-1', host: 'db1.internal', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskPreflight });
const dbHost2 = shell.ssh({ name: 'db-host-2', host: 'db2.internal', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskPreflight });

const hostOfUnit = H.policy.pick('host-of-unit', [dbHost1, dbHost2], (ctx) => {
  const match = ctx.candidates.find((c) => ctx.unit !== undefined && ctx.unit.tags.includes(c.value.name));
  return match === undefined ? dbHost1 : match.value;
});

const services = [
  { service: 'api', url: 'https://api.internal/health' },
  { service: 'queue', url: 'https://queue.internal/health' },
];
const databases = [
  { database: 'orders', host: 'db-host-1' },
  { database: 'customers', host: 'db-host-1' },
  { database: 'analytics', host: 'db-host-2' },
];
const certificates = [
  { domain: 'api.example.com', host: 'db-host-1' },
  { domain: 'www.example.com', host: 'db-host-2' },
];

const heartbeatFlow = H.flow('heartbeat', { kinds: [Heartbeat] })
  .mark('probing')
  .step('probe', (ctx) => H.command('probe', { argv: ['curl', '--fail', '--silent', '--max-time', '10', ctx.unit.data.url], timeoutSeconds: 15 }))
  .end('up');

const heartbeatLane = H.lane(Heartbeat)
  .from(H.every(Heartbeat, { minutes: 5 }, (tick) => services.map((s) => ({ key: `${s.service}@${tick.now.toISOString()}`, data: s }))))
  .handle(heartbeatFlow)
  .states({ probing: 'probing', up: 'up', failed: 'down', cancelled: 'skipped' })
  .runOn(local);

const backupFlow = H.flow('backup', { kinds: [Backup] })
  .mark('dumping')
  .step('dump', (ctx) =>
    H.command('dump-database', { argv: ['/opt/ops/bin/backup', ctx.unit.data.database], timeoutSeconds: 6 * 3600 }),
  )
  .end('done');

const backupLane = H.lane(Backup)
  .from(
    H.every(Backup, { cron: '0 1 * * *', tz: 'UTC' }, (tick) =>
      databases.map((db) => ({ key: `${db.database}@${tick.now.toISOString().slice(0, 10)}`, data: db })),
    ),
  )
  .handle(backupFlow)
  .states({ dumping: 'dumping', done: 'done', failed: 'failed', cancelled: 'skipped' })
  .runOn(hostOfUnit);

const CertStatus = z.object({ daysLeft: z.number() });
const renewalThresholdDays = 14;

const renewalFlow = H.flow('certificate-renewal', { kinds: [CertificateRenewal] })
  .mark('checking')
  .step('check', (ctx) => H.command('check-certificate', { argv: ['/opt/ops/bin/cert-days-left', ctx.unit.data.domain], output: CertStatus }))
  .end((ctx) => (ctx.out.check.daysLeft >= renewalThresholdDays ? 'valid' : undefined))
  .mark('renewing')
  .step('renew', (ctx) => H.command('renew-certificate', { argv: ['/opt/ops/bin/cert-renew', ctx.unit.data.domain], timeoutSeconds: 600 }), {
    retry: { maxRetries: 2, backoff: 'exponential', baseSeconds: 60 },
  })
  .end('renewed');

const renewalLane = H.lane(CertificateRenewal)
  .from(
    H.every(CertificateRenewal, { cron: '0 4 * * 1', tz: 'UTC' }, (tick) =>
      certificates.map((cert) => ({ key: `${cert.domain}@${tick.now.toISOString().slice(0, 10)}`, data: cert })),
    ),
  )
  .handle(renewalFlow)
  .states({ checking: 'checking', renewing: 'renewing', valid: 'valid', renewed: 'renewed', failed: 'failed', cancelled: 'skipped' })
  .runOn(hostOfUnit);

const incidentFlow = H.flow('incident-runbook', { kinds: [Incident] })
  .mark('paging')
  .step('page', (ctx) => H.command('page-oncall', { argv: ['/opt/ops/bin/page-oncall', ctx.unit.key, ctx.unit.data.summary] }))
  .halt('acknowledge', {
    question: (ctx) => `Acknowledge incident ${ctx.unit.key}: ${ctx.unit.data.summary}`,
    decision: z.object({ acknowledgedBy: z.string() }),
  })
  .mark('mitigating')
  .step('runbook', (ctx) => H.command('run-runbook', { argv: ['/opt/ops/runbooks/run', ctx.unit.data.runbook, ctx.unit.data.service], timeoutSeconds: 1800 }))
  .mark('confirming')
  .halt('confirmResolution', {
    question: (ctx) => `The runbook ${ctx.unit.data.runbook} finished. Is ${ctx.unit.data.service} healthy again?`,
    decision: z.object({ resolved: z.boolean(), notes: z.string() }),
  })
  .end((ctx) => (ctx.out.confirmResolution !== undefined && ctx.out.confirmResolution.resolved ? 'resolved' : 'unresolved'), {
    note: (ctx) => ctx.out.confirmResolution?.notes ?? '',
  });

const incidentLane = H.lane(Incident)
  .from(H.operator)
  .handle(incidentFlow)
  .states({
    paging: 'paging',
    mitigating: 'mitigating',
    confirming: 'confirming',
    resolved: 'resolved',
    unresolved: 'unresolved',
    failed: 'unresolved',
    cancelled: 'dismissed',
  })
  .runOn(local);

const threeMissedHeartbeats = H.trigger(
  'three-missed-heartbeats-open-incident',
  H.when.repeats(Heartbeat, { state: 'down', times: 3, sameKey: (beat) => beat.service }),
  (then) =>
    then.create(incidentLane, (event) => ({
      key: `incident-${event.unit.data.service}-${event.at.toISOString()}`,
      data: {
        service: event.unit.data.service,
        summary: `${event.unit.data.service} failed three consecutive heartbeats`,
        runbook: 'restart-service',
      },
    })),
);

const failedBackup = H.trigger('failed-backup-opens-incident', H.when.enters(Backup, 'failed'), (then) =>
  then.create(incidentLane, (event) => ({
    key: `incident-backup-${event.unit.data.database}-${event.at.toISOString()}`,
    data: { service: event.unit.data.database, summary: `backup of ${event.unit.data.database} failed`, runbook: 'retry-backup' },
  })),
);

const OperationalExperience = H.memory('operational-experience', { stance: 'experience' });
const opsJournal = H.journal('ops-experience', OperationalExperience, jsonl.memory({ path: '/var/lib/harness/ops-experience.jsonl' }));

const twoHoursSeconds = 2 * 3600;

const slowBackupNote = H.trigger(
  'slow-backup-records-experience',
  H.when.enters(Backup, 'done').where((event) => event.attempt !== undefined && event.attempt.durationSeconds > twoHoursSeconds),
  (then) =>
    then.record(opsJournal, (event) => ({
      do: `move the ${event.unit.data.database} backup earlier or split it by schema`,
      condition: `when the ${event.unit.data.database} backup on ${event.unit.data.host} is scheduled`,
      because: `it took ${Math.round((event.attempt?.durationSeconds ?? 0) / 60)} minutes on ${event.at.toISOString().slice(0, 10)}, past the two-hour window`,
      when: { kinds: [Backup.name], resources: [event.unit.data.database, event.unit.data.host] },
    })),
);

const incidentToSlack = H.trigger(
  'incident-transitions-to-slack',
  H.when.enters(Incident, 'open', 'paging', 'mitigating', 'confirming', 'resolved', 'unresolved', 'dismissed'),
  (then) =>
    then.run((event) =>
      slack.message({
        webhook: H.env('SLACK_OPS_WEBHOOK'),
        text: `Incident ${event.unit.key} (${event.unit.data.service}): ${event.from ?? 'new'} -> ${event.to}`,
      }),
    ),
);

const board = H.trigger('board', H.when.transition(), (then) => then.run(markdown.board({ path: '/var/lib/harness/BOARD.md' })));

const incidentsFirst = H.policy.order('incidents-first', (ctx) => {
  const incidentOpen = ctx.active.some((a) => a.kind === Incident.name) || ctx.pending.some((p) => p.kind === Incident.name);
  const incidentWaiting = ctx.pending.some((p) => p.kind === Incident.name);
  return {
    order: [...ctx.pending]
      .filter((p) => !(incidentOpen && p.kind === Backup.name))
      .sort((a, b) => Number(b.kind === Incident.name) - Number(a.kind === Incident.name) || b.waitingSeconds - a.waitingSeconds),
    preempt: incidentWaiting ? ctx.active.filter((a) => a.kind !== Incident.name && a.kind !== Backup.name && !a.blocked) : [],
  };
});

const controlApi = http.control({
  name: 'ops-http',
  port: H.slot.port(8080),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.op.readWork, H.op.createWork, H.op.cancelWork, H.op.resolveBlocker, H.op.readMemory, H.op.readTelemetry],
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger({ path: '/var/lib/harness/ledger.sqlite' }))
  .lanes(heartbeatLane, backupLane, renewalLane, incidentLane)
  .journals(opsJournal)
  .triggers(threeMissedHeartbeats, failedBackup, slowBackupNote, incidentToSlack, board)
  .scheduler(incidentsFirst)
  .clients(controlApi);

export const running = operations.start();
