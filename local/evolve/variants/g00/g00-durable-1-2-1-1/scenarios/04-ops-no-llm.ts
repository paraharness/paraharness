import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as slack from 'harness-dsl/slack';

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Probing = H.state('Probing', 'active');
const Up = H.state('Up', 'terminal', 'success');
const Down = H.state('Down', 'terminal', 'failure');

const BackupDue = H.state('BackupDue', 'pending');
const Dumping = H.state('Dumping', 'active');
const BackedUp = H.state('BackedUp', 'terminal', 'success');
const BackupFailed = H.state('BackupFailed', 'terminal', 'failure');

const RenewalDue = H.state('RenewalDue', 'pending');
const Inspecting = H.state('Inspecting', 'active');
const Renewing = H.state('Renewing', 'active');
const StillValid = H.state('StillValid', 'terminal', 'success');
const Renewed = H.state('Renewed', 'terminal', 'success');
const RenewalFailed = H.state('RenewalFailed', 'terminal', 'failure');

const IncidentOpen = H.state('IncidentOpen', 'pending');
const Paging = H.state('Paging', 'active');
const AwaitingAck = H.state('AwaitingAck', 'waiting');
const RunningRunbook = H.state('RunningRunbook', 'active');
const AwaitingResolution = H.state('AwaitingResolution', 'waiting');
const IncidentResolved = H.state('IncidentResolved', 'terminal', 'success');

const Heartbeat = H.work('Heartbeat')
  .attributes({ service: z.string(), at: z.number() })
  .states([HeartbeatDue, Probing, Up, Down])
  .failsTo(Down)
  .key(u => `${u.attributes.service}@${u.attributes.at}`);

const Backup = H.work('Backup')
  .attributes({ database: z.string(), night: z.string() })
  .states([BackupDue, Dumping, BackedUp, BackupFailed])
  .failsTo(BackupFailed)
  .key(u => `${u.attributes.database}@${u.attributes.night}`);

const CertificateRenewal = H.work('CertificateRenewal')
  .attributes({ domain: z.string(), week: z.string() })
  .states([RenewalDue, Inspecting, Renewing, StillValid, Renewed, RenewalFailed])
  .failsTo(RenewalFailed)
  .key(u => `${u.attributes.domain}@${u.attributes.week}`);

const Incident = H.work('Incident')
  .attributes({ ref: z.string(), title: z.string(), service: z.string() })
  .states([IncidentOpen, Paging, AwaitingAck, RunningRunbook, AwaitingResolution, IncidentResolved])
  .key(u => u.attributes.ref);

const alerts = slack.notify('ops-alerts', { webhookUrl: H.env('SLACK_OPS_WEBHOOK') });

const acknowledgement = H.decision('incident-ack', { by: z.string() });
const resolution = H.decision('incident-resolution', { notes: z.string() });

const heartbeatProbe = H.command('heartbeat-probe', ['scripts/heartbeat.sh']);
const databaseDump = H.command('database-dump', ['scripts/backup.sh']);
const certificateInspect = H.command('certificate-inspect', ['scripts/cert-days-left.sh']).parses({
  daysLeft: z.number(),
});
const certificateRenew = H.command('certificate-renew', ['scripts/cert-renew.sh']);
const runbook = H.command('incident-runbook', ['scripts/runbook.sh']);
const diskSpace = H.command('disk-space-preflight', ['scripts/check-disk.sh', '--min-free-gb', '50']);

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .step('probe', heartbeatProbe, c => ({ args: [c.input.service] }))
  .ends(['up'], () => 'up');

const backupFlow = H.flow('backup')
  .requires({ database: z.string() })
  .step('dump', databaseDump, c => ({ args: [c.input.database] }), { restart: 'rerun' })
  .ends(['done'], () => 'done');

const renewalFlow = H.flow('certificate-renewal')
  .requires({ domain: z.string() })
  .step('inspect', certificateInspect, c => ({ args: [c.input.domain] }), { restart: 'rerun' })
  .exit('valid', c => c.out.inspect.data.daysLeft >= 14)
  .step('renew', certificateRenew, c => ({ args: [c.input.domain] }))
  .ends(['renewed'], () => 'renewed');

const incidentFlow = H.flow('incident-runbook')
  .requires({ title: z.string(), service: z.string() })
  .step('page', alerts, c => ({ text: `Paging on-call: ${c.input.title}` }))
  .halt('ack', acknowledgement, { ask: c => `Acknowledge incident: ${c.input.title}` })
  .step('runbook', runbook, c => ({ args: [c.input.service] }), { onFailure: 'halt' })
  .halt('resolution', resolution, { ask: c => `Confirm ${c.input.title} is resolved.` })
  .ends(['resolved'], () => 'resolved');

const services = ['api', 'web', 'queue'];
const databases = ['orders', 'accounts', 'analytics'];
const domains = ['example.com', 'api.example.com'];

const localShell = local.shell({ slots: 4 });
const hosts = ssh.hosts({
  hosts: [
    { host: 'db-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
    { host: 'db-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
  ],
  slotsPerHost: 1,
});

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply([
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), (c, supply) =>
      services.map(service => supply.create({ attributes: { service, at: c.now } })),
    ),
  ])
  .runner(localShell)
  .handler(heartbeatFlow, { states: { probe: Probing, up: Up }, opens: Probing });

const backups = H.lane('backups', Backup)
  .supply([
    H.supply.schedule(Backup, H.time.daily('01:00', 'UTC'), (c, supply) =>
      databases.map(database => supply.create({ attributes: { database, night: dayOf(c.now) } })),
    ),
  ])
  .runner(hosts)
  .preflight(diskSpace)
  .handler(backupFlow, { states: { dump: Dumping, done: BackedUp }, opens: Dumping });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply([
    H.supply.schedule(CertificateRenewal, H.time.weekly('mon', '03:00', 'UTC'), (c, supply) =>
      domains.map(domain => supply.create({ attributes: { domain, week: dayOf(c.now) } })),
    ),
  ])
  .runner(hosts)
  .preflight(diskSpace)
  .handler(renewalFlow, {
    states: { inspect: Inspecting, renew: Renewing, valid: StillValid, renewed: Renewed },
    opens: Inspecting,
  });

const incidents = H.lane('incidents', Incident)
  .supply([H.supply.operator()])
  .runner(localShell)
  .handler(incidentFlow, {
    states: {
      page: Paging,
      ack: AwaitingAck,
      runbook: RunningRunbook,
      resolution: AwaitingResolution,
      resolved: IncidentResolved,
    },
    opens: Paging,
    blocked: AwaitingResolution,
  });

const operationalNotes = H.journal('operational-notes', H.memory.experience('operational-note')).store(
  jsonl.memory('memory/operational-notes.jsonl'),
);

const heartbeatStreakOpensIncident = H.trigger(
  'heartbeat-streak-opens-incident',
  H.on.streak(heartbeats, { verdict: 'failure', count: 3, per: 'service' }),
).creates(e =>
  incidents.unit({
    attributes: {
      ref: `heartbeat/${e.unit.attributes.service}/${e.unit.attributes.at}`,
      title: `${e.unit.attributes.service} failed ${e.count} heartbeats in a row`,
      service: e.unit.attributes.service,
    },
  }),
);

const failedBackupOpensIncident = H.trigger(
  'failed-backup-opens-incident',
  H.on.transition(backups, { to: [BackupFailed] }),
).creates(e =>
  incidents.unit({
    attributes: {
      ref: `backup/${e.unit.key}`,
      title: `Backup of ${e.unit.attributes.database} failed for ${e.unit.attributes.night}`,
      service: e.unit.attributes.database,
    },
  }),
);

const twoHoursMs = 2 * 60 * 60 * 1000;

const slowBackupRecordsNote = H.trigger(
  'slow-backup-records-note',
  H.on.transition(backups, { to: [BackedUp] }),
)
  .where(e => (e.attempt === null ? false : e.attempt.durationMs > twoHoursMs))
  .records(operationalNotes, e => [
    {
      rule: `Schedule the ${e.unit.attributes.database} backup earlier or on a quieter host`,
      because: `the backup of ${e.unit.attributes.night} took over two hours`,
      when: { kinds: [Backup], attributes: { database: e.unit.attributes.database } },
    },
  ]);

const incidentTransitionsNotify = H.trigger(
  'incident-transitions-notify',
  H.on.transition(incidents),
).invokes(alerts, e => ({
  text: `Incident ${e.unit.attributes.title}: ${e.from === null ? 'new' : e.from.name} -> ${e.to.name}`,
}));

const incidentsFirst = H.policy.schedule('incidents-first', c => {
  const incidentOpen = c.open.some(a => a.is(incidents));
  const incidentWaiting = c.candidates.some(x => x.is(incidents));
  const ordered = c.order(
    x => (x.is(incidents) ? 0 : x.is(heartbeats) ? 1 : x.is(renewals) ? 2 : 3),
    x => x.enqueuedAt,
  );
  return {
    start: ordered.filter(x => (incidentOpen || incidentWaiting ? x.is(backups) === false : true)),
    preempt: incidentWaiting ? c.open.filter(a => a.holdsCapacity && a.is(backups) === false && a.is(incidents) === false) : [],
  };
});

const operatorAccess = H.access('ops-operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ops.db'))
  .lanes([incidents, heartbeats, backups, renewals])
  .triggers([heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupRecordsNote, incidentTransitionsNotify])
  .schedule(incidentsFirst)
  .clients([http.server('ops-control', operatorAccess, { port: H.slot.port(0), token: H.env('OPS_API_TOKEN') })])
  .projections([markdown.board('BOARD.md')]);
