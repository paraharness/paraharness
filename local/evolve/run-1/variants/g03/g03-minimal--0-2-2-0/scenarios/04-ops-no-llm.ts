import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { z } from 'zod';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const database = z.enum(['orders', 'users']);
const opsHost = z.enum(['ops-a', 'ops-b']);

const Heartbeat = H.kind('heartbeat')
  .data(z.object({ service: z.string() }))
  .states(
    H.state('hb-due', 'pending'),
    H.state('hb-running', 'active'),
    H.state('hb-ok', 'terminal', 'success'),
    H.state('hb-failed', 'terminal', 'failure')
  );

const Backup = H.kind('backup')
  .data(z.object({ database }))
  .states(
    H.state('backup-due', 'pending'),
    H.state('backing-up', 'active'),
    H.state('backed-up', 'terminal', 'success'),
    H.state('backup-failed', 'terminal', 'failure')
  );

const CertificateRenewal = H.kind('certificate-renewal')
  .data(z.object({ domain: z.string(), host: opsHost }))
  .states(
    H.state('cert-due', 'pending'),
    H.state('cert-checking', 'active'),
    H.state('cert-renewing', 'active'),
    H.state('cert-valid', 'terminal', 'success'),
    H.state('cert-renewed', 'terminal', 'success'),
    H.state('cert-renewal-failed', 'terminal', 'failure')
  );

const Incident = H.kind('incident')
  .data(z.object({ title: z.string(), runbook: z.string(), source: z.string() }))
  .states(
    H.state('incident-open', 'pending'),
    H.state('incident-paged', 'active'),
    H.state('incident-acknowledged', 'active'),
    H.state('incident-mitigated', 'active'),
    H.state('incident-resolved', 'terminal', 'success'),
    H.state('incident-dismissed', 'terminal', 'neutral')
  );

const opsJournal = H.library(
  'ops-notes',
  H.memory('operational-experience', 'experience'),
  jsonl.memory('.harness/ops-experience.jsonl')
);

const local = shell.local('local', { slots: 4 });
const sshKey = H.env('OPS_SSH_KEY');
const hostA = ssh.host('ops-a', { address: 'ops-a.internal', user: 'ops', key: sshKey, slots: 1 });
const hostB = ssh.host('ops-b', { address: 'ops-b.internal', user: 'ops', key: sshKey, slots: 1 });

const healthCheck = H.command('health-check')
  .input(z.object({ service: z.string() }))
  .argv(({ service }) => ['curl', '-fsS', '--max-time', '10', `https://${service}.internal/health`])
  .on(local);

const diskSpaceCheck = H.command('disk-space-check')
  .argv(() => ['sh', '-c', 'test "$(df --output=avail -k /var/backups | tail -1)" -gt 10485760']);

const backupCommand = H.command('database-backup')
  .input(z.object({ database }))
  .argv(({ database: name }) => ['/opt/ops/backup.sh', name])
  .on({ orders: hostA, users: hostB }, (input) => input.database)
  .preflight(diskSpaceCheck);

const certificateCheck = H.command('certificate-days-left')
  .input(z.object({ domain: z.string(), host: opsHost }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(({ domain }) => ['/opt/ops/cert-days-left.sh', domain])
  .on({ 'ops-a': hostA, 'ops-b': hostB }, (input) => input.host);

const certificateRenew = H.command('certificate-renew')
  .input(z.object({ domain: z.string(), host: opsHost }))
  .argv(({ domain }) => ['/opt/ops/cert-renew.sh', domain])
  .on({ 'ops-a': hostA, 'ops-b': hostB }, (input) => input.host)
  .preflight(diskSpaceCheck);

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string() }))
  .argv(({ title }) => ['/opt/ops/page.sh', title])
  .on(local);

const runbookCommand = H.command('runbook')
  .input(z.object({ runbook: z.string(), title: z.string() }))
  .argv(({ runbook, title }) => [`/opt/ops/runbooks/${runbook}.sh`, title])
  .on(local);

const acknowledgement = H.halt('incident-acknowledgement', z.object({ by: z.string() }));
const resolutionConfirmation = H.halt('incident-confirmation', z.object({
  outcome: z.enum(['resolved', 'dismissed']),
  note: z.string().optional()
}));

const heartbeatWork = H.flow('heartbeat-run')
  .for(Heartbeat)
  .does(async (ctx) => {
    await ctx.move('hb-running');
    const checked = await ctx.run(healthCheck, { service: ctx.unit.data.service });
    return checked.ok ? 'hb-ok' : 'hb-failed';
  });

const backupWork = H.flow('backup-run')
  .for(Backup)
  .does(async (ctx) => {
    await ctx.move('backing-up');
    const done = await ctx.run(backupCommand, { database: ctx.unit.data.database });
    return done.ok ? 'backed-up' : 'backup-failed';
  });

const renewalWork = H.flow('certificate-renewal-run')
  .for(CertificateRenewal)
  .does(async (ctx) => {
    const target = { domain: ctx.unit.data.domain, host: ctx.unit.data.host };
    await ctx.move('cert-checking');
    const checked = await ctx.run(certificateCheck, target);
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.daysLeft >= 14) return 'cert-valid';
    await ctx.move('cert-renewing');
    const renewed = await ctx.run(certificateRenew, target);
    return renewed.ok ? 'cert-renewed' : 'cert-renewal-failed';
  });

const incidentWork = H.flow('incident-runbook')
  .for(Incident)
  .does(async (ctx) => {
    const { title, runbook } = ctx.unit.data;
    await ctx.move('incident-paged');
    await ctx.run(pageOnCall, { title });
    await ctx.halt(acknowledgement, `Acknowledge incident: ${title}`);
    await ctx.move('incident-acknowledged');
    const ran = await ctx.run(runbookCommand, { runbook, title });
    await ctx.move('incident-mitigated');
    const confirmation = await ctx.halt(
      resolutionConfirmation,
      ran.ok ? `Runbook ${runbook} finished for: ${title}` : `Runbook ${runbook} failed for ${title}: ${ran.error}`
    );
    return confirmation.outcome === 'resolved' ? 'incident-resolved' : 'incident-dismissed';
  });

const services = ['api', 'web', 'queue'];
const certificates = [
  { domain: 'example.com', host: opsHost.enum['ops-a'] },
  { domain: 'api.example.com', host: opsHost.enum['ops-b'] }
];

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatWork)
  .suppliers(H.clock('heartbeat-schedule', Heartbeat, { every: { minutes: 5 } }, ({ now }) =>
    services.map((service) => Heartbeat.create({ service }, `${service}-${now.toISOString()}`))));

const backupLane = H.lane('backups', Backup)
  .handler(backupWork)
  .suppliers(H.clock('nightly-backups', Backup, { daily: '01:00' }, ({ now }) =>
    database.options.map((name) => Backup.create({ database: name }, `${name}-${now.toISOString().slice(0, 10)}`))));

const renewalLane = H.lane('certificate-renewals', CertificateRenewal)
  .handler(renewalWork)
  .suppliers(H.clock('weekly-certificate-check', CertificateRenewal, { weekly: { day: 'mon', at: '04:00' } }, ({ now }) =>
    certificates.map((cert) => CertificateRenewal.create(cert, `${cert.domain}-${now.toISOString().slice(0, 10)}`))));

const incidentLane = H.lane('incidents', Incident)
  .handler(incidentWork)
  .suppliers(H.operator);

const heartbeatStreak = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(Heartbeat, 'hb-failed', 3, (data) => data.service),
  (event, act) => act.create(incidentLane, {
    title: `${event.unit.data.service} failed three consecutive heartbeats`,
    runbook: 'service-down',
    source: event.unit.data.service
  }, `incident-heartbeat-${event.unit.data.service}-${event.at.toISOString()}`)
);

const failedBackup = H.trigger('failed-backup-opens-incident', H.on.enters(Backup, 'backup-failed'), (event, act) =>
  act.create(incidentLane, {
    title: `Backup of ${event.unit.data.database} failed`,
    runbook: 'backup-failed',
    source: event.unit.data.database
  }, `incident-backup-${event.unit.key}`));

const slowBackupMs = 2 * 60 * 60 * 1000;

const slowBackup = H.trigger('slow-backup-notes-experience', H.on.enters(Backup, 'backed-up'), (event, act) =>
  event.durationMs !== null && event.durationMs > slowBackupMs
    ? act.remember(opsJournal, {
        text: `When scheduling the ${event.unit.data.database} backup, start it earlier or check disk throughput`,
        because: `the backup on ${event.at.toISOString().slice(0, 10)} took ${Math.round(event.durationMs / 60000)} minutes`,
        when: { kinds: [Backup], resources: [event.unit.data.database] },
        status: 'candidate'
      })
    : []);

const incidentsFirst = H.policy.scheduler('incidents-preempt', ({ pending, active }) => {
  const incidents = pending.filter((unit) => unit.is(Incident));
  const incidentOpen = incidents.length > 0 || active.some((unit) => unit.is(Incident));
  const startable = (unit: PendingView): boolean => !unit.is(Incident) && !(incidentOpen && unit.is(Backup));
  return {
    start: [...incidents, ...pending.filter(startable)],
    preempt: incidents.length > 0
      ? active.filter((unit) => !unit.blocked && (unit.is(Heartbeat) || unit.is(CertificateRenewal)))
      : []
  };
});

export default H.harness('operations')
  .ledger(sqlite.ledger('.harness/operations.db'))
  .lanes(incidentLane, heartbeatLane, backupLane, renewalLane)
  .triggers(heartbeatStreak, failedBackup, slowBackup)
  .scheduler(incidentsFirst)
  .clients(http.control({
    port: 8787,
    token: H.env('CONTROL_API_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.readTelemetry]
  }))
  .observers(
    slack.notify({
      webhook: H.env('SLACK_INCIDENT_WEBHOOK'),
      on: Incident.entered(),
      message: (entry) => `Incident ${entry.unit}: ${entry.from ?? 'created'} -> ${entry.to}`
    }),
    markdown.board('BOARD.md')
  );
