import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const hourMs = 3_600_000;

const Due = H.state('due', 'pending');
const Running = H.state('running', 'active');
const Done = H.state('done', 'succeeded');
const Failed = H.state('failed', 'failed');
const StillValid = H.state('still valid', 'succeeded');
const Renewed = H.state('renewed', 'succeeded');
const Open = H.state('open', 'pending');
const Acknowledged = H.state('acknowledged', 'active');
const Resolved = H.state('resolved', 'succeeded');

const Heartbeat = H.work('Heartbeat')
  .attributes({ service: z.string(), tick: z.number() })
  .states([Due, Running, Done, Failed])
  .key(unit => `${unit.attributes.service}@${unit.attributes.tick}`);

const Backup = H.work('Backup')
  .attributes({ database: z.string(), night: z.string() })
  .states([Due, Running, Done, Failed])
  .key(unit => `${unit.attributes.database}@${unit.attributes.night}`);

const CertificateRenewal = H.work('CertificateRenewal')
  .attributes({ domain: z.string(), week: z.number() })
  .states([Due, Running, StillValid, Renewed, Failed])
  .key(unit => `${unit.attributes.domain}@${unit.attributes.week}`);

const Incident = H.work('Incident')
  .attributes({ service: z.string(), reason: z.string() })
  .states([Open, Acknowledged, Resolved, Failed]);

const services = ['api', 'web', 'worker', 'queue'];
const databases = ['orders', 'customers'];
const domains = ['example.com', 'api.example.com'];

const localShell = local.shell({ slots: 4 });
const databaseHosts = ssh.hosts({
  hosts: [
    { host: 'db-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
    { host: 'db-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
  ],
  slotsPerHost: 1,
});

const healthCheck = H.command('health-check', ['ops/health-check']);
const dumpDatabase = H.command('dump-database', ['ops/backup']);
const diskSpace = H.command('disk-space', ['ops/require-free-disk', '--min-gb', '50']);
const certificateCheck = H.command('certificate-check', ['ops/cert-days-left']).parses({ daysLeft: z.number() });
const certificateRenew = H.command('certificate-renew', ['ops/cert-renew']);
const runbook = H.command('incident-runbook', ['ops/runbook']);
const incidentChannel = slack.notify('incident-channel', { webhookUrl: H.env('SLACK_INCIDENT_WEBHOOK') });

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .mark('running')
  .step('check', healthCheck, c => ({ args: [c.input.service] }), { timeoutMs: 30_000 })
  .ends(['done'], () => 'done');

const backupFlow = H.flow('backup')
  .requires({ database: z.string() })
  .mark('running')
  .step('dump', dumpDatabase, c => ({ args: ['--database', c.input.database] }), { timeoutMs: 6 * hourMs })
  .ends(['done'], () => 'done');

const renewalFlow = H.flow('certificate-renewal')
  .requires({ domain: z.string() })
  .mark('running')
  .step('check', certificateCheck, c => ({ args: [c.input.domain] }))
  .exit('stillValid', c => c.out.check.data.daysLeft >= 14)
  .step('renew', certificateRenew, c => ({ args: [c.input.domain] }), {
    retry: H.retry.exponential({ maxRetries: 2, initialDelayMs: 300_000 }),
  })
  .ends(['renewed'], () => 'renewed');

const incidentFlow = H.flow('incident')
  .requires({ service: z.string(), reason: z.string() })
  .step('page', incidentChannel, c => ({ text: `Paging on-call: ${c.input.service}: ${c.input.reason}` }))
  .halt('acknowledgement', {
    ask: c => `Acknowledge the incident on ${c.input.service}: ${c.input.reason}`,
    decision: { acknowledgedBy: z.string() },
  })
  .mark('acknowledged')
  .step('runbook', runbook, c => ({ args: ['--service', c.input.service] }), { onFailure: 'halt' })
  .halt('resolution', {
    ask: c => `Runbook finished for ${c.input.service}. Is the incident resolved?`,
    decision: { resolved: z.boolean(), notes: z.string() },
  })
  .ends(['resolved', 'unresolved'], c => (c.out.resolution.resolved ? 'resolved' : 'unresolved'));

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .supply([
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), c =>
      services.map(service => ({ create: { attributes: { service, tick: c.now } } })),
    ),
  ])
  .runner(localShell)
  .handler(heartbeatFlow, { states: { running: Running, done: Done, failed: Failed } });

const backupLane = H.lane('backups', Backup)
  .supply([
    H.supply.schedule(Backup, H.time.daily('01:00', 'UTC'), c =>
      databases.map(database => ({
        create: { attributes: { database, night: new Date(c.now).toISOString().slice(0, 10) } },
      })),
    ),
  ])
  .runner(databaseHosts)
  .preflight(diskSpace)
  .handler(backupFlow, { states: { running: Running, done: Done, failed: Failed } });

const renewalLane = H.lane('certificate-renewals', CertificateRenewal)
  .supply([
    H.supply.schedule(CertificateRenewal, H.time.weekly('mon', '06:00', 'UTC'), c =>
      domains.map(domain => ({ create: { attributes: { domain, week: c.now } } })),
    ),
  ])
  .runner(databaseHosts)
  .handler(renewalFlow, {
    states: { running: Running, stillValid: StillValid, renewed: Renewed, failed: Failed },
  });

const incidentLane = H.lane('incidents', Incident)
  .supply([H.supply.operator()])
  .runner(localShell)
  .handler(incidentFlow, {
    states: { acknowledged: Acknowledged, resolved: Resolved, unresolved: Open, failed: Failed },
  });

const OperationalExperience = H.memory.experience('operational-experience');
const operationsJournal = H.journal('operations-journal', OperationalExperience)
  .store(jsonl.memory('ops/experience.jsonl'));

const repeatedHeartbeatFailureOpensIncident = H.trigger(
  'repeated-heartbeat-failure-opens-incident',
  H.on.streak(heartbeatLane, { outcome: 'failed', count: 3, per: 'service' }),
).creates(incidentLane, event => ({
  attributes: { service: event.unit.attributes.service, reason: `${event.count} consecutive failed heartbeats` },
}));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident', H.on.transition(backupLane, { outcome: ['failed'] }))
  .creates(incidentLane, event => ({
    attributes: { service: event.unit.attributes.database, reason: `backup ${event.unit.key} failed` },
  }));

const slowBackupBecomesExperience = H.trigger('slow-backup-becomes-experience', H.on.transition(backupLane, { to: [Done] }))
  .where(event => event.attempt !== null && event.attempt.durationMs > 2 * hourMs)
  .records(operationsJournal, event => [{
    rule: `Schedule the ${event.unit.attributes.database} backup earlier or split it when its window overlaps peak load`,
    because: `the backup on ${event.unit.attributes.night} succeeded but took ${Math.round((event.attempt ? event.attempt.durationMs : 0) / 60_000)} minutes`,
    when: { kinds: [Backup], attributes: { database: event.unit.attributes.database } },
  }]);

const incidentTransitionsNotify = H.trigger('incident-transitions-notify', H.on.transition(incidentLane))
  .invokes(incidentChannel, event => ({
    text: `Incident ${event.unit.key} (${event.unit.attributes.service}): ${event.from ?? 'created'} -> ${event.to}`,
  }));

const incidentsFirst = H.policy.schedule('incidents-first', c => {
  const incidentOpen = c.open.some(attempt => c.inLane(attempt, incidentLane));
  const incidentWaiting = c.candidates.some(candidate => candidate.is(incidentLane));
  const start = c.candidates
    .filter(candidate => !(candidate.is(backupLane) && candidate.entry.reason === 'start' && (incidentOpen || incidentWaiting)))
    .sort((a, b) => Number(b.is(incidentLane)) - Number(a.is(incidentLane)));
  const preempt = incidentWaiting
    ? c.open.filter(attempt =>
        attempt.status === 'running' && !c.inLane(attempt, backupLane) && !c.inLane(attempt, incidentLane),
      )
    : [];
  return { start, preempt };
});

const operatorAccess = H.access('operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.signalWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.readTelemetry,
]);

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('/var/lib/harness/ops-ledger.db'))
  .lanes([heartbeatLane, backupLane, renewalLane, incidentLane])
  .triggers([
    repeatedHeartbeatFailureOpensIncident,
    failedBackupOpensIncident,
    slowBackupBecomesExperience,
    incidentTransitionsNotify,
  ])
  .schedule(incidentsFirst)
  .clients([http.server('operator-api', operatorAccess, { port: H.slot.port(0), token: H.env('OPS_API_TOKEN') })])
  .projections([markdown.board('/var/lib/harness/BOARD.md')]);
