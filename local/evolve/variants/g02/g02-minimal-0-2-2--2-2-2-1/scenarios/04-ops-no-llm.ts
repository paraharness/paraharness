import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });
const sshKey = H.env('OPS_SSH_KEY');
const diskPreflight = ['test "$(df --output=avail -k /var/backups | tail -1)" -gt 20971520'];
const dbEast = ssh.host('db-east', { address: 'db-east.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskPreflight });
const dbWest = ssh.host('db-west', { address: 'db-west.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskPreflight });

const due = H.state('due', 'pending');
const up = H.state('up', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');
const scheduled = H.state('scheduled', 'pending');
const done = H.state('done', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');
const valid = H.state('valid', 'terminal', 'success');
const renewed = H.state('renewed', 'terminal', 'success');
const open = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');

export const heartbeat = H.kind('heartbeat').data(z.object({ service: z.string() })).states(due, up, down);

const backupData = z.object({ database: z.string(), host: z.enum(['db-east', 'db-west']) });
export const backup = H.kind('backup').data(backupData).states(scheduled, done, failed);

export const certificateRenewal = H.kind('certificate-renewal').data(z.object({ domain: z.string() })).states(scheduled, valid, renewed, failed);

export const incident = H.kind('incident')
  .data(z.object({ title: z.string(), service: z.string(), detail: z.string() }))
  .states(open, resolved);

const services = ['api', 'web', 'queue'];
const databases: z.infer<typeof backupData>[] = [
  { database: 'orders', host: 'db-east' },
  { database: 'customers', host: 'db-west' },
];
const domains = ['example.com', 'api.example.com'];

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local);

const backupCommand = (host: ReturnType<typeof ssh.host>) =>
  H.command(`backup-on-${host.name}`)
    .input(z.object({ database: z.string() }))
    .argv(input => ['pg-backup', '--database', input.database])
    .on(host);
const backupOn = { 'db-east': backupCommand(dbEast), 'db-west': backupCommand(dbWest) };

const certificateExpiry = H.command('certificate-expiry')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['cert-days-left', input.domain])
  .on(dbEast, dbWest);

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv(input => ['certbot', 'renew', '--cert-name', input.domain])
  .on(dbEast, dbWest);

const runbook = H.command('incident-runbook')
  .input(z.object({ service: z.string() }))
  .argv(input => ['run-runbook', input.service])
  .on(local);

const acknowledgement = H.halt('incident-acknowledgement', z.object({ responder: z.string() }));
const resolutionConfirmed = H.halt('incident-resolution', z.object({ resolved: z.boolean(), note: z.string() }));

const heartbeatCheck = H.flow('heartbeat-check')
  .for(heartbeat)
  .does(async ctx => {
    const probe = await ctx.call(probeService, { service: ctx.unit.data.service });
    return probe.ok ? 'up' : 'down';
  });

const nightlyBackup = H.flow('nightly-backup')
  .for(backup)
  .does(async ctx => {
    const backedUp = await ctx.call(backupOn[ctx.unit.data.host], { database: ctx.unit.data.database });
    return backedUp.ok ? 'done' : ctx.fail(backedUp.error);
  });

const renewal = H.flow('certificate-check')
  .for(certificateRenewal)
  .does(async ctx => {
    const domain = ctx.unit.data.domain;
    const checked = await ctx.call(certificateExpiry, { domain });
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.daysLeft >= 14) return 'valid';
    const renewal = await ctx.call(renewCertificate, { domain });
    return renewal.ok ? 'renewed' : ctx.fail(renewal.error);
  });

const incidentRunbook = H.flow('incident-response')
  .for(incident)
  .does(async ctx => {
    const { title, service } = ctx.unit.data;
    await ctx.halt(acknowledgement, `Incident: ${title}`);
    for (;;) {
      const ran = await ctx.call(runbook, { service });
      const confirmed = await ctx.halt(
        resolutionConfirmed,
        ran.ok ? `Runbook finished for ${service}. Confirm resolution.` : `Runbook failed for ${service}: ${ran.error}`
      );
      if (confirmed.resolved) return 'resolved';
    }
  });

export const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(heartbeatCheck)
  .suppliers(
    H.clock('heartbeat-every-five-minutes', heartbeat, { every: { minutes: 5 } }, tick =>
      services.map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
    )
  );

export const backups = H.lane('backups', backup)
  .handler(nightlyBackup)
  .suppliers(
    H.clock('nightly-backups', backup, { daily: '01:00' }, tick =>
      databases.map(target => ({ create: target, key: `${target.database}-${tick.now.toISOString().slice(0, 10)}` }))
    )
  )
  .store(sqlite.store(backup, 'ops-units.db'))
  .retry(H.retry('backup-no-retry', { retries: 0 }), 'failed');

export const renewals = H.lane('certificate-renewals', certificateRenewal)
  .handler(renewal)
  .suppliers(
    H.clock('weekly-certificate-check', certificateRenewal, { weekly: { day: 'mon', at: '05:00' } }, tick =>
      domains.map(domain => ({ create: { domain }, key: `${domain}-${tick.now.toISOString().slice(0, 10)}` }))
    )
  )
  .retry(H.retry('renewal-retries', { retries: 2, backoff: { initialMs: 900_000, factor: 2 } }), 'failed');

export const incidents = H.lane('incidents', incident).handler(incidentRunbook).suppliers(H.operator);

const operationalExperience = H.journal(
  'operational-experience',
  H.memory('operational-experience', 'experience'),
  jsonl.memory('memory/operational-experience.jsonl')
);

const twoHoursMs = 2 * 60 * 60 * 1000;

const missedHeartbeats = H.trigger(
  'three-missed-heartbeats',
  H.on.streak(heartbeat, 'down', 3, data => data.service),
  (event, act) =>
    act.create(incidents, {
      title: `${event.unit.data.service} missed three heartbeats`,
      service: event.unit.data.service,
      detail: `Third consecutive failure at ${event.at.toISOString()}.`,
    })
);

const failedBackup = H.trigger('failed-backup-opens-incident', H.on.enters(backup, 'failed'), (event, act) =>
  act.create(incidents, {
    title: `Backup of ${event.unit.data.database} failed`,
    service: event.unit.data.database,
    detail: `Backup ${event.unit.key} failed on ${event.unit.data.host}.`,
  })
);

const slowBackup = H.trigger('slow-backup-noted', H.on.enters(backup, 'done'), (event, act) =>
  event.attempt !== undefined && event.attempt.durationMs > twoHoursMs
    ? act.remember(operationalExperience, {
        text: `When scheduling the ${event.unit.data.database} backup on ${event.unit.data.host}, allow more than two hours`,
        because: `backup ${event.unit.key} took ${Math.round(event.attempt.durationMs / 60000)} minutes`,
        when: { kinds: [backup] },
      })
    : []
);

const incidentsFirst = H.policy.scheduler('incidents-first', view => {
  const isIncident = (unit: { readonly lane: string }): boolean => unit.lane === incidents.name;
  const incidentOpen = [...view.pending, ...view.active, ...view.waiting].some(isIncident);
  const incidentPending = view.pending.some(isIncident);
  const start = [...view.pending]
    .filter(unit => !(incidentOpen && unit.lane === backups.name))
    .sort((a, b) => Number(isIncident(b)) - Number(isIncident(a)));
  const preempt = incidentPending ? view.active.filter(unit => !isIncident(unit) && unit.lane !== backups.name) : [];
  return { start, preempt };
});

const control = http.control({
  port: 8080,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolve(acknowledgement, resolutionConfirmed),
    H.ops.readMemory,
    H.ops.readTelemetry,
  ],
});

const incidentNotifier = slack.notify({
  webhook: H.env('SLACK_OPS_WEBHOOK'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'new'} → ${entry.to}`
      : null,
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('operations.db'))
  .lanes(heartbeats, backups, renewals, incidents)
  .triggers(missedHeartbeats, failedBackup, slowBackup)
  .scheduler(incidentsFirst)
  .clients(control)
  .observers(incidentNotifier, markdown.board('BOARD.md'));
