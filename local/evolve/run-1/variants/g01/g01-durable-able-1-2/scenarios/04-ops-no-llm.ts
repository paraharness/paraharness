import { H } from 'harness-dsl';
import { z } from 'zod';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const services = ['api', 'web', 'worker'];
const databases = ['orders', 'users'];
const domains = ['example.com', 'api.example.com'];
const slowBackupMs = 2 * 60 * 60 * 1000;

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Up = H.state('Up', 'terminal', 'success');
const Down = H.state('Down', 'terminal', 'failure');

const BackupQueued = H.state('BackupQueued', 'pending');
const BackedUp = H.state('BackedUp', 'terminal', 'success');
const BackupFailed = H.state('BackupFailed', 'terminal', 'failure');

const RenewalDue = H.state('RenewalDue', 'pending');
const Renewed = H.state('Renewed', 'terminal', 'success');
const NotYetDue = H.state('NotYetDue', 'terminal', 'neutral');
const RenewalFailed = H.state('RenewalFailed', 'terminal', 'failure');

const IncidentOpen = H.state('IncidentOpen', 'pending');
const IncidentAcknowledged = H.state('IncidentAcknowledged', 'active');
const IncidentResolved = H.state('IncidentResolved', 'terminal', 'success');

const Heartbeat = H.work('Heartbeat')
  .attributes({ service: z.string(), due: z.number() })
  .states([HeartbeatDue, Up, Down])
  .key((u) => `${u.attributes.service}@${u.attributes.due}`);

const Backup = H.work('Backup')
  .attributes({ database: z.string(), night: z.number() })
  .states([BackupQueued, BackedUp, BackupFailed])
  .key((u) => `${u.attributes.database}@${u.attributes.night}`);

const CertificateRenewal = H.work('CertificateRenewal')
  .attributes({ domain: z.string(), week: z.number() })
  .states([RenewalDue, Renewed, NotYetDue, RenewalFailed])
  .key((u) => `${u.attributes.domain}@${u.attributes.week}`);

const Incident = H.work('Incident')
  .attributes({ subject: z.string(), source: z.string(), detail: z.string() })
  .states([IncidentOpen, IncidentAcknowledged, IncidentResolved])
  .key((u) => `${u.attributes.source}:${u.attributes.subject}`);

const opsExperience = H.memory.experience('ops-experience');
const opsJournal = H.journal('ops-journal', opsExperience).store(jsonl.memory('memory/ops.jsonl'));

const healthCheck = H.command('health-check', ['./bin/health']);
const dumpDatabase = H.command('dump-database', ['./bin/backup']);
const diskSpace = H.command('disk-space', ['./bin/check-disk', '--min-free-gb', '50']);
const certificateDays = H.command('certificate-days', ['./bin/cert-days']).parses({ daysLeft: z.number() });
const renewCertificate = H.command('renew-certificate', ['./bin/renew-cert']);
const pageOnCall = H.command('page-on-call', ['./bin/page']);
const runbook = H.command('runbook', ['./runbooks/run']);

const acknowledgement = H.decision('incident-acknowledgement', { acknowledgedBy: z.string() });
const resolution = H.decision('incident-resolution', { resolved: z.boolean(), notes: z.string() });

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .step('probe', healthCheck, (c) => ({ args: [c.input.service] }), { timeoutMs: 30_000, restart: 'rerun' })
  .ends(['up'], () => 'up');

const backupFlow = H.flow('backup')
  .requires({ database: z.string() })
  .step('dump', dumpDatabase, (c) => ({ args: [c.input.database] }), { timeoutMs: 6 * 60 * 60 * 1000, restart: 'rerun' })
  .ends(['backedUp'], () => 'backedUp');

const renewalFlow = H.flow('certificate-renewal')
  .requires({ domain: z.string() })
  .step('check', certificateDays, (c) => ({ args: [c.input.domain] }), { restart: 'rerun' })
  .exit('notYetDue', (c) => c.out.check.data.daysLeft >= 14)
  .step('renew', renewCertificate, (c) => ({ args: [c.input.domain] }), { restart: 'rerun' })
  .ends(['renewed'], () => 'renewed');

const incidentFlow = H.flow('incident-runbook')
  .requires({ subject: z.string(), detail: z.string() })
  .step('page', pageOnCall, (c) => ({ args: [c.input.subject] }), { restart: 'park' })
  .halt('acknowledge', acknowledgement, { ask: (c) => `Acknowledge incident: ${c.input.subject}\n\n${c.input.detail}` })
  .mark('acknowledged')
  .step('runbook', runbook, (c) => ({ args: [c.input.subject] }), { onFailure: 'halt', restart: 'park' })
  .halt('resolution', resolution, {
    ask: (c) => `Runbook for ${c.input.subject} exited ${c.out.runbook.exitCode}. Is the incident resolved?`,
  })
  .ends(['resolved', 'reopened'], (c) => (c.out.resolution.resolved ? 'resolved' : 'reopened'));

const localShell = local.shell({ slots: 4 });
const hosts = ssh.hosts({
  hosts: [
    { host: 'db-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
    { host: 'db-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
  ],
  slotsPerHost: 1,
});

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .supply([
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), (c) =>
      services.map((service) => ({ create: { attributes: { service, due: c.now } } })),
    ),
  ])
  .runner(localShell)
  .handler(heartbeatFlow, { states: { up: Up, failed: Down } });

const backupLane = H.lane('backups', Backup)
  .supply([
    H.supply.schedule(Backup, H.time.daily('01:00', 'UTC'), (c) =>
      databases.map((database) => ({ create: { attributes: { database, night: c.now } } })),
    ),
  ])
  .store(sqlite.store(Backup, 'state/ops.sqlite'))
  .runner(hosts)
  .preflight(diskSpace)
  .handler(backupFlow, { states: { backedUp: BackedUp, failed: BackupFailed } });

const renewalLane = H.lane('certificate-renewals', CertificateRenewal)
  .supply([
    H.supply.schedule(CertificateRenewal, H.time.weekly('mon', '03:00', 'UTC'), (c) =>
      domains.map((domain) => ({ create: { attributes: { domain, week: c.now } } })),
    ),
  ])
  .store(sqlite.store(CertificateRenewal, 'state/ops.sqlite'))
  .runner(hosts)
  .preflight(diskSpace)
  .handler(renewalFlow, { states: { notYetDue: NotYetDue, renewed: Renewed, failed: RenewalFailed } });

const incidentLane = H.lane('incidents', Incident)
  .supply([H.supply.operator()])
  .store(sqlite.store(Incident, 'state/ops.sqlite'))
  .runner(localShell)
  .handler(incidentFlow, {
    states: { acknowledged: IncidentAcknowledged, resolved: IncidentResolved, reopened: IncidentOpen, failed: IncidentOpen },
  });

const heartbeatStreakOpensIncident = H.trigger(
  'heartbeat-streak-opens-incident',
  H.on.streak(heartbeatLane, { verdict: 'failure', count: 3, per: 'service' }),
).creates((e) =>
  incidentLane.unit({
    attributes: {
      subject: e.unit.attributes.service,
      source: 'heartbeat',
      detail: `${e.count} consecutive failed heartbeats for ${e.unit.attributes.service}`,
    },
  }),
);

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident', H.on.transition(backupLane, { to: [BackupFailed] }))
  .creates((e) =>
    incidentLane.unit({
      attributes: {
        subject: e.unit.attributes.database,
        source: 'backup',
        detail: `Backup of ${e.unit.attributes.database} failed at ${new Date(e.unit.updatedAt).toISOString()}`,
      },
    }),
  );

const slowBackupNoted = H.trigger('slow-backup-noted', H.on.transition(backupLane, { to: [BackedUp] }))
  .where((e) => (e.attempt === null ? 0 : e.attempt.durationMs) > slowBackupMs)
  .records(opsJournal, (e) => [
    {
      rule: `When scheduling the backup of ${e.unit.attributes.database}, start it earlier or move it to the idle host`,
      because: `the backup finishing at ${new Date(e.unit.updatedAt).toISOString()} took ${Math.round((e.attempt === null ? 0 : e.attempt.durationMs) / 60_000)} minutes`,
      when: { kinds: [Backup], attributes: { database: e.unit.attributes.database } },
    },
  ]);

const incidentNotifiesSlack = H.trigger('incident-notifies-slack', H.on.transition(incidentLane))
  .invokes(slack.notify('ops-channel', { webhookUrl: H.env('SLACK_WEBHOOK_URL') }), (e) => ({
    text: `Incident ${e.unit.attributes.subject} (${e.unit.attributes.source}): ${e.from ?? 'created'} -> ${e.to}`,
  }));

const incidentsPreempt = H.policy.schedule('incidents-preempt', (c) => {
  const incidentWaiting = c.candidates.some((x) => x.entry.lane === incidentLane.name);
  const incidentActive = c.open.some((a) => c.inLane(a, incidentLane));
  return {
    start: c.candidates
      .filter((x) => !(x.entry.lane === backupLane.name && (incidentActive || incidentWaiting)))
      .map((x) => ({ x, rank: x.entry.lane === incidentLane.name ? 0 : 1 }))
      .sort((a, b) => a.rank - b.rank || b.x.waitedMs - a.x.waitedMs)
      .map((p) => p.x),
    preempt: incidentWaiting
      ? c.open.filter((a) => a.status === 'running' && !c.inLane(a, backupLane) && !c.inLane(a, incidentLane))
      : [],
  };
});

const operatorAccess = H.access('operator-http').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('state/ledger.sqlite'))
  .lanes([heartbeatLane, backupLane, renewalLane, incidentLane])
  .triggers([heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupNoted, incidentNotifiesSlack])
  .schedule(incidentsPreempt)
  .clients([http.server('operator-http', operatorAccess, { port: H.slot.port(0), token: H.env('OPS_API_TOKEN') })])
  .projections([markdown.board('BOARD.md')]);
