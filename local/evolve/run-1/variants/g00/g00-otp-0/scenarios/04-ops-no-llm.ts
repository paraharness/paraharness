import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { shell } from 'harness-dsl/shell';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const Due = H.state('due', 'runnable');
const Up = H.state('up', 'succeeded');
const Down = H.state('down', 'failed');
const Scheduled = H.state('scheduled', 'runnable');
const BackedUp = H.state('backed-up', 'succeeded');
const BackupFailed = H.state('backup-failed', 'failed');
const Checking = H.state('checking', 'runnable');
const StillValid = H.state('still-valid', 'succeeded');
const Renewed = H.state('renewed', 'succeeded');
const RenewalFailed = H.state('renewal-failed', 'failed');
const Open = H.state('open', 'runnable');
const Resolved = H.state('resolved', 'succeeded');
const Unresolved = H.state('unresolved', 'failed');
const Cancelled = H.state('cancelled', 'cancelled');

const Heartbeat = H.kind('Heartbeat', {
  data: z.object({ service: z.string(), url: z.string(), at: z.string() }),
  key: (beat) => `${beat.service}@${beat.at}`,
}).states([Due, Up, Down], { initial: Due });

const Backup = H.kind('Backup', {
  data: z.object({ database: z.string(), host: z.string(), night: z.string() }),
  key: (backup) => `${backup.database}@${backup.night}`,
}).states([Scheduled, BackedUp, BackupFailed], { initial: Scheduled });

const CertificateRenewal = H.kind('CertificateRenewal', {
  data: z.object({ domain: z.string(), host: z.string(), week: z.string() }),
  key: (renewal) => `${renewal.domain}@${renewal.week}`,
}).states([Checking, StillValid, Renewed, RenewalFailed], { initial: Checking });

const Incident = H.kind('Incident', {
  data: z.object({ id: z.string(), title: z.string(), service: z.string() }),
  key: (incident) => incident.id,
})
  .states([Open, Resolved, Unresolved, Cancelled], { initial: Open })
  .on('cancel', { from: [Open], to: Cancelled, attempt: 'cancel' });

const Database = H.resource('database');
const OperationalExperience = H.memory('operational-experience', { authority: 'observed' });
const opsJournal = H.journal('ops-notes', OperationalExperience)
  .store(jsonl.store('memory/ops.jsonl'))
  .recall(H.recall.bySpecificity({ limit: 20 }));

const local = shell.local({ slots: 8 });
const diskPreflight = ['df --output=pcent / | tail -1 | tr -dc 0-9 | xargs test 90 -gt'];
const hostA = ssh.host({ host: 'db-a.internal', user: 'ops', privateKey: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskPreflight });
const hostB = ssh.host({ host: 'db-b.internal', user: 'ops', privateKey: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskPreflight });
const hostFor = (input: { host: string }) => (input.host === 'db-a' ? hostA : hostB);

const probe = H.command('probe', {
  input: z.object({ url: z.string() }),
  argv: (input) => ['curl', '-fsS', '--max-time', '10', input.url],
  runner: local,
});

const dumpDatabase = H.command('dump-database', {
  input: z.object({ database: z.string(), host: z.string() }),
  argv: (input) => ['backup-database', input.database],
  runner: hostFor,
});

const certificateDaysLeft = H.command('certificate-days-left', {
  input: z.object({ domain: z.string(), host: z.string() }),
  output: z.object({ daysLeft: z.number() }),
  argv: (input) => ['cert-days-left', input.domain],
  runner: hostFor,
});

const renewCertificate = H.command('renew-certificate', {
  input: z.object({ domain: z.string(), host: z.string() }),
  argv: (input) => ['renew-certificate', input.domain],
  runner: hostFor,
});

const pageOnCall = H.command('page-on-call', {
  input: z.object({ incidentId: z.string(), title: z.string() }),
  argv: (input) => ['page-on-call', '--incident', input.incidentId, '--title', input.title],
  runner: local,
});

const runbook = H.command('runbook', {
  input: z.object({ incidentId: z.string(), service: z.string() }),
  argv: (input) => ['run-runbook', input.service, '--incident', input.incidentId],
  runner: local,
});

const checkHeartbeat = H.flow('check-heartbeat', { input: z.object({ url: z.string() }), exits: ['up', 'down'] }, async (ctx) => {
  const result = await ctx.try('probe', probe, { url: ctx.input.url });
  return result.ok ? ctx.exit('up') : ctx.exit('down');
});

const runBackup = H.flow(
  'run-backup',
  { input: z.object({ database: z.string(), host: z.string() }), exits: ['backedUp', 'failed'] },
  async (ctx) => {
    const result = await ctx.try('dump', dumpDatabase, { database: ctx.input.database, host: ctx.input.host });
    return result.ok ? ctx.exit('backedUp') : ctx.exit('failed');
  },
);

const checkCertificate = H.flow(
  'check-certificate',
  { input: z.object({ domain: z.string(), host: z.string() }), exits: ['stillValid', 'renewed', 'failed'] },
  async (ctx) => {
    const target = { domain: ctx.input.domain, host: ctx.input.host };
    const status = await ctx.run('days-left', certificateDaysLeft, target);
    if (status.daysLeft >= 14) {
      return ctx.exit('stillValid');
    }
    const renewal = await ctx.try('renew', renewCertificate, target);
    return renewal.ok ? ctx.exit('renewed') : ctx.exit('failed');
  },
);

const respondToIncident = H.flow(
  'respond-to-incident',
  { input: z.object({ id: z.string(), title: z.string(), service: z.string() }), exits: ['resolved', 'unresolved'] },
  async (ctx) => {
    await ctx.run('page', pageOnCall, { incidentId: ctx.input.id, title: ctx.input.title });
    await ctx.halt('acknowledge', {
      question: `Acknowledge incident ${ctx.input.id}: ${ctx.input.title}`,
      decision: z.object({ acknowledgedBy: z.string() }),
    });
    const result = await ctx.try('runbook', runbook, { incidentId: ctx.input.id, service: ctx.input.service });
    const confirmation = await ctx.halt('confirm-resolution', {
      question: `Is incident ${ctx.input.id} resolved?`,
      report: result.ok ? result.output.stdout : `${result.error}\n${result.stdout}`,
      decision: z.object({ resolved: z.boolean(), notes: z.string() }),
    });
    return confirmation.resolved ? ctx.exit('resolved') : ctx.exit('unresolved');
  },
);

const services = [
  { name: 'api', url: 'https://api.internal/health' },
  { name: 'queue', url: 'https://queue.internal/health' },
];
const databases = [
  { database: 'orders', host: 'db-a' },
  { database: 'billing', host: 'db-b' },
];
const domains = [
  { domain: 'example.com', host: 'db-a' },
  { domain: 'api.example.com', host: 'db-b' },
];

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .supply(
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), (tick, unit) =>
      services.map((service) => unit.create({ service: service.name, url: service.url, at: tick.at.toISOString() })),
    ),
  )
  .handle(Due, checkHeartbeat, { exits: { up: Up, down: Down }, crash: { retries: 0, then: Down } });

const backupLane = H.lane('backups', Backup)
  .supply(
    H.supply.schedule(Backup, H.time.daily('01:00'), (tick, unit) =>
      databases.map((target) => unit.create({ ...target, night: tick.at.toISOString().slice(0, 10) })),
    ),
  )
  .handle(Scheduled, runBackup, { exits: { backedUp: BackedUp, failed: BackupFailed }, crash: { retries: 0, then: BackupFailed } })
  .resources((backup) => [Database.key(backup.database)]);

const renewalLane = H.lane('certificate-renewals', CertificateRenewal)
  .supply(
    H.supply.schedule(CertificateRenewal, H.time.weekly('mon', '04:00'), (tick, unit) =>
      domains.map((target) => unit.create({ ...target, week: tick.at.toISOString().slice(0, 10) })),
    ),
  )
  .handle(Checking, checkCertificate, {
    exits: { stillValid: StillValid, renewed: Renewed, failed: RenewalFailed },
    crash: { retries: 1, then: RenewalFailed },
  });

const incidentLane = H.lane('incidents', Incident)
  .supply(H.supply.operator(Incident))
  .store(sqlite.store('ops.db'))
  .handle(Open, respondToIncident, { exits: { resolved: Resolved, unresolved: Unresolved } });

const threeDownHeartbeats = H.trigger('three-down-heartbeats-open-incident')
  .on(H.when.streak(Heartbeat, Down, 3, { by: (beat) => beat.service }))
  .create(incidentLane, (streak) => ({
    id: `INC-${streak.group}-${streak.at.getTime()}`,
    title: `${streak.group} failed three consecutive heartbeats`,
    service: streak.group,
  }));

const failedBackup = H.trigger('failed-backup-opens-incident')
  .on(H.when.entered(Backup, BackupFailed))
  .create(incidentLane, (transition) => ({
    id: `INC-backup-${transition.unit.data.database}-${transition.unit.data.night}`,
    title: `Backup of ${transition.unit.data.database} failed on ${transition.unit.data.night}`,
    service: transition.unit.data.database,
  }));

const slowBackup = H.trigger('slow-backup-noted')
  .on(H.when.entered(Backup, BackedUp))
  .where((transition) => transition.attempt !== null && transition.attempt.durationSeconds > 2 * 3600)
  .note(opsJournal, (transition) => ({
    do: `start the ${transition.unit.data.database} backup earlier or split it by schema`,
    condition: `when scheduling the nightly ${transition.unit.data.database} backup`,
    because: `on ${transition.unit.data.night} it took ${Math.round((transition.attempt?.durationSeconds ?? 0) / 60)} minutes`,
    when: { kinds: [Backup], resources: [Database.key(transition.unit.data.database)] },
  }));

const priority = (unit: PendingView) => {
  if (unit.is(Incident)) return 0;
  if (unit.is(Heartbeat)) return 1;
  if (unit.is(Backup)) return 2;
  return 3;
};

const scheduler = H.scheduler('incidents-preempt', (query) => {
  const incidentPending = query.pending.some((unit) => unit.is(Incident));
  const incidentOpen = incidentPending || query.active.some((attempt) => attempt.is(Incident));
  return {
    order: [...query.pending]
      .filter((unit) => (incidentOpen ? unit.is(Backup) === false : true))
      .sort((a, b) => priority(a) - priority(b) || b.waitingSeconds - a.waitingSeconds),
    preempt: incidentPending ? query.active.filter((attempt) => attempt.is(Heartbeat) || attempt.is(CertificateRenewal)) : [],
  };
});

const operationsApi = H.client('operations-api', http.server({ port: H.slot.port(0), token: H.env('OPS_API_TOKEN') })).grant([
  H.ops.readWork,
  H.ops.writeWork,
  H.ops.resolveBlockers,
  H.ops.readMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('ops-ledger.db'))
  .lanes([incidentLane, heartbeatLane, backupLane, renewalLane])
  .journals([opsJournal])
  .triggers([threeDownHeartbeats, failedBackup, slowBackup])
  .scheduler(scheduler)
  .clients([operationsApi])
  .observers([slack.notifier({ webhookUrl: H.env('SLACK_WEBHOOK_URL'), kinds: [Incident] }), markdown.board('BOARD.md')]);
