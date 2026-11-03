import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as http from 'harness-dsl/http';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const HeartbeatChecking = H.state('HeartbeatChecking', 'active');
const HeartbeatPassed = H.state('HeartbeatPassed', 'terminal', 'success');
const HeartbeatFailed = H.state('HeartbeatFailed', 'terminal', 'failure');

const BackupDue = H.state('BackupDue', 'pending');
const BackingUp = H.state('BackingUp', 'active');
const BackedUp = H.state('BackedUp', 'terminal', 'success');
const BackupFailed = H.state('BackupFailed', 'terminal', 'failure');

const RenewalDue = H.state('RenewalDue', 'pending');
const RenewalChecking = H.state('RenewalChecking', 'active');
const Renewing = H.state('Renewing', 'active');
const CertificateValid = H.state('CertificateValid', 'terminal', 'success');
const CertificateRenewed = H.state('CertificateRenewed', 'terminal', 'success');
const RenewalFailed = H.state('RenewalFailed', 'terminal', 'failure');

const IncidentOpen = H.state('IncidentOpen', 'pending');
const Responding = H.state('Responding', 'active');
const AwaitingAcknowledgement = H.state('AwaitingAcknowledgement', 'waiting');
const AwaitingResolution = H.state('AwaitingResolution', 'waiting');
const IncidentResolved = H.state('IncidentResolved', 'terminal', 'success');
const IncidentUnresolved = H.state('IncidentUnresolved', 'terminal', 'failure');

const Heartbeat = H.work('Heartbeat')
  .attributes({ service: z.string(), dueAt: z.number() })
  .states([HeartbeatDue, HeartbeatChecking, HeartbeatPassed, HeartbeatFailed])
  .failsTo(HeartbeatFailed)
  .key(u => `${u.attributes.service}@${u.attributes.dueAt}`);

const Backup = H.work('Backup')
  .attributes({ database: z.string(), night: z.string() })
  .states([BackupDue, BackingUp, BackedUp, BackupFailed])
  .failsTo(BackupFailed)
  .key(u => `${u.attributes.database}@${u.attributes.night}`);

const CertificateRenewal = H.work('CertificateRenewal')
  .attributes({ domain: z.string(), week: z.string() })
  .states([RenewalDue, RenewalChecking, Renewing, CertificateValid, CertificateRenewed, RenewalFailed])
  .failsTo(RenewalFailed)
  .key(u => `${u.attributes.domain}@${u.attributes.week}`);

const Incident = H.work('Incident')
  .attributes({ service: z.string(), title: z.string(), origin: z.string() })
  .states([IncidentOpen, Responding, AwaitingAcknowledgement, AwaitingResolution, IncidentResolved, IncidentUnresolved])
  .failsTo(IncidentUnresolved)
  .key(u => u.attributes.origin);

const healthCheck = H.command('healthCheck', ['./ops/health-check.sh']);
const dumpDatabase = H.command('dumpDatabase', ['./ops/backup.sh']);
const diskSpace = H.command('diskSpace', ['./ops/check-disk-space.sh', '--min-free-gb', '50']);
const certificateDays = H.command('certificateDays', ['./ops/cert-days-left.sh']).parses({ daysLeft: z.number() });
const renewCertificate = H.command('renewCertificate', ['./ops/renew-cert.sh']);
const runbook = H.command('runbook', ['./ops/runbook.sh']);

const acknowledgement = H.decision('acknowledgement', { by: z.string() });
const resolution = H.decision('resolution', { notes: z.string() });

const shell = local.shell({ slots: 4 });
const hosts = ssh.hosts({
  hosts: [
    { host: 'db1.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
    { host: 'db2.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
  ],
  slotsPerHost: 1,
});

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .step('probe', healthCheck, c => ({ args: [c.input.service] }), { timeoutMs: 30_000, restart: 'rerun' })
  .ends(['passed'], () => 'passed');

const backupFlow = H.flow('backup')
  .requires({ database: z.string() })
  .step('dump', dumpDatabase, c => ({ args: [c.input.database] }), { timeoutMs: 6 * 3_600_000 })
  .ends(['backedUp'], () => 'backedUp');

const renewalFlow = H.flow('renewal')
  .requires({ domain: z.string() })
  .step('check', certificateDays, c => ({ args: [c.input.domain] }), { restart: 'rerun' })
  .exit('valid', c => c.out.check.data.daysLeft >= 14)
  .step('renew', renewCertificate, c => ({ args: [c.input.domain] }))
  .ends(['renewed'], () => 'renewed');

const incidentFlow = H.flow('incident')
  .requires({ service: z.string(), title: z.string() })
  .halt('acknowledge', acknowledgement, { ask: c => `Incident on ${c.input.service}: ${c.input.title}. Acknowledge to run the runbook.` })
  .step('runbook', runbook, c => ({ args: [c.input.service] }), { onFailure: 'halt' })
  .halt('confirm', resolution, { ask: c => `Runbook finished for ${c.input.service}. Confirm the incident is resolved.` })
  .ends(['resolved'], () => 'resolved');

const services = ['api', 'web', 'queue'];
const databases = ['orders', 'users'];
const domains = ['example.com', 'api.example.com'];
const day = (now: number) => new Date(now).toISOString().slice(0, 10);

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply([
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), (c, supply) =>
      services.map(service => supply.create({ attributes: { service, dueAt: c.now } }))),
  ])
  .handler(heartbeatFlow, { opens: HeartbeatChecking, ends: { passed: HeartbeatPassed } })
  .runner(shell);

const backups = H.lane('backups', Backup)
  .supply([
    H.supply.schedule(Backup, H.time.daily('01:00'), (c, supply) =>
      databases.map(database => supply.create({ attributes: { database, night: day(c.now) } }))),
  ])
  .store(sqlite.store(Backup, '.harness/ops-work.db'))
  .handler(backupFlow, { opens: BackingUp, ends: { backedUp: BackedUp } })
  .runner(hosts)
  .preflight(diskSpace);

const renewals = H.lane('renewals', CertificateRenewal)
  .supply([
    H.supply.schedule(CertificateRenewal, H.time.weekly('sun', '03:00'), (c, supply) =>
      domains.map(domain => supply.create({ attributes: { domain, week: day(c.now) } }))),
  ])
  .store(sqlite.store(CertificateRenewal, '.harness/ops-work.db'))
  .handler(renewalFlow, {
    opens: RenewalChecking,
    progress: { renew: Renewing },
    ends: { valid: CertificateValid, renewed: CertificateRenewed },
  })
  .runner(hosts)
  .preflight(diskSpace);

const incidents = H.lane('incidents', Incident)
  .supply([H.supply.operator()])
  .store(sqlite.store(Incident, '.harness/ops-work.db'))
  .handler(incidentFlow, {
    opens: Responding,
    halts: { acknowledge: AwaitingAcknowledgement, confirm: AwaitingResolution },
    ends: { resolved: IncidentResolved },
  })
  .runner(shell);

const Operations = H.memory.experience('operations');
const operations = H.journal('operations', Operations).store(jsonl.memory('.harness/operations.jsonl'));

const heartbeatStreak = H.trigger('heartbeatStreak',
  H.on.streak(heartbeats, { verdict: 'failure', count: 3, per: 'service' }))
  .creates(e => incidents.unit({
    attributes: {
      service: e.unit.attributes.service,
      title: `${e.count} consecutive failed heartbeats`,
      origin: `heartbeat:${e.unit.key}`,
    },
  }));

const backupFailed = H.trigger('backupFailed', H.on.transition(backups, { to: [BackupFailed] }))
  .creates(e => incidents.unit({
    attributes: {
      service: e.unit.attributes.database,
      title: `Backup of ${e.unit.attributes.database} failed`,
      origin: `backup:${e.unit.key}`,
    },
  }));

const slowBackupMs = 2 * 3_600_000;

const slowBackup = H.trigger('slowBackup', H.on.transition(backups, { to: [BackedUp] }))
  .where(e => (e.attempt?.durationMs ?? 0) > slowBackupMs)
  .records(operations, e => [{
    rule: `When the ${e.unit.attributes.database} backup is due, check its size growth first`,
    because: `the backup of ${e.unit.attributes.night} took ${Math.round((e.attempt?.durationMs ?? 0) / 60_000)} minutes`,
    when: { kinds: [Backup], attributes: { database: e.unit.attributes.database } },
  }]);

const incidentNotice = slack.notify('incidentNotice', { webhookUrl: H.env('SLACK_WEBHOOK_URL') });

const incidentTransitions = H.trigger('incidentTransitions', H.on.transition(incidents))
  .invokes(incidentNotice, e => ({
    text: `Incident ${e.unit.key} (${e.unit.attributes.service}): ${e.from ? e.from.name : 'new'} → ${e.to.name}`,
  }));

const incidentsFirst = H.policy.schedule('incidentsFirst', c => {
  const incidentWaiting = c.candidates.some(k => k.is(incidents));
  const incidentActive = incidentWaiting || c.open.some(a => a.is(incidents));
  return {
    start: c
      .order(k => (k.is(incidents) ? 0 : k.is(heartbeats) ? 1 : 2), k => k.enqueuedAt)
      .filter(k => !(incidentActive && k.is(backups))),
    preempt: incidentWaiting ? c.open.filter(a => !a.is(backups) && !a.is(incidents)) : [],
  };
});

const operatorAccess = H.access('operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readMemory,
  H.ops.readTelemetry,
]);

export const operationsHarness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ops.db'))
  .lanes([heartbeats, backups, renewals, incidents])
  .triggers([heartbeatStreak, backupFailed, slowBackup, incidentTransitions])
  .schedule(incidentsFirst)
  .clients([http.server('operatorApi', operatorAccess, { port: H.slot.port(0), token: H.env('OPS_API_TOKEN') })])
  .projections([markdown.board('BOARD.md')]);
