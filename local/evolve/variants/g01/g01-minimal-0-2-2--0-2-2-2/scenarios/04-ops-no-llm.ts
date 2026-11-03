import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, SupplyOf } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';

const due = H.state('due', 'pending');
const up = H.state('up', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');
const done = H.state('done', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');
const valid = H.state('valid', 'terminal', 'success');
const renewed = H.state('renewed', 'terminal', 'success');
const open = H.state('open', 'pending');
const resolved = H.state('resolved', 'terminal', 'success');

const Heartbeat = H.kind('Heartbeat').data(z.object({ service: z.string() })).states(due, up, down);
const Backup = H.kind('Backup').data(z.object({ database: z.string() })).states(due, done, failed);
const CertificateRenewal = H.kind('CertificateRenewal').data(z.object({ domain: z.string() })).states(due, valid, renewed, failed);
const Incident = H.kind('Incident').data(z.object({ title: z.string(), detail: z.string() })).states(open, resolved);

const operations = H.memory('operations', 'experience');
const operationsJournal = H.journal('operations', operations, jsonl.memory('.harness/operations.jsonl'));

const local = shell.local('local', { slots: 8 });
const sshKey = H.env('OPS_SSH_KEY');
const diskPreflight = ['test $(df --output=avail / | tail -1) -gt 10485760'];
const hostA = ssh.host('db-host-a', { address: 'db-a.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskPreflight });
const hostB = ssh.host('db-host-b', { address: 'db-b.internal', user: 'ops', key: sshKey, slots: 1, preflight: diskPreflight });

const checkService = H.command('check-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .recovery('rerun');

const runBackup = H.command('run-backup')
  .input(z.object({ database: z.string() }))
  .argv(input => ['backup-db', input.database])
  .on(hostA, hostB)
  .recovery('rerun');

const certificateDays = H.command('certificate-days')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['cert-days-left', input.domain])
  .on(hostA, hostB)
  .recovery('rerun');

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv(input => ['renew-cert', input.domain])
  .on(hostA, hostB)
  .recovery('rerun');

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(input => ['page', '--team', 'platform', input.title])
  .on(local)
  .recovery('park');

const runbook = H.command('incident-runbook')
  .input(z.object({ title: z.string(), detail: z.string() }))
  .argv(input => ['run-runbook', input.title, input.detail])
  .on(local)
  .recovery('park');

const acknowledged = H.halt('incident-acknowledged', z.object({ by: z.string() }));
const confirmedResolved = H.halt('incident-resolution-confirmed', z.object({ resolved: z.boolean(), note: z.string() }));

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async ctx => {
    const check = await ctx.run(checkService, { service: ctx.unit.data.service });
    return check.ok ? 'up' : 'down';
  });

const backupFlow = H.flow('backup')
  .for(Backup)
  .does(async ctx => {
    const backup = await ctx.run(runBackup, { database: ctx.unit.data.database });
    return backup.ok ? 'done' : 'failed';
  });

const renewalFlow = H.flow('certificate-renewal')
  .for(CertificateRenewal)
  .does(async ctx => {
    const domain = ctx.unit.data.domain;
    const days = await ctx.run(certificateDays, { domain });
    if (!days.ok) return ctx.fail(days.error);
    if (days.value.daysLeft >= 14) return 'valid';
    const renewal = await ctx.run(renewCertificate, { domain });
    return renewal.ok ? 'renewed' : 'failed';
  });

const incidentFlow = H.flow('incident-runbook')
  .for(Incident)
  .does(async ctx => {
    const { title, detail } = ctx.unit.data;
    await ctx.run(pageOnCall, { title });
    await ctx.halt(acknowledged, `Acknowledge incident: ${title}`);
    while (true) {
      const ran = await ctx.run(runbook, { title, detail });
      const confirmation = await ctx.halt(
        confirmedResolved,
        ran.ok ? `Runbook finished for ${title}. Confirm resolution.` : `Runbook failed for ${title}: ${ran.error}`
      );
      if (confirmation.resolved) return 'resolved';
    }
  });

const services = ['api', 'web', 'worker'];
const databases = ['orders', 'users'];
const domains = ['example.com', 'api.example.com'];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatFlow)
  .suppliers(H.clock('heartbeat-every-five-minutes', Heartbeat, { every: { minutes: 5 } }, tick =>
    services.map((service): SupplyOf<typeof Heartbeat> => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
  ));

const backups = H.lane('backups', Backup)
  .handler(backupFlow)
  .suppliers(H.clock('nightly-backups', Backup, { daily: '01:00' }, tick =>
    databases.map((database): SupplyOf<typeof Backup> => ({ create: { database }, key: `${database}-${tick.now.toISOString().slice(0, 10)}` }))
  ));

const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .handler(renewalFlow)
  .suppliers(H.clock('weekly-certificate-check', CertificateRenewal, { weekly: { day: 'mon', at: '03:00' } }, tick =>
    domains.map((domain): SupplyOf<typeof CertificateRenewal> => ({ create: { domain }, key: `${domain}-${tick.now.toISOString().slice(0, 10)}` }))
  ));

const incidents = H.lane('incidents', Incident)
  .handler(incidentFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Incident, '.harness/incidents.db'));

const heartbeatStreak = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(Heartbeat, 'down', 3, data => data.service),
  (event, act) => act.create(incidents, {
    title: `${event.unit.data.service} failed three heartbeats`,
    detail: `Third consecutive failure at ${event.at.toISOString()}`,
  })
);

const failedBackup = H.trigger(
  'failed-backup-opens-incident',
  H.on.enters(Backup, 'failed'),
  (event, act) => act.create(incidents, {
    title: `Backup of ${event.unit.data.database} failed`,
    detail: `Failed at ${event.at.toISOString()}`,
  })
);

const twoHoursMs = 2 * 60 * 60 * 1000;

const slowBackup = H.trigger(
  'slow-backup-records-note',
  H.on.enters(Backup, 'done'),
  (event, act) => {
    const durationMs = event.attempt ? event.attempt.durationMs : 0;
    return durationMs > twoHoursMs
      ? act.remember(operationsJournal, {
          text: `When scheduling the ${event.unit.data.database} backup, start it earlier or split it`,
          because: `the backup on ${event.at.toISOString().slice(0, 10)} took ${Math.round(durationMs / 60000)} minutes`,
          when: { kinds: [Backup] },
        })
      : [];
  }
);

const incidentsFirst = H.policy.scheduler('incidents-first', view => {
  const incidentPending = view.pending.some(unit => unit.is(Incident));
  const incidentOpen = incidentPending
    || view.active.some(unit => unit.is(Incident))
    || view.waiting.some(unit => unit.is(Incident));
  const rank = (unit: PendingView): number => (unit.is(Incident) ? 0 : 1);
  const startable = view.pending.filter(unit => !(incidentOpen && unit.is(Backup)));
  return {
    start: [...startable].sort((a, b) => rank(a) - rank(b)),
    preempt: incidentPending ? view.active.filter(unit => !unit.is(Backup) && !unit.is(Incident)) : [],
  };
});

const operatorApi = http.control({
  port: 8420,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolve(acknowledged, confirmedResolved), H.ops.readMemory, H.ops.readTelemetry],
});

const incidentNotifications = slack.notify({
  webhook: H.env('SLACK_WEBHOOK_URL'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === Incident.name
      ? `Incident ${entry.unit ?? ''} moved ${entry.from ?? 'new'} → ${entry.to}`
      : null,
});

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(heartbeatStreak, failedBackup, slowBackup)
  .scheduler(incidentsFirst)
  .clients(operatorApi)
  .observers(incidentNotifications, markdown.board('.harness/board.md'));

export const running = harness.start();
