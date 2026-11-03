import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as slack from 'harness-dsl/slack';

const Due = H.state('Due', 'pending');
const Running = H.state('Running', 'active');
const Up = H.state('Up', 'terminal', 'success');
const Down = H.state('Down', 'terminal', 'failure');
const BackedUp = H.state('BackedUp', 'terminal', 'success');
const BackupFailed = H.state('BackupFailed', 'terminal', 'failure');
const Renewed = H.state('Renewed', 'terminal', 'success');
const NotDue = H.state('NotDue', 'terminal', 'neutral');
const RenewalFailed = H.state('RenewalFailed', 'terminal', 'failure');
const IncidentOpen = H.state('IncidentOpen', 'pending');
const Responding = H.state('Responding', 'active');
const IncidentResolved = H.state('IncidentResolved', 'terminal', 'success');

const heartbeatKind = H.work('Heartbeat')
  .attributes({ service: z.string(), tick: z.number() })
  .states([Due, Running, Up, Down])
  .failsTo(Down)
  .key(unit => `${unit.attributes.service}@${unit.attributes.tick}`);

const backupKind = H.work('Backup')
  .attributes({ database: z.string(), night: z.string() })
  .states([Due, Running, BackedUp, BackupFailed])
  .failsTo(BackupFailed)
  .key(unit => `${unit.attributes.database}:${unit.attributes.night}`);

const renewalKind = H.work('CertificateRenewal')
  .attributes({ domain: z.string(), week: z.string() })
  .states([Due, Running, Renewed, NotDue, RenewalFailed])
  .failsTo(RenewalFailed)
  .key(unit => `${unit.attributes.domain}:${unit.attributes.week}`);

const incidentKind = H.work('Incident')
  .attributes({ service: z.string(), reason: z.string(), ref: z.string() })
  .states([IncidentOpen, Responding, IncidentResolved])
  .key(unit => `${unit.attributes.service}:${unit.attributes.reason}:${unit.attributes.ref}`);

const probe = H.command('probeService', ['./ops/probe.sh']);
const backupDatabase = H.command('backupDatabase', ['./ops/backup.sh']);
const diskSpace = H.command('diskSpacePreflight', ['./ops/check-disk.sh', '--min-free-gb', '50']);
const certificateCheck = H.command('certificateCheck', ['./ops/cert-days-left.sh']).parses({ daysLeft: z.number() });
const renewCertificate = H.command('renewCertificate', ['./ops/renew-cert.sh']);
const runbook = H.command('incidentRunbook', ['./ops/runbook.sh']);

const pager = slack.notify('pager', { webhookUrl: H.env('SLACK_PAGER_WEBHOOK') });
const incidentChannel = slack.notify('incidentChannel', { webhookUrl: H.env('SLACK_INCIDENTS_WEBHOOK') });

const localShell = local.shell({ slots: 4 });
const hosts = ssh.hosts({
  hosts: [
    { host: 'db-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
    { host: 'db-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
  ],
  slotsPerHost: 1,
});

const probeFlow = H.flow('heartbeatProbe')
  .requires({ service: z.string() })
  .step('probe', probe, c => ({ args: [c.input.service] }), { restart: 'rerun', timeoutMs: 30000 })
  .ends(['up'], () => 'up');

const backupFlow = H.flow('nightlyBackup')
  .requires({ database: z.string() })
  .step('backup', backupDatabase, c => ({ args: [c.input.database] }), { restart: 'rerun' })
  .ends(['backedUp'], () => 'backedUp');

const renewalFlow = H.flow('certificateRenewal')
  .requires({ domain: z.string() })
  .step('check', certificateCheck, c => ({ args: [c.input.domain] }), { restart: 'rerun' })
  .exit('notDue', c => c.out.check.data.daysLeft >= 14)
  .step('renew', renewCertificate, c => ({ args: [c.input.domain] }), { restart: 'rerun' })
  .ends(['renewed'], () => 'renewed');

const acknowledgement = H.decision('incidentAcknowledgement', { responder: z.string() });
const resolution = H.decision('incidentResolution', { resolved: z.boolean(), summary: z.string() });

const incidentFlow = H.flow('incidentResponse')
  .requires({ service: z.string(), reason: z.string() })
  .step('page', pager, c => ({ text: `Incident on ${c.input.service}: ${c.input.reason}` }))
  .halt('acknowledge', acknowledgement, { ask: c => `Acknowledge the incident on ${c.input.service} (${c.input.reason}).` })
  .step('runbook', runbook, c => ({ args: [c.input.service, c.input.reason] }), { onFailure: 'halt', restart: 'escalate' })
  .halt('confirmResolution', resolution, {
    ask: c => `The runbook for ${c.input.service} exited with ${c.out.runbook.exitCode}. Confirm the incident is resolved.`,
  })
  .ends(['resolved', 'unresolved'], c => c.out.confirmResolution.resolved ? 'resolved' : 'unresolved');

const services = ['api', 'web', 'queue'];
const databases = ['orders', 'customers'];
const domains = ['example.com', 'api.example.com'];

function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

const heartbeats = H.lane('heartbeats', heartbeatKind)
  .supply([
    H.supply.schedule(heartbeatKind, H.time.every({ minutes: 5 }), (c, supply) =>
      services.map(service => supply.create({ attributes: { service, tick: c.now } }))),
  ])
  .handler(probeFlow, { states: { up: Up }, opens: Running })
  .runner(localShell);

const backups = H.lane('backups', backupKind)
  .supply([
    H.supply.schedule(backupKind, H.time.daily('01:00'), (c, supply) =>
      databases.map(database => supply.create({ attributes: { database, night: dayOf(c.now) } }))),
  ])
  .handler(backupFlow, { states: { backedUp: BackedUp }, opens: Running })
  .runner(hosts)
  .preflight(diskSpace);

const renewals = H.lane('renewals', renewalKind)
  .supply([
    H.supply.schedule(renewalKind, H.time.weekly('mon', '04:00'), (c, supply) =>
      domains.map(domain => supply.create({ attributes: { domain, week: dayOf(c.now) } }))),
  ])
  .handler(renewalFlow, { states: { notDue: NotDue, renewed: Renewed }, opens: Running })
  .runner(hosts)
  .preflight(diskSpace);

const incidents = H.lane('incidents', incidentKind)
  .supply([H.supply.operator()])
  .handler(incidentFlow, { states: { resolved: IncidentResolved, unresolved: IncidentOpen }, opens: Responding })
  .runner(localShell);

const operationsJournal = H.journal('operationsJournal', H.memory.experience('operationalExperience'))
  .store(jsonl.memory('ops/memory/operations.jsonl'));

const twoHoursMs = 2 * 60 * 60 * 1000;

const failingHeartbeatsOpenIncident = H.trigger(
  'failingHeartbeatsOpenIncident',
  H.on.streak(heartbeats, { verdict: 'failure', count: 3, per: 'service' }),
).creates(e => incidents.unit({
  attributes: { service: e.unit.attributes.service, reason: 'three consecutive failed heartbeats', ref: e.unit.key },
}));

const failedBackupOpensIncident = H.trigger('failedBackupOpensIncident', H.on.transition(backups, { verdict: ['failure'] }))
  .creates(e => incidents.unit({
    attributes: { service: e.unit.attributes.database, reason: 'backup failed', ref: e.unit.key },
  }));

const slowBackupNoted = H.trigger('slowBackupNoted', H.on.transition(backups, { to: [BackedUp] }))
  .where(e => e.attempt !== null && e.attempt.durationMs > twoHoursMs)
  .records(operationsJournal, e => [{
    rule: `When scheduling the backup of ${e.unit.attributes.database}, allow more than two hours before the next job on its host`,
    because: `the backup of ${e.unit.attributes.night} took ${Math.round((e.attempt === null ? 0 : e.attempt.durationMs) / 60000)} minutes`,
    when: { kinds: [backupKind], attributes: { database: e.unit.attributes.database } },
  }]);

const incidentTransitionsNotify = H.trigger('incidentTransitionsNotify', H.on.transition(incidents))
  .invokes(incidentChannel, e => ({
    text: `Incident ${e.unit.key}: ${e.from === null ? 'created' : e.from} -> ${e.to}`,
  }));

const incidentsFirst = H.policy.schedule('incidentsFirst', c => {
  const incidentPending = c.candidates.some(candidate => candidate.is(incidents));
  const incidentActive = incidentPending || c.open.some(attempt => attempt.is(incidents));
  const ordered = c.order(
    candidate => candidate.is(incidents) ? 0 : candidate.is(heartbeats) ? 1 : 2,
    candidate => candidate.enqueuedAt,
  );
  return {
    start: ordered.filter(candidate => !(incidentActive && candidate.is(backups))),
    preempt: incidentPending ? c.open.filter(attempt => !attempt.is(backups) && !attempt.is(incidents)) : [],
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

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('ops/ledger.db'))
  .lanes([incidents, heartbeats, backups, renewals])
  .triggers([failingHeartbeatsOpenIncident, failedBackupOpensIncident, slowBackupNoted, incidentTransitionsNotify])
  .schedule(incidentsFirst)
  .clients([http.server('operations-api', operatorAccess, { port: H.slot.port(0), token: H.env('OPS_API_TOKEN') })])
  .projections([markdown.board('ops/BOARD.md')]);
