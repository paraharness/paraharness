import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';

const HeartbeatDue = H.state('due', 'pending');
const Probing = H.state('probing', 'active');
const ServiceUp = H.state('up', 'terminal', 'success');
const ServiceDown = H.state('down', 'terminal', 'failure');

const BackupScheduled = H.state('scheduled', 'pending');
const BackingUp = H.state('backing-up', 'active');
const BackedUp = H.state('backed-up', 'terminal', 'success');
const BackupFailed = H.state('backup-failed', 'terminal', 'failure');

const RenewalDue = H.state('due', 'pending');
const Checking = H.state('checking', 'active');
const StillValid = H.state('still-valid', 'terminal', 'success');
const Renewed = H.state('renewed', 'terminal', 'success');
const RenewalFailed = H.state('renewal-failed', 'terminal', 'failure');

const IncidentOpen = H.state('open', 'pending');
const Responding = H.state('responding', 'active');
const Stalled = H.state('stalled', 'waiting');
const Resolved = H.state('resolved', 'terminal', 'success');

const Heartbeat = H.work('heartbeat')
  .attributes({ service: z.string(), tick: z.number() })
  .states([HeartbeatDue, Probing, ServiceUp, ServiceDown])
  .key((u) => `${u.attributes.service}@${u.attributes.tick}`);

const Backup = H.work('backup')
  .attributes({ database: z.string(), night: z.string() })
  .states([BackupScheduled, BackingUp, BackedUp, BackupFailed])
  .key((u) => `${u.attributes.database}:${u.attributes.night}`);

const CertificateRenewal = H.work('certificate-renewal')
  .attributes({ domain: z.string(), week: z.string() })
  .states([RenewalDue, Checking, StillValid, Renewed, RenewalFailed])
  .key((u) => `${u.attributes.domain}:${u.attributes.week}`);

const Incident = H.work('incident')
  .attributes({ service: z.string(), reason: z.string(), origin: z.string() })
  .states([IncidentOpen, Responding, Stalled, Resolved])
  .events({ retry: { by: z.string() } })
  .key((u) => `${u.attributes.service}:${u.attributes.origin}`, { unique: 'whileOpen' });

const Operations = H.memory.experience('operations');
const opsJournal = H.journal('operations', Operations).store(jsonl.memory('./memory/operations.jsonl'));

const services = ['api', 'web', 'worker'];
const databases = ['orders', 'customers', 'events'];
const domains = ['example.com', 'api.example.com'];

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const probe = H.command('probe-service', ['./ops/probe.sh']);
const dumpDatabase = H.command('dump-database', ['./ops/backup.sh']);
const diskSpace = H.command('disk-space-preflight', ['./ops/check-disk.sh', '--min-free-gb', '50']);
const checkCertificate = H.command('check-certificate', ['./ops/cert-days-left.sh']).parses({ daysLeft: z.number() });
const renewCertificate = H.command('renew-certificate', ['./ops/renew-cert.sh']);
const runbook = H.command('incident-runbook', ['./ops/runbook.sh']);

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .mark('probing')
  .step('probe', probe, (c) => ({ args: [c.input.service] }), { timeoutMs: 30_000 })
  .ends(['up'], () => 'up');

const backupFlow = H.flow('backup')
  .requires({ database: z.string() })
  .mark('backing-up')
  .step('dump', dumpDatabase, (c) => ({ args: [c.input.database] }), { timeoutMs: 6 * 60 * 60 * 1000 })
  .ends(['backed-up'], () => 'backed-up');

const renewalFlow = H.flow('certificate-renewal')
  .requires({ domain: z.string() })
  .mark('checking')
  .step('check', checkCertificate, (c) => ({ args: [c.input.domain] }))
  .exit('still-valid', (c) => c.out.check.data.daysLeft >= 14)
  .step('renew', renewCertificate, (c) => ({ args: [c.input.domain] }))
  .ends(['renewed'], () => 'renewed');

const incidentFlow = H.flow('incident')
  .requires({ service: z.string(), reason: z.string() })
  .mark('responding')
  .halt('acknowledge', {
    ask: (c) => `Incident on ${c.input.service}: ${c.input.reason}. Acknowledge to run the runbook.`,
    decision: { acknowledgedBy: z.string() },
  })
  .step('runbook', runbook, (c) => ({ args: [c.input.service] }), { onFailure: 'halt' })
  .halt('confirm', {
    ask: (c) => `Runbook for ${c.input.service} exited ${c.out.runbook.exitCode}. Is the incident resolved?`,
    decision: { resolved: z.boolean(), note: z.string() },
  })
  .ends(['resolved', 'unresolved'], (c) => (c.out.confirm.resolved ? 'resolved' : 'unresolved'));

const localShell = local.shell({ slots: 4 });
const backupHosts = ssh.hosts({
  hosts: [
    { host: 'backup-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
    { host: 'backup-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
  ],
  slotsPerHost: 1,
});

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .supply([
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), (c) =>
      services.map((service) => ({ create: { attributes: { service, tick: c.now } } })),
    ),
  ])
  .runner(localShell)
  .handler(heartbeatFlow, { states: { probing: Probing, up: ServiceUp, failed: ServiceDown } });

const backupLane = H.lane('backups', Backup)
  .supply([
    H.supply.schedule(Backup, H.time.daily('01:00', 'UTC'), (c) =>
      databases.map((database) => ({ create: { attributes: { database, night: dayOf(c.now) } } })),
    ),
  ])
  .runner(backupHosts)
  .preflight(diskSpace)
  .handler(backupFlow, { states: { 'backing-up': BackingUp, 'backed-up': BackedUp, failed: BackupFailed } });

const renewalLane = H.lane('certificate-renewals', CertificateRenewal)
  .supply([
    H.supply.schedule(CertificateRenewal, H.time.weekly('mon', '03:00', 'UTC'), (c) =>
      domains.map((domain) => ({ create: { attributes: { domain, week: dayOf(c.now) } } })),
    ),
  ])
  .runner(backupHosts)
  .preflight(diskSpace)
  .handler(renewalFlow, {
    states: { checking: Checking, 'still-valid': StillValid, renewed: Renewed, failed: RenewalFailed },
  });

const incidentLane = H.lane('incidents', Incident)
  .supply([H.supply.operator()])
  .runner(localShell)
  .reaction('retry', IncidentOpen, { from: [Stalled] })
  .handler(incidentFlow, {
    states: { responding: Responding, resolved: Resolved, unresolved: Stalled, failed: Stalled },
  });

const heartbeatStreakOpensIncident = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(heartbeatLane, { verdict: 'failure', count: 3, per: 'service' }),
).creates(incidentLane, (e) => ({
  attributes: {
    service: e.unit.attributes.service,
    reason: `${e.count} consecutive heartbeat failures`,
    origin: 'heartbeat',
  },
}));

const failedBackupOpensIncident = H.trigger(
  'failed-backup-opens-incident',
  H.on.transition(backupLane, { to: [BackupFailed] }),
).creates(incidentLane, (e) => ({
  attributes: {
    service: e.unit.attributes.database,
    reason: `backup of ${e.unit.attributes.database} for ${e.unit.attributes.night} failed`,
    origin: 'backup',
  },
}));

const slowBackupMs = 2 * 60 * 60 * 1000;

const slowBackupRecordsNote = H.trigger(
  'slow-backup-records-note',
  H.on.transition(backupLane, { to: [BackedUp] }),
)
  .where((e) => e.attempt !== null && e.attempt.durationMs > slowBackupMs)
  .records(opsJournal, (e) => [
    {
      rule: `When scheduling the backup of ${e.unit.attributes.database}, start it earlier or split it`,
      because: `the ${e.unit.attributes.night} backup took ${Math.round((e.attempt ? e.attempt.durationMs : 0) / 60000)} minutes`,
      when: { kinds: [Backup], attributes: { database: e.unit.attributes.database } },
    },
  ]);

const slackOps = slack.notify('ops-channel', { webhookUrl: H.env('SLACK_OPS_WEBHOOK') });

const incidentTransitionsNotify = H.trigger('incident-transitions-notify', H.on.transition(incidentLane)).invokes(
  slackOps,
  (e) => ({ text: `Incident ${e.unit.key} (${e.unit.attributes.reason}): ${e.from} → ${e.to}` }),
);

const opsSchedule = H.policy.schedule('incidents-preempt', (c) => {
  const incidentActive = c.open.some((attempt) => c.inLane(attempt, incidentLane));
  const rank = (x: (typeof c.candidates)[number]): number =>
    x.is(incidentLane) ? 0 : x.is(heartbeatLane) ? 1 : x.is(renewalLane) ? 2 : 3;
  const admissible = c.candidates.filter((x) => !(incidentActive && x.is(backupLane)));
  const incidentWaiting = admissible.some((x) => x.is(incidentLane));
  return {
    start: [...admissible].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
    preempt: incidentWaiting
      ? c.open.filter(
          (attempt) =>
            attempt.status === 'running' && !c.inLane(attempt, backupLane) && !c.inLane(attempt, incidentLane),
        )
      : [],
  };
});

const operatorAccess = H.access('operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.readTelemetry,
]);

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('./.harness/ledger.db'))
  .lanes([incidentLane, heartbeatLane, backupLane, renewalLane])
  .triggers([heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupRecordsNote, incidentTransitionsNotify])
  .schedule(opsSchedule)
  .clients([http.server('ops-api', operatorAccess, { port: H.slot.port(0), token: H.env('OPS_API_TOKEN') })])
  .projections([markdown.board('./BOARD.md')]);

export const running = operations.start();
