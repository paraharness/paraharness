import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';

const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');
const completed = H.state('completed', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');
const renewed = H.state('renewed', 'terminal', 'success');
const current = H.state('current', 'terminal', 'neutral');
const open = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');
const unresolved = H.state('unresolved', 'terminal', 'failure');

const heartbeat = H.kind('heartbeat').data(z.object({ service: z.string(), url: z.string() })).states(due, healthy, unhealthy);
const backup = H.kind('backup').data(z.object({ database: z.string(), host: z.string() })).states(due, completed, failed);
const renewal = H.kind('certificate-renewal').data(z.object({ domain: z.string() })).states(due, renewed, current, failed);
const incident = H.kind('incident')
  .data(z.object({ title: z.string(), cause: z.string(), service: z.string().optional() }))
  .states(open, resolved, unresolved);

const local = shell.local('local', { slots: 8 });
const diskPreflight = ['check-disk-space', '--path', '/var/backups', '--min-free-gb', '50'];
const opsOne = ssh.host('ops-1', { address: 'ops-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskPreflight });
const opsTwo = ssh.host('ops-2', { address: 'ops-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskPreflight });

const probe = H.command('probe-service')
  .input(z.object({ url: z.string() }))
  .argv(i => ['curl', '-fsS', '--max-time', '10', i.url])
  .on(local)
  .recovery('rerun');

const backupInput = z.object({ database: z.string() });
const backupOnOpsOne = H.command('backup-on-ops-1').input(backupInput).argv(i => ['run-backup', i.database]).on(opsOne).recovery('rerun');
const backupOnOpsTwo = H.command('backup-on-ops-2').input(backupInput).argv(i => ['run-backup', i.database]).on(opsTwo).recovery('rerun');

const certificateDays = H.command('certificate-days')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(i => ['cert-days-left', i.domain])
  .on(opsOne, opsTwo)
  .recovery('rerun');
const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv(i => ['renew-cert', i.domain])
  .on(opsOne, opsTwo)
  .recovery('rerun');

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(i => ['page', '--rotation', 'platform', '--summary', i.title])
  .on(local)
  .recovery('park');
const runbook = H.command('incident-runbook')
  .input(z.object({ title: z.string(), cause: z.string() }))
  .argv(i => ['runbook', '--incident', i.title, '--cause', i.cause])
  .on(local)
  .recovery('park');

const acknowledge = H.halt('acknowledge-incident', z.object({ acknowledgedBy: z.string() }));
const confirmResolution = H.halt('confirm-resolution', z.object({ resolved: z.boolean(), note: z.string() }));

const checkHeartbeat = H.flow('check-heartbeat')
  .for(heartbeat)
  .does(async ctx => {
    const probed = await ctx.run(probe, { url: ctx.unit.data.url });
    return probed.ok ? 'healthy' : 'unhealthy';
  });

const runBackup = H.flow('run-backup')
  .for(backup)
  .does(async ctx => {
    const command = ctx.unit.data.host === 'ops-2' ? backupOnOpsTwo : backupOnOpsOne;
    const ran = await ctx.run(command, { database: ctx.unit.data.database });
    return ran.ok ? 'completed' : 'failed';
  });

const renewWhenDue = H.flow('renew-when-due')
  .for(renewal)
  .does(async ctx => {
    const checked = await ctx.run(certificateDays, { domain: ctx.unit.data.domain });
    if (!checked.ok) return 'failed';
    if (checked.value.daysLeft >= 14) return 'current';
    const done = await ctx.run(renewCertificate, { domain: ctx.unit.data.domain });
    return done.ok ? 'renewed' : 'failed';
  });

const respond = H.flow('respond-to-incident')
  .for(incident)
  .does(async ctx => {
    const { title, cause } = ctx.unit.data;
    await ctx.run(pageOnCall, { title });
    await ctx.halt(acknowledge, `Acknowledge incident: ${title} (${cause})`);
    for (let round = 1; round <= 3; round++) {
      const ran = await ctx.run(runbook, { title, cause });
      const confirmed = await ctx.halt(
        confirmResolution,
        ran.ok ? `Runbook finished:\n${ran.value}` : `Runbook failed: ${ran.error}`
      );
      if (confirmed.resolved) return 'resolved';
    }
    return 'unresolved';
  });

const services = [
  { service: 'api', url: 'https://api.internal/health' },
  { service: 'auth', url: 'https://auth.internal/health' },
  { service: 'queue', url: 'https://queue.internal/health' },
];
const databases = [
  { database: 'orders', host: 'ops-1' },
  { database: 'users', host: 'ops-2' },
];
const domains = ['example.com', 'api.example.com'];

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat)
  .suppliers(
    H.clock('heartbeat-every-five-minutes', heartbeat, { every: { minutes: 5 } }, tick =>
      services.map(s => ({ create: s, key: `${s.service}-${tick.now.toISOString()}` }))
    )
  );
const backups = H.lane('backups', backup)
  .handler(runBackup)
  .suppliers(
    H.clock('nightly-backups', backup, { daily: '01:00' }, tick =>
      databases.map(d => ({ create: d, key: `${d.database}-${tick.now.toISOString().slice(0, 10)}` }))
    )
  );
const renewals = H.lane('renewals', renewal)
  .handler(renewWhenDue)
  .suppliers(
    H.clock('weekly-certificates', renewal, { weekly: { day: 'mon', at: '04:00' } }, tick =>
      domains.map(domain => ({ create: { domain }, key: `${domain}-${tick.now.toISOString().slice(0, 10)}` }))
    )
  );
const incidents = H.lane('incidents', incident).handler(respond).suppliers(H.operator);

const operationalExperience = H.journal(
  'operational-experience',
  H.memory('operational-experience', 'experience'),
  jsonl.memory('memory/operations.jsonl')
);

const heartbeatStreakOpensIncident = H.trigger(
  'three-failed-heartbeats',
  H.on.streak(heartbeat, 'unhealthy', 3, data => data.service),
  (event, act) =>
    act.create(incidents, {
      title: `${event.unit.data.service} failed three heartbeats in a row`,
      cause: `last probe of ${event.unit.data.url} at ${event.at.toISOString()}`,
      service: event.unit.data.service,
    })
);

const failedBackupOpensIncident = H.trigger('failed-backup', H.on.enters(backup, 'failed'), (event, act) =>
  act.create(incidents, {
    title: `Backup of ${event.unit.data.database} failed`,
    cause: `backup on ${event.unit.data.host} failed at ${event.at.toISOString()}`,
  })
);

const slowBackupNotes = H.trigger('slow-backup-note', H.on.enters(backup, 'completed'), (event, act) => {
  const durationMs = event.attempt ? event.attempt.durationMs : 0;
  if (durationMs <= 2 * 60 * 60 * 1000) return [];
  const hours = (durationMs / 3600000).toFixed(1);
  return act.remember(operationalExperience, {
    text: `When scheduling the ${event.unit.data.database} backup on ${event.unit.data.host}, start it earlier or split it`,
    because: `the backup of ${event.at.toISOString().slice(0, 10)} took ${hours} hours`,
    when: { kinds: [backup] },
  });
});

const incidentsPreempt = H.policy.scheduler('incidents-preempt', view => {
  const incidentOpen = view.active.some(u => u.is(incident)) || view.waiting.some(u => u.is(incident));
  const pendingIncidents = view.pending.filter(u => u.is(incident));
  const others = view.pending.filter(u => !u.is(incident) && !(incidentOpen && u.is(backup)));
  const preempt = pendingIncidents.length > 0 ? view.active.filter(u => !u.is(backup) && !u.is(incident)) : [];
  return { start: [...pendingIncidents, ...others], preempt };
});

const operationsReport = H.report('operations', metrics => ({
  'healthy heartbeats, 1d': metrics.rate({
    among: { entry: 'transition', kind: heartbeat, position: 'terminal' },
    count: { entry: 'transition', kind: heartbeat, verdict: 'success' },
    days: 1,
  }),
  'median backup duration, 14d': metrics.median({ of: 'durationMs', among: { entry: 'attempt', kind: backup, outcome: 'succeeded' }, days: 14 }),
  'incidents opened, 30d': metrics.count({ of: { entry: 'transition', kind: incident, state: open }, days: 30 }),
  'median time to acknowledge, 30d': metrics.median({ of: 'decisionMs', among: { entry: 'halt', halt: acknowledge, status: 'resolved' }, days: 30 }),
}));

const controlApi = http.control({
  port: 8080,
  token: H.env('CONTROL_TOKEN'),
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(acknowledge, confirmResolution, H.halts.changed, H.halts.interrupted),
    H.ops.readMemory,
    H.ops.readTelemetry,
  ],
});

const incidentNotices = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'created'} -> ${entry.to}${entry.reason ? ` (${entry.reason})` : ''}`
      : null,
});

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(heartbeatStreakOpensIncident, failedBackupOpensIncident, slowBackupNotes)
  .scheduler(incidentsPreempt)
  .reports(operationsReport)
  .clients(controlApi)
  .observers(incidentNotices, markdown.board('BOARD.md'));

export const running = harness.start();
