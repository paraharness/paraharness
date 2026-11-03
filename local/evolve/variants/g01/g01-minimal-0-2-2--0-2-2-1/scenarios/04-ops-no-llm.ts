import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';

const services = ['api', 'web', 'worker'];
const databases = ['orders', 'users'];
const domains = ['example.com', 'api.example.com'];

const due = H.state('due', 'pending');
const up = H.state('up', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');
const backedUp = H.state('backed-up', 'terminal', 'success');
const backupFailed = H.state('backup-failed', 'terminal', 'failure');
const stillValid = H.state('still-valid', 'terminal', 'success');
const renewed = H.state('renewed', 'terminal', 'success');
const renewalFailed = H.state('renewal-failed', 'terminal', 'failure');
const incidentOpen = H.state('incident-open', 'pending');
const incidentResolved = H.state('incident-resolved', 'terminal', 'success');
const incidentUnresolved = H.state('incident-unresolved', 'terminal', 'failure');

const heartbeat = H.kind('heartbeat').data(z.object({ service: z.string() })).states(due, up, down);
const backup = H.kind('backup').data(z.object({ database: z.string(), night: z.string() })).states(due, backedUp, backupFailed);
const renewal = H.kind('certificate-renewal').data(z.object({ domain: z.string() })).states(due, stillValid, renewed, renewalFailed);
const incident = H.kind('incident')
  .data(z.object({ title: z.string(), detail: z.string() }))
  .states(incidentOpen, incidentResolved, incidentUnresolved);

const local = shell.local('local', { slots: 4 });
const hostKey = H.env('OPS_SSH_KEY');
const diskPreflight = ['test "$(df --output=avail -k /var/backups | tail -1)" -gt 10485760'];
const dbHostA = ssh.host('db-host-a', { address: '10.0.0.11', user: 'ops', key: hostKey, slots: 1, preflight: diskPreflight });
const dbHostB = ssh.host('db-host-b', { address: '10.0.0.12', user: 'ops', key: hostKey, slots: 1, preflight: diskPreflight });

const probe = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(target => ['./scripts/probe', target.service])
  .on(local)
  .recovery('rerun');
const dumpDatabase = H.command('dump-database')
  .input(z.object({ database: z.string(), night: z.string() }))
  .argv(target => ['backup-db', target.database, `--label=${target.night}`])
  .on(dbHostA, dbHostB)
  .recovery('rerun');
const checkCertificate = H.command('check-certificate')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(target => ['cert-days-left', target.domain])
  .on(dbHostA, dbHostB)
  .recovery('rerun');
const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv(target => ['renew-cert', target.domain])
  .on(dbHostA, dbHostB)
  .recovery('rerun');
const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string(), detail: z.string() }))
  .argv(page => ['pager', 'trigger', '--title', page.title, '--detail', page.detail])
  .on(local)
  .recovery('park');
const runbook = H.command('run-runbook')
  .input(z.object({ title: z.string() }))
  .argv(target => ['./runbooks/respond', target.title])
  .on(local)
  .recovery('park');

const incidentAcknowledged = H.halt('incident-acknowledged', z.object({ by: z.string() }));
const resolutionConfirmed = H.halt('resolution-confirmed', z.object({ resolved: z.boolean(), note: z.string().optional() }));

const checkHeartbeat = H.flow('check-heartbeat').for(heartbeat).does(async ctx => {
  const probed = await ctx.run(probe, { service: ctx.unit.data.service });
  return probed.ok ? 'up' : 'down';
});

const runBackup = H.flow('run-backup').for(backup).does(async ctx => {
  const dumped = await ctx.run(dumpDatabase, ctx.unit.data);
  return dumped.ok ? 'backed-up' : 'backup-failed';
});

const checkRenewal = H.flow('check-renewal').for(renewal).does(async ctx => {
  const { domain } = ctx.unit.data;
  const checked = await ctx.run(checkCertificate, { domain });
  if (!checked.ok) return ctx.fail(checked.error);
  if (checked.value.daysLeft >= 14) return 'still-valid';
  const renewal = await ctx.run(renewCertificate, { domain });
  return renewal.ok ? 'renewed' : 'renewal-failed';
});

const respondToIncident = H.flow('respond-to-incident').for(incident).does(async ctx => {
  const { title, detail } = ctx.unit.data;
  const paged = await ctx.run(pageOnCall, { title, detail });
  if (!paged.ok) return ctx.fail(paged.error);
  await ctx.halt(incidentAcknowledged, `Acknowledge incident: ${title}`);
  for (let pass = 0; pass < 3; pass++) {
    const ran = await ctx.run(runbook, { title });
    const confirmation = await ctx.halt(resolutionConfirmed, ran.ok ? ran.value : `Runbook failed: ${ran.error}`);
    if (confirmation.resolved) return 'incident-resolved';
  }
  return 'incident-unresolved';
});

const dateOf = (now: Date): string => now.toISOString().slice(0, 10);

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat)
  .suppliers(H.clock('heartbeat-schedule', heartbeat, { every: { minutes: 5 } }, tick =>
    services.map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))))
  .retries(0, { exhausted: 'down' });

const backups = H.lane('backups', backup)
  .handler(runBackup)
  .suppliers(H.clock('backup-schedule', backup, { daily: '01:00' }, tick =>
    databases.map(database => ({ create: { database, night: dateOf(tick.now) }, key: `${database}-${dateOf(tick.now)}` }))))
  .store(sqlite.store(backup, '.harness/ops.db'))
  .retries(0, { exhausted: 'backup-failed' });

const renewals = H.lane('renewals', renewal)
  .handler(checkRenewal)
  .suppliers(H.clock('renewal-schedule', renewal, { weekly: { day: 'mon', at: '04:00' } }, tick =>
    domains.map(domain => ({ create: { domain }, key: `${domain}-${dateOf(tick.now)}` }))))
  .store(sqlite.store(renewal, '.harness/ops.db'))
  .retries(2, { backoff: { first: { minutes: 30 }, factor: 2 }, exhausted: 'renewal-failed' });

const incidents = H.lane('incidents', incident)
  .handler(respondToIncident)
  .suppliers(H.operator)
  .store(sqlite.store(incident, '.harness/ops.db'))
  .retries(1, { backoff: { first: { minutes: 1 } }, exhausted: 'incident-unresolved' });

const operationalExperience = H.memory('operational-experience', 'experience');
const opsJournal = H.library('ops-journal', operationalExperience, jsonl.memory('.harness/ops-notes.jsonl'));

const twoHoursMs = 2 * 60 * 60 * 1000;

const missedHeartbeats = H.trigger('three-missed-heartbeats', H.on.streak(heartbeat, 'down', 3, data => data.service), (event, act) =>
  act.create(incidents, {
    title: `${event.unit.data.service} missed three heartbeats`,
    detail: `Third consecutive failure: ${event.unit.key} at ${event.at.toISOString()}`,
  }, `heartbeat-${event.unit.data.service}-${event.at.toISOString()}`));

const failedBackup = H.trigger('failed-backup-opens-incident', H.on.enters(backup, 'backup-failed'), (event, act) =>
  act.create(incidents, {
    title: `Backup of ${event.unit.data.database} failed`,
    detail: `Backup ${event.unit.key} failed at ${event.at.toISOString()}`,
  }, `backup-${event.unit.key}`));

const slowBackupNote = H.trigger('slow-backup-note', H.on.enters(backup, 'backed-up'), (event, act) => {
  const tookMs = event.attempt?.durationMs ?? 0;
  if (tookMs <= twoHoursMs) return [];
  return act.remember(opsJournal, {
    text: `When planning maintenance near the ${event.unit.data.database} backup, allow more than two hours for it`,
    because: `the backup of ${event.unit.data.night} took ${Math.round(tookMs / 60000)} minutes`,
    when: { kinds: [backup] },
  });
});

const incidentsFirst = H.policy.scheduler('incidents-first', view => {
  const incidentPending = view.pending.some(unit => unit.is(incident));
  const incidentOngoing = incidentPending || view.live.some(unit => unit.is(incident));
  const rank = (unit: PendingView): number => {
    if (unit.is(incident)) return 0;
    if (unit.is(heartbeat)) return 1;
    if (unit.is(renewal)) return 2;
    return 3;
  };
  const start = view.pending
    .filter(unit => !(incidentOngoing && unit.is(backup)))
    .sort((a, b) => rank(a) - rank(b));
  const preempt = incidentPending
    ? view.live.filter(unit => unit.is(renewal) && unit.position === 'active')
    : [];
  return { start, preempt };
});

const incidentNotifier = slack.notify({
  webhook: H.env('SLACK_INCIDENT_WEBHOOK'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'created'} -> ${entry.to}${entry.reason ? ` (${entry.reason})` : ''}`
      : null,
});

const control = http.control({
  port: 8787,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(incidentAcknowledged, resolutionConfirmed, H.halts.interrupted),
    H.ops.readMemory,
    H.ops.readTelemetry,
  ],
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(missedHeartbeats, failedBackup, slowBackupNote)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentNotifier, markdown.board('BOARD.md'));
