import { H, type SupplyOf } from 'harness-dsl';
import { z } from 'zod';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as slack from 'harness-dsl/slack';

const database = z.enum(['orders', 'billing']);
const machine = z.enum(['alpha', 'beta']);

const Heartbeat = H.kind('heartbeat')
  .data(z.object({ service: z.string() }))
  .states(
    [
      H.state('beat-due', 'pending'),
      H.state('beat-ok', { terminal: 'success' }),
      H.state('beat-failed', { terminal: 'failure' }),
    ],
    'beat-due'
  );

const Backup = H.kind('backup')
  .data(z.object({ database, night: z.string() }))
  .states(
    [
      H.state('backup-due', 'pending'),
      H.state('backed-up', { terminal: 'success' }),
      H.state('backup-failed', { terminal: 'failure' }),
    ],
    'backup-due'
  );

const renewalData = z.object({ domain: z.string(), machine });

const CertificateRenewal = H.kind('certificate-renewal')
  .data(renewalData)
  .states(
    [
      H.state('renewal-due', 'pending'),
      H.state('cert-valid', { terminal: 'success' }),
      H.state('cert-renewed', { terminal: 'success' }),
      H.state('renewal-failed', { terminal: 'failure' }),
    ],
    'renewal-due'
  )
  .failsTo('renewal-failed');

const Incident = H.kind('incident')
  .data(z.object({ title: z.string(), detail: z.string(), service: z.string() }))
  .states(
    [
      H.state('incident-open', 'pending'),
      H.state('incident-acknowledged', 'active'),
      H.state('incident-resolved', { terminal: 'success' }),
      H.state('incident-unresolved', { terminal: 'failure' }),
    ],
    'incident-open'
  )
  .failsTo('incident-unresolved');

const databaseResources = { orders: H.resource('orders-db'), billing: H.resource('billing-db') };

const OperationalExperience = H.memory('operational-experience', 'fallible');
const operations = H.library('operations-journal', OperationalExperience, jsonl.memory('memory/operations.jsonl'));

const local = shell.local('local', { slots: 4 });
const diskPreflight = ['test "$(df --output=avail -BG /var/backups | tail -1 | tr -dc 0-9)" -ge 20'];
const alpha = ssh.host('alpha', {
  address: 'alpha.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskPreflight,
});
const beta = ssh.host('beta', {
  address: 'beta.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  preflight: diskPreflight,
});
const hosts = { alpha, beta };
const backupHost = { orders: alpha, billing: beta };

const healthCheck = H.command('health-check')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['./checks/health.sh', input.service])
  .on(local)
  .restart('rerun');

const backupDatabase = H.command('backup-database')
  .input(z.object({ database, night: z.string() }))
  .argv((input) => ['/opt/ops/backup.sh', input.database, input.night])
  .on((input) => backupHost[input.database])
  .restart('rerun');

const certificateCheck = H.command('certificate-check')
  .input(renewalData)
  .output(z.object({ daysLeft: z.number() }))
  .argv((input) => ['/opt/ops/cert-days-left.sh', input.domain])
  .on((input) => hosts[input.machine])
  .restart('rerun');

const certificateRenew = H.command('certificate-renew')
  .input(renewalData)
  .argv((input) => ['/opt/ops/cert-renew.sh', input.domain])
  .on((input) => hosts[input.machine])
  .restart('rerun');

const runbook = H.command('incident-runbook')
  .input(z.object({ title: z.string(), service: z.string() }))
  .argv((input) => ['./runbooks/run.sh', input.service, input.title])
  .on(local);

const heartbeatFlow = H.flow('heartbeat').for(Heartbeat).does(async (ctx) => {
  const checked = await ctx.run(healthCheck, { service: ctx.unit.data.service });
  return checked.ok ? 'beat-ok' : 'beat-failed';
});

const backupFlow = H.flow('backup').for(Backup).does(async (ctx) => {
  const backedUp = await ctx.run(backupDatabase, ctx.unit.data);
  return backedUp.ok ? 'backed-up' : 'backup-failed';
});

const renewalThresholdDays = 14;

const renewalFlow = H.flow('certificate-renewal').for(CertificateRenewal).does(async (ctx) => {
  const checked = await ctx.run(certificateCheck, ctx.unit.data);
  if (!checked.ok) return ctx.fail(checked.error);
  if (checked.value.daysLeft >= renewalThresholdDays) return 'cert-valid';
  const renewed = await ctx.run(certificateRenew, ctx.unit.data);
  return renewed.ok ? 'cert-renewed' : ctx.fail(renewed.error);
});

const runbookFlow = H.flow('incident-runbook').for(Incident).does(async (ctx) => {
  const { title, detail, service } = ctx.unit.data;
  const acknowledgement = await ctx.halt({
    name: 'acknowledge-incident',
    show: `${title}\n\n${detail}`,
    decision: z.object({ acknowledgedBy: z.string() }),
  });
  ctx.tag({ acknowledgedBy: acknowledgement.acknowledgedBy });
  await ctx.move('incident-acknowledged');
  const ran = await ctx.run(runbook, { title, service });
  const confirmation = await ctx.halt({
    name: 'confirm-resolution',
    show: ran.ok ? ran.value : `runbook failed: ${ran.error}`,
    decision: z.object({ resolved: z.boolean(), notes: z.string() }),
  });
  return confirmation.resolved ? 'incident-resolved' : ctx.fail(confirmation.notes);
});

const services = ['api', 'worker', 'gateway'];
const certificates: z.infer<typeof renewalData>[] = [
  { domain: 'api.example.com', machine: 'alpha' },
  { domain: 'billing.example.com', machine: 'beta' },
];

const heartbeatTimetable = H.timetable('heartbeat-every-five-minutes', Heartbeat, { every: { minutes: 5 } }, (tick) =>
  services.map((service): SupplyOf<typeof Heartbeat> => ({
    create: { service },
    key: `heartbeat-${service}-${tick.now.toISOString()}`,
  }))
);

const backupTimetable = H.timetable('backup-nightly', Backup, { daily: '01:00' }, (tick) => {
  const night = tick.now.toISOString().slice(0, 10);
  return database.options.map((name): SupplyOf<typeof Backup> => ({
    create: { database: name, night },
    key: `backup-${name}-${night}`,
  }));
});

const renewalTimetable = H.timetable('certificate-check-weekly', CertificateRenewal, { weekly: { day: 'sun', at: '03:00' } }, (tick) =>
  certificates.map((certificate): SupplyOf<typeof CertificateRenewal> => ({
    create: certificate,
    key: `renewal-${certificate.domain}-${tick.now.toISOString().slice(0, 10)}`,
  }))
);

const heartbeatLane = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(heartbeatTimetable);
const backupLane = H.lane('backups', Backup).handler(backupFlow).suppliers(backupTimetable);
const renewalLane = H.lane('renewals', CertificateRenewal).handler(renewalFlow).suppliers(renewalTimetable);
const incidentLane = H.lane('incidents', Incident)
  .handler(runbookFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Incident, '.harness/incidents.sqlite'));

const twoHoursMs = 2 * 60 * 60 * 1000;

const failingHeartbeatsOpenIncident = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(Heartbeat, 'beat-failed', 3, (data) => data.service),
  (event, act) =>
    act.create(
      incidentLane,
      {
        title: `${event.unit.data.service} failed three heartbeats in a row`,
        detail: `Last failure at ${event.at.toISOString()}.`,
        service: event.unit.data.service,
      },
      `heartbeat-${event.unit.data.service}`
    )
);

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident', H.on.enters(Backup, 'backup-failed'), (event, act) =>
  act.create(
    incidentLane,
    {
      title: `Backup of ${event.unit.data.database} failed`,
      detail: `Night ${event.unit.data.night}, failed at ${event.at.toISOString()}.`,
      service: `${event.unit.data.database}-db`,
    },
    `backup-${event.unit.data.database}-${event.unit.data.night}`
  )
);

const slowBackupNoted = H.trigger('slow-backup-noted', H.on.enters(Backup, 'backed-up'), (event, act) =>
  event.attempt && event.attempt.durationMs > twoHoursMs
    ? act.remember(operations, {
        text: `When scheduling the ${event.unit.data.database} backup, start it earlier or split it`,
        because: `the backup of night ${event.unit.data.night} took ${Math.round(event.attempt.durationMs / 60000)} minutes`,
        when: { kinds: [Backup], resources: [databaseResources[event.unit.data.database]] },
      })
    : []
);

const laneOrder = [incidentLane.name, heartbeatLane.name, renewalLane.name, backupLane.name];

const incidentsPreempt = H.policy.scheduler('incidents-preempt', (view) => {
  const incidentPending = view.pending.some((unit) => unit.lane === incidentLane.name);
  const incidentActive = view.active.some((unit) => unit.lane === incidentLane.name);
  const start = [...view.pending]
    .filter((unit) => !(incidentActive && unit.lane === backupLane.name))
    .sort((a, b) => laneOrder.indexOf(a.lane) - laneOrder.indexOf(b.lane) || b.waitedMs - a.waitedMs);
  const preempt = incidentPending ? view.active.filter((unit) => unit.lane === heartbeatLane.name) : [];
  return { start, preempt };
});

const operatorApi = http.control({
  port: 8080,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry],
});

const incidentAlerts = slack.notify({
  webhook: H.env('SLACK_INCIDENT_WEBHOOK'),
  message: (entry) =>
    entry.entry === 'transition' && entry.kind === Incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'created'} → ${entry.to}`
      : null,
});

export const operations_ = H.harness('platform-operations')
  .ledger(sqlite.ledger('.harness/ops.sqlite'))
  .lanes(incidentLane, heartbeatLane, renewalLane, backupLane)
  .triggers(failingHeartbeatsOpenIncident, failedBackupOpensIncident, slowBackupNoted)
  .scheduler(incidentsPreempt)
  .clients(operatorApi)
  .observers(incidentAlerts, markdown.board('BOARD.md'));
