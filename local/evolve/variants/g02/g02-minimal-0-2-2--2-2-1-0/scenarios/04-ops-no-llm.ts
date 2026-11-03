import { z } from 'zod';
import { H, type PendingView } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const beatDue = H.state('beatDue', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');
const backupDue = H.state('backupDue', 'pending');
const backedUp = H.state('backedUp', 'terminal', 'success');
const backupFailed = H.state('backupFailed', 'terminal', 'failure');
const certDue = H.state('certDue', 'pending');
const certValid = H.state('certValid', 'terminal', 'success');
const certRenewed = H.state('certRenewed', 'terminal', 'success');
const certFailed = H.state('certFailed', 'terminal', 'failure');
const incidentOpen = H.state('incidentOpen', 'pending');
const incidentResolved = H.state('incidentResolved', 'terminal', 'success');
const incidentUnresolved = H.state('incidentUnresolved', 'terminal', 'failure');

const heartbeat = H.kind('Heartbeat').data(z.object({ service: z.string(), url: z.string() })).states(beatDue, healthy, unhealthy);
const backup = H.kind('Backup').data(z.object({ database: z.string() })).states(backupDue, backedUp, backupFailed);
const renewal = H.kind('CertificateRenewal').data(z.object({ domain: z.string() })).states(certDue, certValid, certRenewed, certFailed);
const incident = H.kind('Incident').data(z.object({ title: z.string(), source: z.string() })).states(incidentOpen, incidentResolved, incidentUnresolved);

const operationalExperience = H.memory('operationalExperience', 'experience');
const opsJournal = H.journal('opsJournal', operationalExperience, jsonl.memory('memory/operations.jsonl'));

const diskSpace = H.command('diskSpacePreflight').argv(() => ['disk-free-at-least', '/var/backups', '20G']);

const local = shell.local('local', { slots: 4 });
const sshKey = H.env('OPS_SSH_KEY');
const hostOne = ssh.host('dbHostOne', { address: 'db1.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskSpace });
const hostTwo = ssh.host('dbHostTwo', { address: 'db2.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskSpace });

const probe = H.command('probeService')
  .input(z.object({ url: z.string() }))
  .argv(input => ['curl', '-fsS', input.url])
  .on(local)
  .recovery('rerun');

const dumpDatabase = H.command('dumpDatabase')
  .input(z.object({ database: z.string() }))
  .argv(input => ['backup-database', input.database])
  .on(hostOne, hostTwo)
  .recovery('park');

const certDaysLeft = H.command('certificateDaysLeft')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['cert-days-left', input.domain])
  .on(hostOne, hostTwo)
  .recovery('rerun');

const renewCertificate = H.command('renewCertificate')
  .input(z.object({ domain: z.string() }))
  .argv(input => ['renew-certificate', input.domain])
  .on(hostOne, hostTwo)
  .recovery('rerun');

const pageOnCall = H.command('pageOnCall')
  .input(z.object({ title: z.string() }))
  .argv(input => ['page-oncall', input.title])
  .on(local)
  .recovery('park');

const runbook = H.command('runIncidentRunbook')
  .input(z.object({ source: z.string() }))
  .argv(input => ['runbook', input.source])
  .on(local)
  .recovery('park');

const acknowledgement = H.halt('incidentAcknowledged', z.object({ by: z.string() }));
const resolutionConfirmed = H.halt('incidentResolutionConfirmed', z.object({ resolved: z.boolean(), note: z.string() }));

const heartbeatFlow = H.flow('heartbeatCheck')
  .for(heartbeat)
  .does(async ctx => {
    const result = await ctx.run(probe, { url: ctx.unit.data.url });
    return result.ok ? 'healthy' : 'unhealthy';
  });

const backupFlow = H.flow('nightlyBackup')
  .for(backup)
  .does(async ctx => {
    const result = await ctx.run(dumpDatabase, { database: ctx.unit.data.database });
    return result.ok ? 'backedUp' : 'backupFailed';
  });

const renewalFlow = H.flow('certificateRenewal')
  .for(renewal)
  .does(async ctx => {
    const checked = await ctx.run(certDaysLeft, { domain: ctx.unit.data.domain });
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.daysLeft >= 14) return 'certValid';
    const renewed = await ctx.run(renewCertificate, { domain: ctx.unit.data.domain });
    return renewed.ok ? 'certRenewed' : 'certFailed';
  });

const incidentFlow = H.flow('incidentRunbook')
  .for(incident)
  .does(async ctx => {
    const { title, source } = ctx.unit.data;
    const paged = await ctx.run(pageOnCall, { title });
    if (!paged.ok) return ctx.fail(paged.error);
    await ctx.halt(acknowledgement, `Acknowledge incident: ${title}`);
    const ran = await ctx.run(runbook, { source });
    if (!ran.ok) return ctx.fail(ran.error);
    const confirmation = await ctx.halt(resolutionConfirmed, `Runbook output for ${title}:\n${ran.value}\n\nIs it resolved?`);
    return confirmation.resolved ? 'incidentResolved' : 'incidentUnresolved';
  });

const services = [
  { service: 'api', url: 'https://api.internal/health' },
  { service: 'queue', url: 'https://queue.internal/health' },
];
const databases = ['orders', 'users'];
const domains = ['example.com', 'api.example.com'];

const heartbeatSchedule = H.schedule('heartbeatEveryFiveMinutes', heartbeat, { every: { minutes: 5 } }, () =>
  services.map(service => ({ create: service }))
);
const backupSchedule = H.schedule('backupNightly', backup, { daily: '01:00' }, () =>
  databases.map(database => ({ create: { database } }))
);
const renewalSchedule = H.schedule('certificateWeekly', renewal, { weekly: { day: 'sun', at: '04:00' } }, () =>
  domains.map(domain => ({ create: { domain } }))
);

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(heartbeatFlow)
  .retries(0, { exhausted: 'unhealthy' })
  .suppliers(heartbeatSchedule);

const backups = H.lane('backups', backup)
  .handler(backupFlow)
  .retries(0, { exhausted: 'backupFailed' })
  .suppliers(backupSchedule);

const renewals = H.lane('renewals', renewal)
  .handler(renewalFlow)
  .retries(2, { backoff: { first: { hours: 1 }, factor: 2 }, exhausted: 'certFailed' })
  .suppliers(renewalSchedule);

const incidents = H.lane('incidents', incident)
  .handler(incidentFlow)
  .retries(1, { backoff: { first: { minutes: 1 } }, exhausted: 'incidentUnresolved' })
  .suppliers(H.operator)
  .store(sqlite.store(incident, '.harness/incidents.db'));

const heartbeatStreak = H.trigger(
  'threeFailedHeartbeatsOpenIncident',
  H.on.streak(heartbeat, 'unhealthy', 3, data => data.service),
  (event, act) =>
    act.create(
      incidents,
      { title: `${event.unit.data.service} failed three heartbeats in a row`, source: event.unit.data.service },
      `heartbeat-${event.unit.data.service}`
    )
);

const failedBackup = H.trigger('failedBackupOpensIncident', H.on.enters(backup, 'backupFailed'), (event, act) =>
  act.create(
    incidents,
    { title: `Backup of ${event.unit.data.database} failed`, source: `backup-${event.unit.data.database}` },
    `backup-${event.unit.key}`
  )
);

const slowBackupMs = 2 * 60 * 60 * 1000;

const slowBackup = H.trigger('slowBackupNote', H.on.enters(backup, 'backedUp'), (event, act) => {
  const tookMs = event.attempt?.durationMs ?? 0;
  if (tookMs <= slowBackupMs) return [];
  return act.remember(opsJournal, {
    text: `When scheduling the ${event.unit.data.database} backup, start it earlier or check disk throughput first`,
    because: `the backup on ${event.at.toISOString()} took ${Math.round(tookMs / 60000)} minutes`,
    when: { kinds: [backup] },
  });
});

const rank = (unit: PendingView): number => {
  if (unit.is(incident)) return 0;
  if (unit.is(heartbeat)) return 1;
  if (unit.is(backup)) return 2;
  return 3;
};

const incidentsFirst = H.policy.scheduler('incidentsPreempt', view => {
  const incidentPending = view.pending.some(unit => unit.is(incident));
  const incidentLive = view.live.some(unit => unit.is(incident)) || incidentPending;
  const start = view.pending
    .filter(unit => !(incidentLive && unit.is(backup)))
    .sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs);
  const preempt = incidentPending
    ? view.live.filter(unit => unit.position === 'active' && (unit.is(heartbeat) || unit.is(renewal)))
    : [];
  return { start, preempt };
});

const control = http.control({
  port: 8080,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
});

const incidentNotice = slack.notify({
  webhook: H.env('SLACK_INCIDENT_WEBHOOK'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === incident.name
      ? `Incident ${entry.unit ?? ''} moved to ${entry.to}${entry.reason === undefined ? '' : `: ${entry.reason}`}`
      : null,
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/operations.db'))
  .lanes(heartbeats, backups, renewals, incidents)
  .triggers(heartbeatStreak, failedBackup, slowBackup)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentNotice, markdown.board('BOARD.md'));

export const running = operations.start();
