import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as markdown from 'harness-dsl/markdown';
import * as http from 'harness-dsl/http';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as slack from 'harness-dsl/slack';

const twoHoursMs = 2 * 60 * 60 * 1000;

export const HeartbeatDue = H.state('HeartbeatDue', 'pending');
export const Probing = H.state('Probing', 'active');
export const Up = H.state('Up', 'terminal', 'success');
export const Down = H.state('Down', 'terminal', 'failure');

export const BackupDue = H.state('BackupDue', 'pending');
export const BackingUp = H.state('BackingUp', 'active');
export const BackedUp = H.state('BackedUp', 'terminal', 'success');
export const BackupFailed = H.state('BackupFailed', 'terminal', 'failure');

export const RenewalDue = H.state('RenewalDue', 'pending');
export const CheckingCertificate = H.state('CheckingCertificate', 'active');
export const StillValid = H.state('StillValid', 'terminal', 'success');
export const Renewed = H.state('Renewed', 'terminal', 'success');
export const RenewalFailed = H.state('RenewalFailed', 'terminal', 'failure');

export const IncidentOpen = H.state('IncidentOpen', 'pending');
export const Responding = H.state('Responding', 'active');
export const IncidentResolved = H.state('IncidentResolved', 'terminal', 'success');

export const Heartbeat = H.work('Heartbeat')
  .attributes({ service: z.string(), due: z.number() })
  .states([HeartbeatDue, Probing, Up, Down])
  .onFailure(Down)
  .key(u => `${u.attributes.service}@${u.attributes.due}`);

export const Backup = H.work('Backup')
  .attributes({ database: z.string(), due: z.number() })
  .states([BackupDue, BackingUp, BackedUp, BackupFailed])
  .onFailure(BackupFailed)
  .key(u => `${u.attributes.database}@${u.attributes.due}`);

export const CertificateRenewal = H.work('CertificateRenewal')
  .attributes({ domain: z.string(), due: z.number() })
  .states([RenewalDue, CheckingCertificate, StillValid, Renewed, RenewalFailed])
  .onFailure(RenewalFailed)
  .key(u => `${u.attributes.domain}@${u.attributes.due}`);

export const Incident = H.work('Incident')
  .attributes({ ref: z.string(), service: z.string(), title: z.string(), runbook: z.string() })
  .states([IncidentOpen, Responding, IncidentResolved])
  .key(u => u.attributes.ref);

export const probeService = H.command('probe-service', ['./bin/probe-service']);
export const backupDatabase = H.command('backup-database', ['./bin/backup-database']);
export const diskSpace = H.command('disk-space', ['./bin/check-disk', '--min-free-gb', '50']);
export const certificateDaysLeft = H.command('certificate-days-left', ['./bin/cert-days-left']).parses({
  daysLeft: z.number(),
});
export const renewCertificate = H.command('renew-certificate', ['./bin/renew-cert']);
export const pageOncall = H.command('page-oncall', ['./bin/page-oncall']);
export const runRunbook = H.command('run-runbook', ['./bin/run-runbook']);

export const acknowledgement = H.decision('incident-acknowledgement', { acknowledgedBy: z.string() });
export const resolution = H.decision('incident-resolution', { resolved: z.boolean(), notes: z.string() });

export const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .step('probe', probeService, c => ({ args: [c.input.service] }), { timeoutMs: 30000, restart: 'rerun' })
  .ends(['up'], () => 'up');

export const backupFlow = H.flow('backup')
  .requires({ database: z.string() })
  .step('backup', backupDatabase, c => ({ args: [c.input.database] }), { restart: 'rerun' })
  .ends(['backedUp'], () => 'backedUp');

export const renewalFlow = H.flow('certificate-renewal')
  .requires({ domain: z.string() })
  .step('check', certificateDaysLeft, c => ({ args: [c.input.domain] }), { restart: 'rerun' })
  .exit('stillValid', c => c.out.check.data.daysLeft >= 14)
  .step('renew', renewCertificate, c => ({ args: [c.input.domain] }), { restart: 'rerun' })
  .ends(['renewed'], () => 'renewed');

export const runbookFlow = H.flow('incident-runbook')
  .requires({ title: z.string(), runbook: z.string() })
  .step('page', pageOncall, c => ({ args: [c.input.title] }))
  .halt('acknowledge', acknowledgement, { ask: c => `Acknowledge incident: ${c.input.title}` })
  .step('runbook', runRunbook, c => ({ args: [c.input.runbook] }), { onFailure: 'halt' })
  .halt('confirm', resolution, {
    ask: c => `Runbook ${c.input.runbook} exited ${c.out.runbook.exitCode}. Is "${c.input.title}" resolved?`,
  })
  .ends(['resolved', 'reopened'], c => (c.out.confirm.resolved ? 'resolved' : 'reopened'));

const services = ['api', 'worker', 'gateway'];
const databases = ['orders', 'users'];
const domains = ['example.com', 'api.example.com'];

export const localShell = local.shell({ slots: 4 });
export const opsHosts = ssh.hosts({
  hosts: [
    { host: 'ops-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
    { host: 'ops-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
  ],
  slotsPerHost: 1,
});

export const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply([
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), c =>
      services.map(service => ({ create: { attributes: { service, due: c.now } } })),
    ),
  ])
  .handler(heartbeatFlow, { outcomes: { up: Up } })
  .runner(localShell);

export const backups = H.lane('backups', Backup)
  .supply([
    H.supply.schedule(Backup, H.time.daily('01:00', 'UTC'), c =>
      databases.map(database => ({ create: { attributes: { database, due: c.now } } })),
    ),
  ])
  .handler(backupFlow, { outcomes: { backedUp: BackedUp } })
  .runner(opsHosts)
  .preflight(diskSpace);

export const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply([
    H.supply.schedule(CertificateRenewal, H.time.weekly('mon', '06:00', 'UTC'), c =>
      domains.map(domain => ({ create: { attributes: { domain, due: c.now } } })),
    ),
  ])
  .handler(renewalFlow, { outcomes: { stillValid: StillValid, renewed: Renewed } })
  .runner(opsHosts)
  .preflight(diskSpace);

export const incidents = H.lane('incidents', Incident)
  .supply([H.supply.operator()])
  .handler(runbookFlow, { outcomes: { resolved: IncidentResolved, reopened: IncidentOpen } })
  .runner(localShell);

export const OperationalExperience = H.memory.experience('operational-experience');
export const opsJournal = H.journal('operational-experience', OperationalExperience).store(
  jsonl.memory('memory/operations.jsonl'),
);

export const slackOps = slack.notify('ops-channel', { webhookUrl: H.env('SLACK_OPS_WEBHOOK_URL') });

export const failingHeartbeatsOpenIncident = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(heartbeats, { verdict: 'failure', count: 3, per: 'service' }),
).creates(e =>
  incidents.unit({
    attributes: {
      ref: `heartbeat:${e.unit.attributes.service}@${e.unit.attributes.due}`,
      service: e.unit.attributes.service,
      title: `${e.unit.attributes.service} failed ${e.count} heartbeats in a row`,
      runbook: 'restart-service',
    },
  }),
);

export const failedBackupOpensIncident = H.trigger(
  'failed-backup-opens-incident',
  H.on.transition(backups, { to: [BackupFailed] }),
).creates(e =>
  incidents.unit({
    attributes: {
      ref: `backup:${e.unit.attributes.database}@${e.unit.attributes.due}`,
      service: e.unit.attributes.database,
      title: `Backup of ${e.unit.attributes.database} failed`,
      runbook: 'retry-backup',
    },
  }),
);

export const slowBackupNoted = H.trigger('slow-backup-noted', H.on.transition(backups, { to: [BackedUp] }))
  .where(e => e.attempt !== null && e.attempt.durationMs > twoHoursMs)
  .records(opsJournal, e => [
    {
      rule: `When scheduling the backup of ${e.unit.attributes.database}, expect it to run past two hours and keep the window clear`,
      because: `the backup due at ${new Date(e.unit.attributes.due).toISOString()} took ${Math.round((e.attempt === null ? 0 : e.attempt.durationMs) / 60000)} minutes`,
      when: { kinds: [Backup], attributes: { database: e.unit.attributes.database } },
    },
  ]);

export const incidentToSlack = H.trigger('incident-transition-to-slack', H.on.transition(incidents)).invokes(
  slackOps,
  e => ({ text: `Incident "${e.unit.attributes.title}": ${e.from ?? 'created'} -> ${e.to}` }),
);

const rank = (x: Candidate) =>
  x.unit.is(incidents) ? 0 : x.unit.is(heartbeats) ? 1 : x.unit.is(renewals) ? 2 : 3;

export const incidentsPreempt = H.policy.schedule('incidents-preempt', c => {
  const incidentWaiting = c.candidates.some(x => x.unit.is(incidents));
  const incidentActive = c.open.some(o => o.unit.is(incidents));
  const start = c.candidates
    .filter(x => (incidentActive && x.unit.is(backups)) === false)
    .slice()
    .sort((a, b) => rank(a) - rank(b) || a.entry.enqueuedAt - b.entry.enqueuedAt);
  const preempt = incidentWaiting
    ? c.open.filter(o => o.attempt.status === 'running' && o.unit.is(backups) === false && o.unit.is(incidents) === false)
    : [];
  return { start, preempt };
});

export const operatorAccess = H.access('platform-operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readMemory,
  H.ops.readTelemetry,
]);

export const httpApi = http.server('ops-http-api', operatorAccess, {
  port: H.slot.port(0),
  token: H.env('OPS_API_TOKEN'),
});

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/operations.db'))
  .lanes([incidents, heartbeats, backups, renewals])
  .triggers([failingHeartbeatsOpenIncident, failedBackupOpensIncident, slowBackupNoted, incidentToSlack])
  .schedule(incidentsPreempt)
  .projections([markdown.board('BOARD.md')]);

export const control = H.control('operations-control', harness).clients([httpApi]);
