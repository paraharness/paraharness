import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as slack from 'harness-dsl/slack';

const HOUR = 60 * 60 * 1000;
const RENEW_BELOW_DAYS = 14;

const Due = H.state('due', 'pending');
const Probing = H.state('probing', 'active');
const Healthy = H.state('healthy', 'terminal', 'success');
const Unhealthy = H.state('unhealthy', 'terminal', 'failure');

const BackupDue = H.state('backup-due', 'pending');
const BackingUp = H.state('backing-up', 'active');
const BackedUp = H.state('backed-up', 'terminal', 'success');
const BackupFailed = H.state('backup-failed', 'terminal', 'failure');

const RenewalDue = H.state('renewal-due', 'pending');
const Checking = H.state('checking', 'active');
const Renewing = H.state('renewing', 'active');
const StillValid = H.state('still-valid', 'terminal', 'success');
const Renewed = H.state('renewed', 'terminal', 'success');
const RenewalFailed = H.state('renewal-failed', 'terminal', 'failure');

const Reported = H.state('reported', 'pending');
const Paging = H.state('paging', 'active');
const Remediating = H.state('remediating', 'active');
const Confirming = H.state('confirming', 'active');
const Resolved = H.state('resolved', 'terminal', 'success');
const Unresolved = H.state('unresolved', 'terminal', 'failure');

const Heartbeat = H.work('Heartbeat')
  .attributes({ service: z.string() })
  .states([Due, Probing, Healthy, Unhealthy])
  .key((unit) => unit.attributes.service);

const Backup = H.work('Backup')
  .attributes({ database: z.string(), night: z.string() })
  .states([BackupDue, BackingUp, BackedUp, BackupFailed])
  .key((unit) => `${unit.attributes.database}:${unit.attributes.night}`);

const CertificateRenewal = H.work('CertificateRenewal')
  .attributes({ domain: z.string(), week: z.string() })
  .states([RenewalDue, Checking, Renewing, StillValid, Renewed, RenewalFailed])
  .key((unit) => `${unit.attributes.domain}:${unit.attributes.week}`);

const Incident = H.work('Incident')
  .attributes({ ref: z.string(), title: z.string(), severity: z.string() })
  .states([Reported, Paging, Remediating, Confirming, Resolved, Unresolved])
  .key((unit) => unit.attributes.ref);

const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const serviceProbe = H.command('service-probe', ['./ops/probe-service.sh']);
const backupDump = H.command('backup-dump', ['./ops/backup.sh']);
const diskPreflight = H.command('disk-space-preflight', ['./ops/check-disk.sh', '--min-free-gb', '50']);
const certificateDaysLeft = H.command('certificate-days-left', ['./ops/cert-days-left.sh']).parses({
  daysLeft: z.number(),
});
const certificateRenew = H.command('certificate-renew', ['./ops/cert-renew.sh']);
const pageOncall = H.command('page-oncall', ['./ops/page-oncall.sh']);
const runbook = H.command('incident-runbook', ['./ops/runbook.sh']);

const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .mark('probing')
  .step('probe', serviceProbe, (c) => ({ args: [c.input.service] }), { timeoutMs: 30000, onRestart: 'rerun' })
  .ends(['healthy'], () => 'healthy');

const backupFlow = H.flow('backup')
  .requires({ database: z.string() })
  .mark('backing-up')
  .step('dump', backupDump, (c) => ({ args: [c.input.database] }), { timeoutMs: 6 * HOUR, onRestart: 'rerun' })
  .ends(['backed-up'], () => 'backed-up');

const renewalFlow = H.flow('certificate-renewal')
  .requires({ domain: z.string() })
  .mark('checking')
  .step('check', certificateDaysLeft, (c) => ({ args: [c.input.domain] }), { onRestart: 'rerun' })
  .exit('still-valid', (c) => c.out.check.data.daysLeft >= RENEW_BELOW_DAYS)
  .mark('renewing')
  .step('renew', certificateRenew, (c) => ({ args: [c.input.domain] }), { onRestart: 'rerun' })
  .ends(['renewed'], () => 'renewed');

const incidentFlow = H.flow('incident')
  .requires({ ref: z.string(), title: z.string() })
  .mark('paging')
  .step('page', pageOncall, (c) => ({ args: [c.input.ref, c.input.title] }))
  .halt('acknowledge', {
    ask: (c) => `Acknowledge incident ${c.input.ref}: ${c.input.title}`,
    decision: { responder: z.string() },
  })
  .mark('remediating')
  .step('runbook', runbook, (c) => ({ args: [c.input.ref] }))
  .mark('confirming')
  .halt('confirm', {
    ask: (c) => `The runbook for ${c.input.ref} finished. Is the incident resolved?`,
    decision: { resolved: z.boolean(), notes: z.string() },
  })
  .ends(['resolved', 'unresolved'], (c) => (c.out.confirm.resolved ? 'resolved' : 'unresolved'));

const shell = local.shell({ slots: 4 });
const hosts = ssh.hosts({
  hosts: [
    { host: 'db-1.internal', user: 'ops', key: H.env('SSH_KEY_DB1') },
    { host: 'db-2.internal', user: 'ops', key: H.env('SSH_KEY_DB2') },
  ],
  slotsPerHost: 1,
});

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply([
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), () =>
      ['api', 'queue', 'search'].map((service) => ({ create: { attributes: { service } } })),
    ),
  ])
  .handler(heartbeatFlow, { states: { probing: Probing, healthy: Healthy, failed: Unhealthy } })
  .runner(shell);

const backups = H.lane('backups', Backup)
  .supply([
    H.supply.schedule(Backup, H.time.daily('01:00', 'UTC'), (c) =>
      ['orders', 'accounts', 'events'].map((database) => ({
        create: { attributes: { database, night: dateOf(c.now) } },
      })),
    ),
  ])
  .handler(backupFlow, { states: { 'backing-up': BackingUp, 'backed-up': BackedUp, failed: BackupFailed } })
  .runner(hosts)
  .preflight(diskPreflight);

const renewals = H.lane('renewals', CertificateRenewal)
  .supply([
    H.supply.schedule(CertificateRenewal, H.time.weekly('mon', '03:00', 'UTC'), (c) =>
      ['example.com', 'api.example.com'].map((domain) => ({
        create: { attributes: { domain, week: dateOf(c.now) } },
      })),
    ),
  ])
  .handler(renewalFlow, {
    states: {
      checking: Checking,
      renewing: Renewing,
      'still-valid': StillValid,
      renewed: Renewed,
      failed: RenewalFailed,
    },
  })
  .runner(hosts);

const incidents = H.lane('incidents', Incident)
  .supply([H.supply.operator()])
  .handler(incidentFlow, {
    states: {
      paging: Paging,
      remediating: Remediating,
      confirming: Confirming,
      resolved: Resolved,
      unresolved: Unresolved,
      failed: Unresolved,
    },
  })
  .runner(shell);

const operations = H.journal('operations', H.memory.experience('operational-experience')).store(
  jsonl.memory('memory/operations.jsonl'),
);

const oncallChannel = slack.notify('oncall-channel', { webhookUrl: H.env('SLACK_WEBHOOK_URL') });

const heartbeatStreakOpensIncident = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(heartbeats, { verdict: 'failure', count: 3, per: 'service' }),
).creates(incidents, (event) => ({
  attributes: {
    ref: `heartbeat:${event.unit.attributes.service}`,
    title: `${event.unit.attributes.service} failed ${event.count} heartbeats in a row`,
    severity: 'high',
  },
}));

const failedBackupOpensIncident = H.trigger(
  'failed-backup-opens-incident',
  H.on.transition(backups, { verdict: ['failure'] }),
).creates(incidents, (event) => ({
  attributes: {
    ref: `backup:${event.unit.key}`,
    title: `Backup of ${event.unit.attributes.database} for ${event.unit.attributes.night} failed`,
    severity: 'high',
  },
}));

const slowBackupNoted = H.trigger('slow-backup-noted', H.on.transition(backups, { verdict: ['success'] }))
  .where((event) => event.attempt !== null && event.attempt.durationMs > 2 * HOUR)
  .records(operations, (event) => [
    {
      rule: `When scheduling the backup of ${event.unit.attributes.database}, allow more than two hours`,
      because: `the backup of ${event.unit.attributes.night} took ${
        event.attempt === null ? 0 : Math.round(event.attempt.durationMs / 60000)
      } minutes`,
      when: { kinds: [Backup], attributes: { database: event.unit.attributes.database } },
    },
  ]);

const incidentTransitionsNotified = H.trigger(
  'incident-transitions-notified',
  H.on.transition(incidents),
).invokes(oncallChannel, (event) => ({
  text: `Incident ${event.unit.attributes.ref} (${event.unit.attributes.title}): ${event.from ?? 'new'} -> ${event.to}`,
}));

const rank = (lane: string): number => {
  if (lane === incidents.name) return 0;
  if (lane === heartbeats.name) return 1;
  if (lane === backups.name) return 2;
  return 3;
};

const incidentsFirst = H.policy.schedule('incidents-preempt', (c) => {
  const incidentOpen = c.open.some((attempt) => c.inLane(attempt, incidents));
  const incidentWaiting = c.candidates.some((candidate) => candidate.unit.lane === incidents.name);
  const holdBackups = incidentOpen || incidentWaiting;
  return {
    start: c.candidates
      .filter((candidate) => holdBackups === false || candidate.unit.lane !== backups.name)
      .sort((a, b) => rank(a.unit.lane) - rank(b.unit.lane)),
    preempt: incidentWaiting
      ? c.open.filter(
          (attempt) =>
            attempt.status === 'running' && (c.inLane(attempt, renewals) || c.inLane(attempt, heartbeats)),
        )
      : [],
  };
});

const operatorAccess = H.access('operator').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.readTelemetry,
]);

export default H.harness('operations')
  .ledger(sqlite.ledger('.harness/operations.sqlite'))
  .lanes([incidents, heartbeats, backups, renewals])
  .triggers([heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupNoted, incidentTransitionsNotified])
  .schedule(incidentsFirst)
  .clients([http.server('ops-api', operatorAccess, { port: H.slot.port(0), token: H.env('OPS_API_TOKEN') })])
  .projections([markdown.board('BOARD.md')]);
