import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as http from 'harness-dsl/http';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const Due = H.state('Due', 'pending');
const InProgress = H.state('InProgress', 'active');

const Healthy = H.state('Healthy', 'terminal', 'success');
const Unhealthy = H.state('Unhealthy', 'terminal', 'failure');
const BackedUp = H.state('BackedUp', 'terminal', 'success');
const BackupFailed = H.state('BackupFailed', 'terminal', 'failure');
const StillValid = H.state('StillValid', 'terminal', 'success');
const Renewed = H.state('Renewed', 'terminal', 'success');
const RenewalFailed = H.state('RenewalFailed', 'terminal', 'failure');
const Reported = H.state('Reported', 'pending');
const Responding = H.state('Responding', 'active');
const Resolved = H.state('Resolved', 'terminal', 'success');
const Unresolved = H.state('Unresolved', 'terminal', 'failure');

const Heartbeat = H.work('Heartbeat')
  .attributes({ service: z.string(), at: z.number() })
  .states([Due, InProgress, Healthy, Unhealthy])
  .fails(Unhealthy)
  .key(u => `${u.attributes.service}@${u.attributes.at}`);

const Backup = H.work('Backup')
  .attributes({ database: z.string(), night: z.string() })
  .states([Due, InProgress, BackedUp, BackupFailed])
  .fails(BackupFailed)
  .key(u => `${u.attributes.database}@${u.attributes.night}`);

const CertificateRenewal = H.work('CertificateRenewal')
  .attributes({ domain: z.string(), at: z.number() })
  .states([Due, InProgress, StillValid, Renewed, RenewalFailed])
  .fails(RenewalFailed)
  .key(u => `${u.attributes.domain}@${u.attributes.at}`);

const Incident = H.work('Incident')
  .attributes({ ref: z.string(), summary: z.string(), origin: z.string() })
  .states([Reported, Responding, Resolved, Unresolved])
  .key(u => u.attributes.ref);

const operational = H.memory.experience('operational-experience');
const opsJournal = H.journal('ops-experience', operational).store(jsonl.memory('memory/ops.jsonl'));

const Acknowledgement = H.decision('incident-acknowledgement', { responder: z.string() });
const Resolution = H.decision('incident-resolution', { resolved: z.boolean(), notes: z.string() });

const probeService = H.command('probe-service', ['./ops/probe']);
const runBackup = H.command('run-backup', ['./ops/backup']);
const certificateExpiry = H.command('certificate-expiry', ['./ops/cert-days-left']).parses({ daysLeft: z.number() });
const renewCertificate = H.command('renew-certificate', ['./ops/renew-cert']);
const pageOnCall = H.command('page-on-call', ['./ops/page']);
const runbook = H.command('incident-runbook', ['./ops/runbook']);
const diskSpace = H.command('disk-space', ['./ops/check-disk', '--min-free-gb', '50']);
const slackIncidents = slack.notify('incident-channel', { webhookUrl: H.env('SLACK_WEBHOOK_URL') });

const localShell = local.shell({ slots: 4 });
const sshHosts = ssh.hosts({
  hosts: [
    { host: 'db-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
    { host: 'db-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
  ],
  slotsPerHost: 1,
});

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .step('probe', probeService, c => ({ args: [c.input.service] }), { timeoutMs: 30000 })
  .ends(['healthy'], () => 'healthy');

const backupFlow = H.flow('backup')
  .requires({ database: z.string() })
  .step('backup', runBackup, c => ({ args: [c.input.database] }), { restart: 'rerun' })
  .ends(['backedUp'], () => 'backedUp');

const renewalFlow = H.flow('certificate-renewal')
  .requires({ domain: z.string() })
  .step('check', certificateExpiry, c => ({ args: [c.input.domain] }))
  .exit('stillValid', c => c.out.check.data.daysLeft >= 14)
  .step('renew', renewCertificate, c => ({ args: [c.input.domain] }))
  .ends(['renewed'], () => 'renewed');

const incidentFlow = H.flow('incident-runbook')
  .requires({ ref: z.string(), summary: z.string(), origin: z.string() })
  .step('page', pageOnCall, c => ({ args: [c.input.ref, c.input.summary] }), { restart: 'park' })
  .halt('acknowledge', Acknowledgement, { ask: c => `Acknowledge incident ${c.input.ref}: ${c.input.summary}` })
  .step('runbook', runbook, c => ({ args: [c.input.origin, c.input.ref] }))
  .halt('resolution', Resolution, { ask: c => `Runbook finished for ${c.input.ref}. Is the incident resolved?` })
  .ends(['resolved', 'unresolved'], c => c.out.resolution.resolved ? 'resolved' : 'unresolved');

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .supply([
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), (c, to) =>
      ['api', 'web', 'queue'].map(service => to.create({ attributes: { service, at: c.now } }))),
  ])
  .runner(localShell)
  .handler(heartbeatFlow, { ends: { healthy: Healthy } });

const backupLane = H.lane('backups', Backup)
  .supply([
    H.supply.schedule(Backup, H.time.daily('01:00', 'UTC'), (c, to) =>
      ['orders', 'accounts'].map(database =>
        to.create({ attributes: { database, night: new Date(c.now).toISOString().slice(0, 10) } }))),
  ])
  .runner(sshHosts)
  .preflight(diskSpace)
  .handler(backupFlow, { ends: { backedUp: BackedUp } });

const renewalLane = H.lane('certificate-renewals', CertificateRenewal)
  .supply([
    H.supply.schedule(CertificateRenewal, H.time.weekly('mon', '04:00', 'UTC'), (c, to) =>
      ['acme.example', 'api.acme.example'].map(domain => to.create({ attributes: { domain, at: c.now } }))),
  ])
  .runner(sshHosts)
  .handler(renewalFlow, { ends: { stillValid: StillValid, renewed: Renewed } });

const incidentLane = H.lane('incidents', Incident)
  .supply([H.supply.operator()])
  .runner(localShell)
  .handler(incidentFlow, { ends: { resolved: Resolved, unresolved: Unresolved } });

const failingServiceOpensIncident = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(heartbeatLane, { verdict: 'failure', count: 3, per: 'service' }),
).creates(e => incidentLane.unit({
  attributes: {
    ref: `heartbeat-${e.unit.attributes.service}-${e.unit.attributes.at}`,
    summary: `${e.unit.attributes.service} failed ${e.count} consecutive heartbeats`,
    origin: 'heartbeat',
  },
}));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident', H.on.transition(backupLane, { to: [BackupFailed] }))
  .creates(e => incidentLane.unit({
    attributes: {
      ref: `backup-${e.unit.key}`,
      summary: `Backup of ${e.unit.attributes.database} failed for ${e.unit.attributes.night}`,
      origin: 'backup',
    },
  }));

const slowBackupNoted = H.trigger('slow-backup-noted', H.on.transition(backupLane, { to: [BackedUp] }))
  .where(e => e.attempt !== null && e.attempt.durationMs > 2 * 3600000)
  .records(opsJournal, e => [{
    rule: `when scheduling the ${e.unit.attributes.database} backup, start it earlier or split it`,
    because: `the ${e.unit.attributes.night} backup took ${Math.round((e.attempt === null ? 0 : e.attempt.durationMs) / 60000)} minutes`,
    when: { kinds: [Backup], attributes: { database: e.unit.attributes.database } },
  }]);

const incidentTransitionsToSlack = H.trigger('incident-transitions-to-slack', H.on.transition(incidentLane))
  .invokes(slackIncidents, e => ({ text: `Incident ${e.unit.attributes.ref}: ${e.from ?? 'created'} -> ${e.to}` }));

const incidentsFirst = H.policy.schedule('incidents-preempt', c => {
  const incidentPending = c.candidates.some(candidate => candidate.is(incidentLane));
  const incidentActive = incidentPending || c.open.some(attempt => c.inLane(attempt, incidentLane));
  return {
    start: c.candidates
      .filter(candidate => !(incidentActive && candidate.is(backupLane)))
      .map(candidate => ({
        candidate,
        rank: candidate.is(incidentLane) ? 0 : candidate.is(heartbeatLane) ? 1 : candidate.is(renewalLane) ? 2 : 3,
      }))
      .sort((a, b) => a.rank - b.rank || b.candidate.waitedMs - a.candidate.waitedMs)
      .map(ranked => ranked.candidate),
    preempt: incidentPending
      ? c.open.filter(attempt => c.inLane(attempt, renewalLane) || c.inLane(attempt, heartbeatLane))
      : [],
  };
});

const operatorAccess = H.access('ops-operator')
  .allows([
    H.ops.readWork,
    H.ops.createWork,
    H.ops.resolveBlocks,
    H.ops.manageAttempts,
    H.ops.readMemory,
    H.ops.readTelemetry,
  ]);

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ops.db'))
  .lanes([heartbeatLane, backupLane, renewalLane, incidentLane])
  .triggers([failingServiceOpensIncident, failedBackupOpensIncident, slowBackupNoted, incidentTransitionsToSlack])
  .schedule(incidentsFirst)
  .clients([http.server('ops-control', operatorAccess, { port: H.slot.port(0), token: H.env('OPS_CONTROL_TOKEN') })])
  .projections([markdown.board('BOARD.md')]);
