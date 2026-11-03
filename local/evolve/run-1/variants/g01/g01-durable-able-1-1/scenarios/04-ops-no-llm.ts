import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as slack from 'harness-dsl/slack';

const ProbeDue = H.state.pending('ProbeDue');
const Probing = H.state.active('Probing');
const Up = H.state.terminal('Up', 'success');
const Down = H.state.terminal('Down', 'failure');

const BackupDue = H.state.pending('BackupDue');
const BackingUp = H.state.active('BackingUp');
const BackedUp = H.state.terminal('BackedUp', 'success');
const BackupFailed = H.state.terminal('BackupFailed', 'failure');

const CheckDue = H.state.pending('CheckDue');
const Checking = H.state.active('Checking');
const StillValid = H.state.terminal('StillValid', 'success');
const Renewed = H.state.terminal('Renewed', 'success');
const RenewalFailed = H.state.terminal('RenewalFailed', 'failure');

const Reported = H.state.pending('Reported');
const AwaitingAck = H.state.active('AwaitingAck');
const Remediating = H.state.active('Remediating');
const Confirming = H.state.active('Confirming');
const Reopened = H.state.pending('Reopened');
const Resolved = H.state.terminal('Resolved', 'success');

export const Heartbeat = H.work('Heartbeat')
  .attributes({ service: z.string(), url: z.string() })
  .states([ProbeDue, Probing, Up, Down])
  .key(u => u.attributes.service);

export const Backup = H.work('Backup')
  .attributes({ database: z.string() })
  .states([BackupDue, BackingUp, BackedUp, BackupFailed])
  .key(u => u.attributes.database);

export const CertificateRenewal = H.work('CertificateRenewal')
  .attributes({ domain: z.string() })
  .states([CheckDue, Checking, StillValid, Renewed, RenewalFailed])
  .key(u => u.attributes.domain);

export const Incident = H.work('Incident')
  .attributes({ title: z.string(), source: z.string() })
  .states([Reported, AwaitingAck, Remediating, Confirming, Reopened, Resolved])
  .key(u => u.attributes.source);

const probe = H.command('probe', ['curl', '--fail', '--silent', '--max-time', '20']);
const backupDatabase = H.command('backup-database', ['/opt/ops/backup.sh']);
const certDaysLeft = H.command('cert-days-left', ['/opt/ops/cert-days-left.sh']).parses({ daysLeft: z.number() });
const renewCertificate = H.command('renew-certificate', ['/opt/ops/renew-certificate.sh']);
const incidentRunbook = H.command('incident-runbook', ['/opt/ops/runbook.sh']);
const diskSpacePreflight = H.command('disk-space-preflight', ['/opt/ops/check-free-space.sh', '--min-free-gb', '50']);

const shell = local.shell({ slots: 4 });
const opsHosts = ssh.hosts({
  hosts: [
    { host: 'db-1.internal', user: 'ops', key: H.env('SSH_KEY_DB_1') },
    { host: 'db-2.internal', user: 'ops', key: H.env('SSH_KEY_DB_2') },
  ],
  slotsPerHost: 1,
});

const heartbeatFlow = H.flow('heartbeat')
  .requires({ url: z.string() })
  .mark('probing')
  .step('probe', probe, c => ({ args: [c.input.url] }), { timeoutMs: 30_000, onRestart: 'rerun' })
  .ends(['up', 'down'], c => (c.out.probe.exitCode === 0 ? 'up' : 'down'));

const backupFlow = H.flow('nightly-backup')
  .requires({ database: z.string() })
  .mark('backingUp')
  .step('backup', backupDatabase, c => ({ args: [c.input.database] }), { timeoutMs: 6 * 60 * 60 * 1000, onRestart: 'park' })
  .ends(['backedUp'], () => 'backedUp');

const renewalFlow = H.flow('certificate-renewal')
  .requires({ domain: z.string() })
  .mark('checking')
  .step('check', certDaysLeft, c => ({ args: [c.input.domain] }), { onRestart: 'rerun' })
  .exit('stillValid', c => c.out.check.data.daysLeft >= 14)
  .step('renew', renewCertificate, c => ({ args: [c.input.domain] }), { onRestart: 'park' })
  .ends(['renewed'], () => 'renewed');

const incidentFlow = H.flow('incident-runbook')
  .requires({ title: z.string(), source: z.string() })
  .mark('awaitingAck')
  .halt('acknowledge', {
    ask: c => `Incident: ${c.input.title}. Acknowledge to run the runbook.`,
    decision: { responder: z.string() },
  })
  .mark('remediating')
  .step('runbook', incidentRunbook, c => ({ args: [c.input.source] }), { onFailure: 'halt', onRestart: 'park' })
  .mark('confirming')
  .halt('confirm', {
    ask: c => `The runbook exited ${c.out.runbook.exitCode}. Is "${c.input.title}" resolved?`,
    decision: { resolved: z.boolean(), notes: z.string() },
  })
  .ends(['resolved', 'reopened'], c => (c.out.confirm.resolved ? 'resolved' : 'reopened'));

const services = [
  { service: 'api', url: 'https://api.internal/health' },
  { service: 'queue', url: 'https://queue.internal/health' },
];
const databases = ['orders', 'customers'];
const domains = ['example.com', 'api.example.com'];

export const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply([H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), () => services.map(s => ({ create: { attributes: s } })))])
  .handler(heartbeatFlow, { states: { probing: Probing, up: Up, down: Down, failed: Down } })
  .runner(shell);

export const backups = H.lane('backups', Backup)
  .supply([
    H.supply.schedule(Backup, H.time.daily('01:00', 'UTC'), () =>
      databases.map(database => ({ create: { attributes: { database } } })),
    ),
  ])
  .handler(backupFlow, { states: { backingUp: BackingUp, backedUp: BackedUp, failed: BackupFailed } })
  .runner(opsHosts)
  .preflight(diskSpacePreflight);

export const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply([
    H.supply.schedule(CertificateRenewal, H.time.weekly('mon', '03:00', 'UTC'), () =>
      domains.map(domain => ({ create: { attributes: { domain } } })),
    ),
  ])
  .handler(renewalFlow, { states: { checking: Checking, stillValid: StillValid, renewed: Renewed, failed: RenewalFailed } })
  .runner(opsHosts)
  .preflight(diskSpacePreflight);

export const incidents = H.lane('incidents', Incident)
  .supply([H.supply.operator()])
  .handler(incidentFlow, {
    states: {
      awaitingAck: AwaitingAck,
      remediating: Remediating,
      confirming: Confirming,
      resolved: Resolved,
      reopened: Reopened,
      failed: Reopened,
    },
  })
  .runner(shell);

const operationalExperience = H.journal('operational-experience', H.memory.experience('operational-experience'))
  .store(jsonl.memory('memory/operations.jsonl'));

const twoHoursMs = 2 * 60 * 60 * 1000;

const heartbeatStreakOpensIncident = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(heartbeats, { verdict: 'failure', count: 3, per: 'service' }),
).creates(incidents, e => ({
  attributes: {
    title: `${e.unit.attributes.service} failed ${e.count} consecutive heartbeats`,
    source: `heartbeat:${e.unit.attributes.service}`,
  },
}));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident', H.on.transition(backups, { verdict: ['failure'] }))
  .creates(incidents, e => ({
    attributes: { title: `Backup of ${e.unit.attributes.database} failed`, source: `backup:${e.unit.attributes.database}` },
  }));

const slowBackupBecomesExperience = H.trigger('slow-backup-becomes-experience', H.on.transition(backups, { verdict: ['success'] }))
  .where(e => e.attempt !== null && e.attempt.durationMs > twoHoursMs)
  .records(operationalExperience, e => [
    {
      rule: `When planning maintenance near the ${e.unit.attributes.database} backup window, allow more than two hours for the backup`,
      because: `the backup succeeded but took ${Math.round((e.attempt ? e.attempt.durationMs : 0) / 60_000)} minutes`,
      when: { kinds: [Backup], attributes: { database: e.unit.attributes.database } },
    },
  ]);

const incidentChannel = slack.notify('incident-channel', { webhookUrl: H.env('SLACK_INCIDENT_WEBHOOK') });

const incidentTransitionsToSlack = H.trigger('incident-transitions-to-slack', H.on.transition(incidents))
  .invokes(incidentChannel, e => ({
    text: `Incident "${e.unit.attributes.title}": ${e.from ?? 'new'} → ${e.to}`,
  }));

const incidentsPreempt = H.policy.schedule('incidents-preempt', c => {
  const incidentPending = c.candidates.some(x => x.is(incidents));
  const incidentActive = incidentPending || c.open.some(a => c.inLane(a, incidents));
  const rank = (x: (typeof c.candidates)[number]) => (x.is(incidents) ? 0 : 1);
  return {
    start: c.candidates.filter(x => !(incidentActive && x.is(backups))).sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
    preempt: incidentPending ? c.open.filter(a => c.inLane(a, heartbeats)) : [],
  };
});

const operatorAccess = H.access('operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.recoverAttempts,
  H.ops.readMemory,
  H.ops.readTelemetry,
]);

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ops.db'))
  .lanes([incidents, heartbeats, backups, renewals])
  .triggers([heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupBecomesExperience, incidentTransitionsToSlack])
  .schedule(incidentsPreempt)
  .clients([http.server('control-api', operatorAccess, { port: H.slot.port(0), token: H.env('CONTROL_API_TOKEN') })])
  .projections([markdown.board('BOARD.md')]);
