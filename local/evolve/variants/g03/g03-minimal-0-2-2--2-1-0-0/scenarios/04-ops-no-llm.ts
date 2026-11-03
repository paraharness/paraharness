import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const heartbeat = H.kind('heartbeat')
  .data(z.object({ service: z.string() }))
  .states(H.state('due', 'pending'), H.state('up', 'terminal', 'success'), H.state('down', 'terminal', 'failure'));

const backup = H.kind('backup')
  .data(z.object({ database: z.string() }))
  .states(H.state('scheduled', 'pending'), H.state('backed-up', 'terminal', 'success'), H.state('backup-failed', 'terminal', 'failure'));

const renewal = H.kind('certificate-renewal')
  .data(z.object({ domain: z.string() }))
  .states(
    H.state('check-due', 'pending'),
    H.state('still-valid', 'terminal', 'neutral'),
    H.state('renewed', 'terminal', 'success'),
    H.state('renewal-failed', 'terminal', 'failure')
  );

const incident = H.kind('incident')
  .data(z.object({ title: z.string(), origin: z.string() }))
  .states(H.state('open', 'pending'), H.state('resolved', 'terminal', 'success'), H.state('unresolved', 'terminal', 'failure'));

const operationalKind = H.memory('operational-experience', 'experience');
const operations = H.journal('operations', operationalKind, jsonl.memory('.harness/operations.jsonl'));

const local = shell.local('local', { slots: 8 });
const diskSpace = H.command('disk-space-preflight').argv(() => ['check-disk', '--min-free-gb', '20']);
const sshKey = H.env('OPS_SSH_KEY');
const dbHostOne = ssh.host('db-host-1', { address: 'db1.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskSpace });
const dbHostTwo = ssh.host('db-host-2', { address: 'db2.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskSpace });

const probe = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .recovery('rerun');

const runBackup = H.command('run-backup')
  .input(z.object({ database: z.string() }))
  .argv(input => ['backup-database', input.database])
  .on(dbHostOne, dbHostTwo)
  .recovery('rerun');

const certificateDays = H.command('certificate-days-left')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['cert-days-left', input.domain])
  .on(dbHostOne, dbHostTwo)
  .recovery('rerun');

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv(input => ['renew-cert', input.domain])
  .on(dbHostOne, dbHostTwo)
  .recovery('rerun');

const pageOncall = H.command('page-oncall')
  .input(z.object({ title: z.string() }))
  .argv(input => ['page-oncall', input.title])
  .on(local);

const runbook = H.command('incident-runbook')
  .input(z.object({ title: z.string() }))
  .argv(input => ['run-runbook', input.title])
  .on(local);

const acknowledgement = H.halt('incident-acknowledgement', z.object({ by: z.string() }));
const resolutionCheck = H.halt('incident-resolution', z.object({ resolved: z.boolean(), note: z.string() }));

const checkHeartbeat = H.flow('check-heartbeat')
  .for(heartbeat)
  .does(async ctx => {
    const probed = await ctx.run(probe, { service: ctx.unit.data.service });
    return probed.ok ? 'up' : 'down';
  });

const takeBackup = H.flow('take-backup')
  .for(backup)
  .does(async ctx => {
    const done = await ctx.run(runBackup, { database: ctx.unit.data.database });
    return done.ok ? 'backed-up' : 'backup-failed';
  });

const checkCertificate = H.flow('check-certificate')
  .for(renewal)
  .does(async ctx => {
    const checked = await ctx.run(certificateDays, { domain: ctx.unit.data.domain });
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.daysLeft >= 14) return 'still-valid';
    const renewed = await ctx.run(renewCertificate, { domain: ctx.unit.data.domain });
    return renewed.ok ? 'renewed' : 'renewal-failed';
  });

const respond = H.flow('respond-to-incident')
  .for(incident)
  .does(async ctx => {
    const paged = await ctx.run(pageOncall, { title: ctx.unit.data.title });
    if (!paged.ok) return ctx.fail(paged.error);
    await ctx.halt(acknowledgement, `Acknowledge incident: ${ctx.unit.data.title}`);
    const ran = await ctx.run(runbook, { title: ctx.unit.data.title });
    const confirmation = await ctx.halt(
      resolutionCheck,
      ran.ok ? `Runbook finished for ${ctx.unit.data.title}. Confirm resolution.` : `Runbook failed: ${ran.error}`
    );
    return confirmation.resolved ? 'resolved' : 'unresolved';
  });

const services = ['api', 'web', 'queue'];
const databases = ['orders', 'customers'];
const domains = ['example.com', 'api.example.com'];

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat)
  .retries(0, { exhausted: 'down' })
  .suppliers(
    H.schedule('heartbeat-every-five-minutes', heartbeat, { every: { minutes: 5 } }, (tick, supply) =>
      services.map(service => supply.create({ service }))
    )
  );

const backups = H.lane('backups', backup)
  .handler(takeBackup)
  .retries(0, { exhausted: 'backup-failed' })
  .suppliers(
    H.schedule('nightly-backups', backup, { daily: '01:00' }, (tick, supply) =>
      databases.map(database => supply.create({ database }))
    )
  );

const renewals = H.lane('certificate-renewals', renewal)
  .handler(checkCertificate)
  .retries(1, { backoff: { first: { hours: 1 } }, exhausted: 'renewal-failed' })
  .suppliers(
    H.schedule('weekly-certificate-check', renewal, { weekly: { day: 'mon', at: '04:00' } }, (tick, supply) =>
      domains.map(domain => supply.create({ domain }))
    )
  );

const incidents = H.lane('incidents', incident)
  .handler(respond)
  .retries(0, { exhausted: 'unresolved' })
  .suppliers(H.operator);

const heartbeatStreak = H.trigger(
  'three-down-heartbeats-open-incident',
  H.on.streak(heartbeat, 'down', 3, data => data.service),
  (event, act) =>
    act.create(
      incidents,
      { title: `${event.unit.data.service} failed three heartbeats in a row`, origin: 'heartbeat' },
      `incident-heartbeat-${event.unit.data.service}`
    )
);

const backupFailed = H.trigger('failed-backup-opens-incident', H.on.enters(backup, 'backup-failed'), (event, act) =>
  act.create(incidents, { title: `Backup of ${event.unit.data.database} failed`, origin: 'backup' })
);

const twoHoursMs = 2 * 60 * 60 * 1000;

const slowBackup = H.trigger('slow-backup-noted', H.on.enters(backup, 'backed-up'), (event, act) =>
  event.attempt !== undefined && event.attempt.durationMs > twoHoursMs
    ? act.remember(operations, {
        text: `When scheduling the ${event.unit.data.database} backup, start it earlier or check host load first`,
        because: `the backup took ${Math.round(event.attempt.durationMs / 60000)} minutes on ${event.at.toISOString()}`,
        when: { kinds: [backup] },
      })
    : []
);

const incidentsFirst = H.policy.scheduler('incidents-preempt', view => {
  const incidentPending = view.pending.some(unit => unit.is(incident));
  const incidentOpen = incidentPending || view.live.some(unit => unit.is(incident));
  return {
    start: view
      .sorted(unit => (unit.is(incident) ? 0 : unit.is(heartbeat) ? 1 : unit.is(renewal) ? 2 : 3))
      .filter(unit => !(incidentOpen && unit.is(backup))),
    preempt: incidentPending ? view.live.filter(unit => unit.is(renewal)) : [],
  };
});

export const operationsHarness = H.harness('platform-operations')
  .ledger(sqlite.ledger('.harness/ops-ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(heartbeatStreak, backupFailed, slowBackup)
  .scheduler(incidentsFirst)
  .clients(
    http.control({
      port: 7300,
      token: H.env('OPS_CONTROL_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
    })
  )
  .observers(
    slack.notify({
      webhook: H.env('OPS_SLACK_WEBHOOK'),
      message: entry =>
        entry.entry === 'transition' && entry.kind === incident.name
          ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'new'} -> ${entry.to}`
          : null,
    }),
    markdown.board('BOARD.md')
  );
