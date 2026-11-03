import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';
import { z } from 'zod';

const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');
const backedUp = H.state('backed-up', 'terminal', 'success');
const backupFailed = H.state('backup-failed', 'terminal', 'failure');
const current = H.state('current', 'terminal', 'neutral');
const renewed = H.state('renewed', 'terminal', 'success');
const renewalFailed = H.state('renewal-failed', 'terminal', 'failure');
const open = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');

const heartbeat = H.kind('heartbeat').data(z.object({ service: z.string() })).states(due, healthy, unhealthy);
const backup = H.kind('backup').data(z.object({ database: z.string() })).states(due, backedUp, backupFailed);
const renewal = H.kind('certificate-renewal').data(z.object({ domain: z.string() })).states(due, current, renewed, renewalFailed);
const incident = H.kind('incident').data(z.object({ title: z.string(), source: z.string() })).states(open, resolved);

const services = ['api', 'web', 'worker'];
const databases = ['orders', 'customers'];
const domains = ['example.com', 'api.example.com'];

const local = shell.local('local', { slots: 8 });
const diskPreflight = ['test $(df --output=avail -BG / | tail -1 | tr -dc 0-9) -ge 50'];
const hostOne = ssh.host('ops-1', { address: 'ops-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskPreflight });
const hostTwo = ssh.host('ops-2', { address: 'ops-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1, preflight: diskPreflight });

const probe = H.command('probe')
  .input(z.object({ service: z.string() }))
  .argv((i) => ['curl', '-fsS', `https://${i.service}.internal/health`])
  .on(local);
const dumpDatabase = H.command('dump-database')
  .input(z.object({ database: z.string() }))
  .argv((i) => ['backup-db', i.database])
  .on(hostOne, hostTwo)
  .recovery('rerun');
const checkCertificate = H.command('check-certificate')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv((i) => ['cert-days-left', '--json', i.domain])
  .on(hostOne, hostTwo);
const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv((i) => ['certbot', 'renew', '--cert-name', i.domain])
  .on(hostOne, hostTwo)
  .recovery('rerun');
const runbook = H.command('runbook')
  .input(z.object({ title: z.string(), source: z.string() }))
  .argv((i) => ['run-runbook', i.source, i.title])
  .on(local)
  .recovery('park');

const acknowledge = H.halt('incident-acknowledgement', z.object({ acknowledgedBy: z.string() }))
  .about(z.object({ title: z.string(), source: z.string() }));
const confirmResolution = H.halt('incident-resolution', z.object({ resolved: z.boolean(), notes: z.string() }))
  .about(z.object({ title: z.string(), source: z.string(), runbookOk: z.boolean() }));

const checkHeartbeat = H.flow('check-heartbeat')
  .for(heartbeat)
  .does(async (ctx) => {
    const result = await ctx.run(probe, { service: ctx.unit.data.service });
    return result.ok ? 'healthy' : 'unhealthy';
  });
const runBackup = H.flow('run-backup')
  .for(backup)
  .does(async (ctx) => {
    const dumped = await ctx.run(dumpDatabase, { database: ctx.unit.data.database });
    return dumped.ok ? 'backed-up' : ctx.fail(dumped.error);
  });
const renewIfExpiring = H.flow('renew-if-expiring')
  .for(renewal)
  .does(async (ctx) => {
    const domain = ctx.unit.data.domain;
    const checked = await ctx.run(checkCertificate, { domain });
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.daysLeft >= 14) return 'current';
    const renewedNow = await ctx.run(renewCertificate, { domain });
    return renewedNow.ok ? 'renewed' : ctx.fail(renewedNow.error);
  });
const incidentRunbook = H.flow('incident-runbook')
  .for(incident)
  .does(async (ctx) => {
    const { title, source } = ctx.unit.data;
    await ctx.halt(acknowledge, `Incident: ${title}`, { title, source });
    for (;;) {
      const ran = await ctx.run(runbook, { title, source });
      const confirmed = await ctx.halt(
        confirmResolution,
        ran.ok ? `Runbook finished for "${title}". Resolved?` : `Runbook failed for "${title}": ${ran.error}. Resolved?`,
        { title, source, runbookOk: ran.ok }
      );
      if (confirmed.resolved) return 'resolved';
    }
  });

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat)
  .suppliers(
    H.clock('heartbeat-every-five-minutes', heartbeat, { every: { minutes: 5 } }, (tick) =>
      services.map((service) => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
    )
  );
const backups = H.lane('backups', backup)
  .handler(runBackup)
  .suppliers(
    H.clock('nightly-backups', backup, { daily: '01:00' }, (tick) =>
      databases.map((database) => ({ create: { database }, key: `${database}-${tick.now.toISOString().slice(0, 10)}` }))
    )
  )
  .store(sqlite.store(backup, 'harness/backups.db'))
  .retry(H.retry({ times: 0 }), 'backup-failed');
const renewals = H.lane('renewals', renewal)
  .handler(renewIfExpiring)
  .suppliers(
    H.clock('weekly-certificate-check', renewal, { weekly: { day: 'mon', at: '04:00' } }, (tick) =>
      domains.map((domain) => ({ create: { domain }, key: `${domain}-${tick.now.toISOString().slice(0, 10)}` }))
    )
  )
  .retry(H.retry({ times: 2, firstDelayMs: 600000 }), 'renewal-failed');
const incidents = H.lane('incidents', incident)
  .handler(incidentRunbook)
  .suppliers(H.operator)
  .store(sqlite.store(incident, 'harness/incidents.db'));

const operationalExperience = H.journal(
  'operational-experience',
  H.memory('operational-experience', 'experience'),
  jsonl.memory('memory/operations.jsonl')
);

const slowBackupMs = 2 * 3600000;

const heartbeatStreak = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(heartbeat, 'unhealthy', 3, (data) => data.service),
  (event, act) =>
    act.create(incidents, {
      title: `${event.unit.data.service} failed three heartbeats in a row`,
      source: `heartbeat:${event.unit.data.service}`,
    })
);
const backupFailure = H.trigger('failed-backup-opens-incident', H.on.enters(backup, 'backup-failed'), (event, act) =>
  act.create(incidents, { title: `Backup of ${event.unit.data.database} failed`, source: `backup:${event.unit.data.database}` })
);
const slowBackup = H.trigger('slow-backup-records-note', H.on.enters(backup, 'backed-up'), (event, act) => {
  const durationMs = event.attempt?.durationMs ?? 0;
  if (durationMs <= slowBackupMs) return [];
  return act.remember(operationalExperience, {
    text: `When scheduling the ${event.unit.data.database} backup, allow more than two hours and check host disk first`,
    because: `the backup on ${event.at.toISOString().slice(0, 10)} took ${(durationMs / 3600000).toFixed(1)} hours`,
    when: { kinds: [backup] },
    status: 'accepted',
  });
});

const incidentsFirst = H.policy.scheduler('incidents-preempt', (view) => {
  const isIncident = (kind: string) => kind === incident.name;
  const incidentOpen = [...view.pending, ...view.active, ...view.waiting].some((u) => isIncident(u.kind));
  const incidentPending = view.pending.some((u) => isIncident(u.kind));
  const startable = view.pending.filter((u) => !(incidentOpen && u.kind === backup.name));
  return {
    start: [...startable].sort((a, b) => Number(isIncident(b.kind)) - Number(isIncident(a.kind))),
    preempt: incidentPending ? view.active.filter((u) => u.kind === heartbeat.name || u.kind === renewal.name) : [],
  };
});

const operations = H.report('operations', (metrics) => ({
  'heartbeat success (24h)': metrics.successRate({ kind: heartbeat, hours: 24 }),
  'backup success (30d)': metrics.successRate({ kind: backup, days: 30 }),
  'backup duration (30d)': metrics.mean({ of: 'durationMs', among: { entry: 'attempt', kind: backup, outcome: 'succeeded' }, days: 30 }),
  'certificate renewals (90d)': metrics.count({ of: { entry: 'transition', kind: renewal, state: renewed }, days: 90 }),
  'incidents opened (30d)': metrics.count({ of: { entry: 'transition', kind: incident, state: open }, days: 30 }),
}));

export default H.harness('operations')
  .ledger(sqlite.ledger('harness/ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(heartbeatStreak, backupFailure, slowBackup)
  .scheduler(incidentsFirst)
  .reports(operations)
  .clients(
    http.control({
      port: 8080,
      token: H.env('OPS_CONTROL_TOKEN'),
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(acknowledge, confirmResolution, H.parked),
        H.ops.readMemory,
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(
    markdown.board('BOARD.md'),
    slack.notify({
      webhook: H.env('SLACK_WEBHOOK_URL'),
      message: (entry) => {
        if (entry.entry === 'transition' && entry.kind === incident.name) return `Incident ${entry.unit ?? ''} is now ${entry.to}`;
        if (entry.entry === 'halt' && entry.status === 'raised' && entry.kind === incident.name) return `Paging on-call: ${entry.show ?? entry.halt}`;
        return null;
      },
    })
  );
