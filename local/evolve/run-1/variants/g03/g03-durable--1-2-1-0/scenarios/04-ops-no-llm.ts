import { H } from 'harness-dsl';
import { z } from 'zod';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as slack from 'harness-dsl/slack';

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Up = H.state('Up', 'terminal', 'success');
const Down = H.state('Down', 'terminal', 'failure');

const Scheduled = H.state('Scheduled', 'pending');
const BackingUp = H.state('BackingUp', 'active');
const BackedUp = H.state('BackedUp', 'terminal', 'success');
const BackupFailed = H.state('BackupFailed', 'terminal', 'failure');

const CheckDue = H.state('CheckDue', 'pending');
const Checking = H.state('Checking', 'active');
const Renewing = H.state('Renewing', 'active');
const StillValid = H.state('StillValid', 'terminal', 'neutral');
const Renewed = H.state('Renewed', 'terminal', 'success');
const RenewalFailed = H.state('RenewalFailed', 'terminal', 'failure');

const Open = H.state('Open', 'pending');
const Responding = H.state('Responding', 'active');
const AwaitingAck = H.state('AwaitingAck', 'active');
const RunningRunbook = H.state('RunningRunbook', 'active');
const ConfirmingResolution = H.state('ConfirmingResolution', 'active');
const Stalled = H.state('Stalled', 'waiting');
const Resolved = H.state('Resolved', 'terminal', 'success');

const Heartbeat = H.work('heartbeat')
  .attributes({ service: z.string(), at: z.number() })
  .states([Due, Probing, Up, Down])
  .failsTo(Down)
  .key(u => `${u.attributes.service}@${u.attributes.at}`);

const Backup = H.work('backup')
  .attributes({ database: z.string(), night: z.string() })
  .states([Scheduled, BackingUp, BackedUp, BackupFailed])
  .failsTo(BackupFailed)
  .key(u => `${u.attributes.database}@${u.attributes.night}`);

const CertificateRenewal = H.work('certificate-renewal')
  .attributes({ domain: z.string(), week: z.number() })
  .states([CheckDue, Checking, Renewing, StillValid, Renewed, RenewalFailed])
  .failsTo(RenewalFailed)
  .key(u => `${u.attributes.domain}#${u.attributes.week}`);

const Incident = H.work('incident')
  .attributes({ ref: z.string(), title: z.string(), service: z.string() })
  .states([Open, Responding, AwaitingAck, RunningRunbook, ConfirmingResolution, Stalled, Resolved])
  .failsTo(Stalled)
  .key(u => u.attributes.ref);

const probe = H.command('heartbeat-probe', ['ops/probe']);
const dumpDatabase = H.command('backup-database', ['ops/backup']);
const diskSpace = H.command('disk-space-preflight', ['ops/check-disk', '--min-free-gb', '50']);
const certificateDays = H.command('certificate-days-left', ['ops/cert-days']).parses({ daysLeft: z.number() });
const renewCertificate = H.command('renew-certificate', ['ops/renew-cert']);
const runbook = H.command('incident-runbook', ['ops/runbook']);
const pager = slack.notify('incident-pager', { webhookUrl: H.env('SLACK_PAGER_WEBHOOK') });
const channel = slack.notify('incident-channel', { webhookUrl: H.env('SLACK_INCIDENTS_WEBHOOK') });

const acknowledgement = H.decision('incident-acknowledgement', { responder: z.string() });
const resolution = H.decision('incident-resolution', { resolved: z.boolean(), note: z.string() });

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .step('probe', probe, c => ({ args: [c.input.service] }), { timeoutMs: 30_000, restart: 'rerun' })
  .ends(['up'], () => 'up');

const backupFlow = H.flow('backup')
  .requires({ database: z.string(), night: z.string() })
  .step('dump', dumpDatabase, c => ({ args: [c.input.database, c.input.night] }), {
    timeoutMs: 6 * 60 * 60 * 1000,
    restart: 'rerun',
  })
  .ends(['done'], () => 'done');

const renewalFlow = H.flow('certificate-renewal')
  .requires({ domain: z.string() })
  .step('check', certificateDays, c => ({ args: [c.input.domain] }), { restart: 'rerun' })
  .exit('valid', c => c.out.check.data.daysLeft >= 14)
  .step('renew', renewCertificate, c => ({ args: [c.input.domain] }))
  .ends(['renewed'], () => 'renewed');

const incidentFlow = H.flow('incident-runbook')
  .requires({ title: z.string(), service: z.string() })
  .step('page', pager, c => ({ text: `PAGE: ${c.input.title} (${c.input.service})` }))
  .halt('acknowledge', acknowledgement, { ask: c => `Acknowledge incident: ${c.input.title}` })
  .step('runbook', runbook, c => ({ args: [c.input.service] }))
  .halt('resolution', resolution, { ask: c => `Runbook finished for ${c.input.service}. Is the incident resolved?` })
  .ends(['resolved', 'unresolved'], c => c.out.resolution.resolved ? 'resolved' : 'unresolved');

const services = ['api', 'web', 'queue', 'search'];
const databases = ['orders', 'users', 'billing'];
const domains = ['example.com', 'api.example.com'];
const weekMs = 7 * 24 * 60 * 60 * 1000;

const shell = local.shell({ slots: 4 });
const hosts = ssh.hosts({
  hosts: [
    { host: 'db-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
    { host: 'db-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY') },
  ],
  slotsPerHost: 1,
});

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply([
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), (c, s) =>
      services.map(service => s.create({ attributes: { service, at: c.now } }))),
  ])
  .runner(shell)
  .handler(heartbeatFlow, { opens: Probing, ends: { up: Up } });

const backups = H.lane('backups', Backup)
  .supply([
    H.supply.schedule(Backup, H.time.daily('01:00', 'UTC'), (c, s) =>
      databases.map(database => s.create({ attributes: { database, night: new Date(c.now).toISOString().slice(0, 10) } }))),
  ])
  .store(sqlite.store(Backup, '.harness/ops.db'))
  .runner(hosts)
  .preflight(diskSpace)
  .handler(backupFlow, { opens: BackingUp, ends: { done: BackedUp } });

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .supply([
    H.supply.schedule(CertificateRenewal, H.time.weekly('mon', '06:00', 'UTC'), (c, s) =>
      domains.map(domain => s.create({ attributes: { domain, week: Math.floor(c.now / weekMs) } }))),
  ])
  .store(sqlite.store(CertificateRenewal, '.harness/ops.db'))
  .runner(hosts)
  .preflight(diskSpace)
  .handler(renewalFlow, {
    opens: Checking,
    during: { renew: Renewing },
    ends: { valid: StillValid, renewed: Renewed },
  });

const incidents = H.lane('incidents', Incident)
  .supply([H.supply.operator()])
  .store(sqlite.store(Incident, '.harness/ops.db'))
  .runner(shell)
  .handler(incidentFlow, {
    opens: Responding,
    during: { acknowledge: AwaitingAck, runbook: RunningRunbook, resolution: ConfirmingResolution },
    ends: { resolved: Resolved, unresolved: { to: Open, upTo: 2, then: Stalled } },
  });

const opsExperience = H.playbook('ops-experience', H.memory.experience('ops-experience'))
  .store(jsonl.memory('.harness/memory/ops-experience.jsonl'));

const failingHeartbeats = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(heartbeats, { verdict: 'failure', count: 3, per: 'service' }),
).creates(e => incidents.unit({
  attributes: {
    ref: `heartbeat:${e.unit.attributes.service}:${e.unit.attributes.at}`,
    title: `${e.unit.attributes.service} failed ${e.count} heartbeats in a row`,
    service: e.unit.attributes.service,
  },
}));

const failedBackup = H.trigger('failed-backup-opens-incident', H.on.transition(backups, { to: [BackupFailed] }))
  .creates(e => incidents.unit({
    attributes: {
      ref: `backup:${e.unit.attributes.database}:${e.unit.attributes.night}`,
      title: `Backup of ${e.unit.attributes.database} failed for ${e.unit.attributes.night}`,
      service: e.unit.attributes.database,
    },
  }));

const twoHoursMs = 2 * 60 * 60 * 1000;

const slowBackup = H.trigger('slow-backup-noted', H.on.transition(backups, { to: [BackedUp] }))
  .where(e => (e.attempt ? e.attempt.durationMs : 0) > twoHoursMs)
  .records(opsExperience, e => [{
    rule: `When scheduling the ${e.unit.attributes.database} backup, allow more than two hours and check host load first`,
    because: `the backup for ${e.unit.attributes.night} took ${Math.round((e.attempt ? e.attempt.durationMs : 0) / 60000)} minutes`,
    when: { kinds: [Backup], attributes: { database: e.unit.attributes.database } },
  }]);

const incidentToChannel = H.trigger('incident-transitions-to-channel', H.on.transition(incidents))
  .invokes(channel, e => ({ text: `Incident ${e.unit.attributes.title}: ${e.from ?? 'new'} -> ${e.to}` }));

const schedule = H.policy.schedule('incidents-preempt', c => {
  const incidentWaiting = c.candidates.some(x => x.is(incidents));
  const incidentActive = incidentWaiting || c.open.some(o => o.is(incidents));
  return {
    start: c.order(
      x => x.is(incidents) ? 0 : x.is(heartbeats) ? 1 : 2,
      x => x.enqueuedAt,
    ).filter(x => !(incidentActive && x.is(backups))),
    preempt: incidentWaiting ? c.open.filter(o => o.is(renewals) && o.status === 'running') : [],
  };
});

const operatorAccess = H.access('ops-operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readMemory,
  H.ops.readTelemetry,
]);

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes([incidents, heartbeats, backups, renewals])
  .triggers([failingHeartbeats, failedBackup, slowBackup, incidentToChannel])
  .schedule(schedule)
  .clients([http.server('ops-api', operatorAccess, { port: H.slot.port(0), token: H.env('OPS_API_TOKEN') })])
  .projections([markdown.board('BOARD.md')]);
