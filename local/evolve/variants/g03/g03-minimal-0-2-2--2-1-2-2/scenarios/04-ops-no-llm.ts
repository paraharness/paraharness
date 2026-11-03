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
const backedUp = H.state('backed-up', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');
const valid = H.state('valid', 'terminal', 'success');
const renewed = H.state('renewed', 'terminal', 'success');
const open = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');
const unresolved = H.state('unresolved', 'terminal', 'failure');

const heartbeat = H.kind('Heartbeat').data(z.object({ service: z.string() })).states(due, healthy, unhealthy);
const backup = H.kind('Backup').data(z.object({ database: z.string() })).states(due, backedUp, failed);
const renewal = H.kind('CertificateRenewal').data(z.object({ domain: z.string() })).states(due, valid, renewed, failed);
const incident = H.kind('Incident').data(z.object({ title: z.string(), detail: z.string() })).states(open, resolved, unresolved);

const operationalExperience = H.memory('operational-experience', 'experience');
const opsJournal = H.journal('operational-experience', operationalExperience, jsonl.memory('./memory/operations.jsonl'));

const diskSpace = H.command('disk-space-preflight')
  .argv(() => ['sh', '-c', 'test "$(df --output=avail -BG / | tail -1 | tr -dc 0-9)" -ge 20']);

const local = shell.local('local', { slots: 8 });
const dbHostA = ssh.host('db-host-a', {
  address: 'db-a.internal',
  user: 'ops',
  key: H.env('SSH_KEY'),
  slots: 1,
  preflight: diskSpace,
});
const dbHostB = ssh.host('db-host-b', {
  address: 'db-b.internal',
  user: 'ops',
  key: H.env('SSH_KEY'),
  slots: 1,
  preflight: diskSpace,
});

const serviceHealth = H.command('service-health')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/healthz`])
  .on(local)
  .recovery('rerun');

const runBackup = H.command('run-backup')
  .input(z.object({ database: z.string() }))
  .argv(input => ['backup-db', input.database])
  .on(dbHostA, dbHostB)
  .recovery('rerun');

const certificateDaysLeft = H.command('certificate-days-left')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['cert-days-left', input.domain])
  .on(dbHostA, dbHostB)
  .recovery('rerun');

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv(input => ['certbot', 'renew', '--cert-name', input.domain])
  .on(dbHostA, dbHostB)
  .recovery('rerun');

const runbook = H.command('incident-runbook')
  .input(z.object({ title: z.string(), detail: z.string() }))
  .argv(input => ['runbook', '--incident', input.title, '--detail', input.detail])
  .on(local)
  .recovery('park');

const acknowledgement = H.halt('incident-acknowledgement', z.object({ by: z.string() }));
const resolution = H.halt('incident-resolution', z.object({ resolved: z.boolean(), note: z.string() }));

const checkService = H.flow('check-service')
  .for(heartbeat)
  .does(async ctx => {
    const result = await ctx.run(serviceHealth, { service: ctx.unit.data.service });
    return result.ok ? 'healthy' : ctx.fail(result.error);
  });

const backUpDatabase = H.flow('back-up-database')
  .for(backup)
  .does(async ctx => {
    const result = await ctx.run(runBackup, { database: ctx.unit.data.database });
    return result.ok ? 'backed-up' : ctx.fail(result.error);
  });

const renewWhenDue = H.flow('renew-when-due')
  .for(renewal)
  .does(async ctx => {
    const { domain } = ctx.unit.data;
    const check = await ctx.run(certificateDaysLeft, { domain });
    if (!check.ok) return ctx.fail(check.error);
    if (check.value.daysLeft >= 14) return 'valid';
    const renewal = await ctx.run(renewCertificate, { domain });
    return renewal.ok ? 'renewed' : ctx.fail(renewal.error);
  });

const respondToIncident = H.flow('respond-to-incident')
  .for(incident)
  .does(async ctx => {
    const { title, detail } = ctx.unit.data;
    await ctx.halt(acknowledgement, `Acknowledge incident: ${title}`);
    const ran = await ctx.run(runbook, { title, detail });
    if (!ran.ok) return ctx.fail(ran.error);
    const outcome = await ctx.halt(resolution, `Confirm the runbook resolved: ${title}\n\n${ran.value}`);
    return outcome.resolved ? 'resolved' : 'unresolved';
  });

const heartbeatSchedule = H.clock('heartbeat-every-five-minutes', heartbeat, { every: { minutes: 5 } }, () =>
  ['api', 'web', 'worker'].map(service => ({ create: { service }, key: service })));
const backupSchedule = H.clock('backup-nightly', backup, { daily: '01:00' }, () =>
  ['orders', 'users'].map(database => ({ create: { database }, key: database })));
const renewalSchedule = H.clock('certificate-weekly', renewal, { weekly: { day: 'sun', at: '03:00' } }, () =>
  ['example.com', 'api.example.com'].map(domain => ({ create: { domain }, key: domain })));

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkService)
  .retry({ times: 0, exhausted: 'unhealthy' })
  .suppliers(heartbeatSchedule);

const backups = H.lane('backups', backup)
  .handler(backUpDatabase)
  .retry({ times: 0, exhausted: 'failed' })
  .suppliers(backupSchedule)
  .store(sqlite.store(backup, './.harness/ops-units.sqlite'));

const renewals = H.lane('certificate-renewals', renewal)
  .handler(renewWhenDue)
  .retry({ times: 2, backoff: { first: { hours: 1 } }, exhausted: 'failed' })
  .suppliers(renewalSchedule)
  .store(sqlite.store(renewal, './.harness/ops-units.sqlite'));

const incidents = H.lane('incidents', incident)
  .handler(respondToIncident)
  .retry({ times: 1, exhausted: 'unresolved' })
  .suppliers(H.operator)
  .store(sqlite.store(incident, './.harness/ops-units.sqlite'));

const threeMissedHeartbeats = H.trigger(
  'three-missed-heartbeats-open-incident',
  H.on.streak(heartbeat, 'unhealthy', 3, data => data.service),
  (event, act) => act.create(incidents, {
    title: `${event.unit.data.service} failed three heartbeats in a row`,
    detail: `Last failure at ${event.at.toISOString()}`,
  }, `heartbeat-${event.unit.data.service}`),
);

const failedBackup = H.trigger(
  'failed-backup-opens-incident',
  H.on.enters(backup, 'failed'),
  (event, act) => act.create(incidents, {
    title: `Backup of ${event.unit.data.database} failed`,
    detail: `Failed at ${event.at.toISOString()}`,
  }, `backup-${event.unit.data.database}`),
);

const twoHoursMs = 2 * 60 * 60 * 1000;

const slowBackup = H.trigger(
  'slow-backup-noted',
  H.on.enters(backup, 'backed-up'),
  (event, act) => {
    const durationMs = event.attempt?.durationMs ?? 0;
    if (durationMs <= twoHoursMs) return [];
    return act.remember(opsJournal, {
      text: `When scheduling the ${event.unit.data.database} backup, start it earlier or split it`,
      because: `the backup on ${event.at.toISOString()} took ${Math.round(durationMs / 60000)} minutes`,
      when: { kinds: [backup] },
    });
  },
);

const incidentsPreempt = H.policy.scheduler('incidents-preempt', view => {
  const pendingIncidents = view.pending.filter(unit => unit.is(incident));
  const incidentActive = pendingIncidents.length > 0 || view.live.some(unit => unit.is(incident));
  const others = view.pending.filter(unit => !unit.is(incident) && !(incidentActive && unit.is(backup)));
  const preempt = pendingIncidents.length > 0
    ? view.live.filter(unit => unit.position === 'active' && !unit.is(incident) && !unit.is(backup))
    : [];
  return { start: [...pendingIncidents, ...others], preempt };
});

const control = http.control({
  port: 8080,
  token: H.env('CONTROL_TOKEN'),
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(acknowledgement, resolution, H.halts.interrupted, H.halts.definitionChanged),
    H.ops.readMemory,
    H.ops.readTelemetry,
  ],
});

const incidentNotifier = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  message: entry => entry.entry === 'transition' && entry.kind === incident.name
    ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'new'} → ${entry.to}`
    : null,
});

const harness = H.harness('operations')
  .ledger(sqlite.ledger('./.harness/operations.sqlite'))
  .lanes(heartbeats, backups, renewals, incidents)
  .triggers(threeMissedHeartbeats, failedBackup, slowBackup)
  .scheduler(incidentsPreempt)
  .clients(control)
  .observers(incidentNotifier, markdown.board('./BOARD.md'));

export const running = harness.start();
