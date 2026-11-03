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

const machines = H.resources('machine', ['ops-a', 'ops-b']);
const service = z.enum(['api', 'web', 'worker', 'queue']);

const Heartbeat = H.kind('Heartbeat')
  .data(z.object({ service }))
  .states(
    [
      H.state('due', 'pending'),
      H.state('probing', 'active'),
      H.state('healthy', 'terminal', 'success'),
      H.state('unhealthy', 'terminal', 'failure'),
    ],
    { initial: 'due', afterFailure: 'unhealthy' }
  );

const backupData = z.object({ database: z.string(), host: machines.schema });
type BackupData = z.infer<typeof backupData>;

const Backup = H.kind('Backup')
  .data(backupData)
  .states(
    [
      H.state('scheduled', 'pending'),
      H.state('running', 'active'),
      H.state('completed', 'terminal', 'success'),
      H.state('backup-failed', 'terminal', 'failure'),
    ],
    { initial: 'scheduled', afterFailure: 'backup-failed' }
  );

const certificateData = z.object({ domain: z.string(), host: machines.schema });
type CertificateData = z.infer<typeof certificateData>;

const CertificateRenewal = H.kind('CertificateRenewal')
  .data(certificateData)
  .states(
    [
      H.state('due', 'pending'),
      H.state('inspecting', 'active'),
      H.state('renewing', 'active'),
      H.state('still-valid', 'terminal', 'success'),
      H.state('renewed', 'terminal', 'success'),
      H.state('renewal-failed', 'terminal', 'failure'),
    ],
    { initial: 'due', afterFailure: 'renewal-failed' }
  );

const Incident = H.kind('Incident')
  .data(z.object({ title: z.string(), service: z.string(), runbook: z.string() }))
  .states(
    [
      H.state('open', 'pending'),
      H.state('awaiting-acknowledgement', 'active'),
      H.state('mitigating', 'active'),
      H.state('awaiting-confirmation', 'active'),
      H.state('resolved', 'terminal', 'success'),
      H.state('unresolved', 'terminal', 'failure'),
    ],
    { initial: 'open', afterFailure: 'open' }
  );

const operational = H.memory('operational-experience', 'experience');
const opsJournal = H.library('operations-journal', operational, jsonl.memory('memory/operations.jsonl'));

const local = shell.local('local', { slots: 4 });
const preflight = ['./bin/check-disk', '--min-free-gb', '50'];
const opsA = ssh.host('ops-a', {
  address: 'ops-a.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  hosts: [machines.get('ops-a')],
  preflight,
});
const opsB = ssh.host('ops-b', {
  address: 'ops-b.internal',
  user: 'ops',
  key: H.env('OPS_SSH_KEY'),
  slots: 1,
  hosts: [machines.get('ops-b')],
  preflight,
});

const probe = H.command('probe-service')
  .input(z.object({ service }))
  .argv(input => ['./probes/http', input.service])
  .on(local)
  .ifInterrupted('rerun');

const backupCommand = H.command('backup-database')
  .input(z.object({ database: z.string() }))
  .argv(input => ['./bin/backup', input.database])
  .on(opsA, opsB)
  .ifInterrupted('park');

const certificateDays = H.command('certificate-days-left')
  .input(z.object({ domain: z.string() }))
  .output(z.object({ daysLeft: z.number() }))
  .argv(input => ['./bin/cert-days-left', input.domain])
  .on(opsA, opsB)
  .ifInterrupted('rerun');

const renewCertificate = H.command('renew-certificate')
  .input(z.object({ domain: z.string() }))
  .argv(input => ['./bin/renew-cert', input.domain])
  .on(opsA, opsB)
  .ifInterrupted('rerun');

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string(), service: z.string() }))
  .argv(input => ['./bin/page', input.service, input.title])
  .on(local)
  .ifInterrupted('park');

const runRunbook = H.command('run-runbook')
  .input(z.object({ runbook: z.string(), service: z.string() }))
  .argv(input => ['./runbooks/run', input.runbook, input.service])
  .on(local)
  .ifInterrupted('park');

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async ctx => {
    await ctx.move('probing');
    const probed = await ctx.run(probe, { service: ctx.unit.data.service }, { timeoutMs: 30_000 });
    return probed.ok ? 'healthy' : 'unhealthy';
  });

const backupFlow = H.flow('backup')
  .for(Backup)
  .does(async ctx => {
    await ctx.move('running');
    const done = await ctx.run(backupCommand, { database: ctx.unit.data.database });
    if (done.ok === false) return ctx.fail(done.error);
    return 'completed';
  });

const renewalFlow = H.flow('certificate-renewal')
  .for(CertificateRenewal)
  .does(async ctx => {
    await ctx.move('inspecting');
    const inspected = await ctx.run(certificateDays, { domain: ctx.unit.data.domain });
    if (inspected.ok === false) return ctx.fail(inspected.error);
    if (inspected.value.daysLeft >= 14) return 'still-valid';
    await ctx.move('renewing');
    const renewed = await ctx.run(renewCertificate, { domain: ctx.unit.data.domain });
    if (renewed.ok === false) return ctx.fail(renewed.error);
    return 'renewed';
  });

const incidentFlow = H.flow('incident-runbook')
  .for(Incident)
  .does(async ctx => {
    const incident = ctx.unit.data;
    await ctx.move('awaiting-acknowledgement');
    await ctx.run(pageOnCall, { title: incident.title, service: incident.service });
    await ctx.halt({
      name: 'acknowledge',
      show: `Incident: ${incident.title} (${incident.service})`,
      decision: z.object({ by: z.string() }),
    });
    await ctx.move('mitigating');
    const ran = await ctx.run(runRunbook, { runbook: incident.runbook, service: incident.service });
    await ctx.move('awaiting-confirmation');
    const confirmed = await ctx.halt({
      name: 'confirm-resolution',
      show: ran.ok ? `Runbook ${incident.runbook} finished.` : `Runbook ${incident.runbook} failed: ${ran.error}`,
      decision: z.object({ resolved: z.boolean(), note: z.string() }),
    });
    return confirmed.resolved ? 'resolved' : 'unresolved';
  });

const backupTargets: readonly BackupData[] = [
  { database: 'orders', host: 'ops-a' },
  { database: 'billing', host: 'ops-b' },
];

const certificates: readonly CertificateData[] = [
  { domain: 'api.example.com', host: 'ops-a' },
  { domain: 'www.example.com', host: 'ops-b' },
];

const heartbeatSchedule = H.calendar('heartbeat-every-5-minutes', Heartbeat, { every: { minutes: 5 } }, tick =>
  service.options.map(name => ({ create: { service: name }, key: `heartbeat-${name}-${tick.now.toISOString()}` }))
);

const nightlyBackups = H.calendar('nightly-backups', Backup, { daily: '01:00' }, tick =>
  backupTargets.map(target => ({ create: target, key: `backup-${target.database}-${tick.now.toISOString().slice(0, 10)}` }))
);

const weeklyCertificateCheck = H.calendar(
  'weekly-certificate-check',
  CertificateRenewal,
  { weekly: { day: 'mon', at: '05:00' } },
  tick =>
    certificates.map(certificate => ({
      create: certificate,
      key: `certificate-${certificate.domain}-${tick.now.toISOString().slice(0, 10)}`,
    }))
);

const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(heartbeatSchedule);
const backups = H.lane('backups', Backup)
  .handler(backupFlow)
  .suppliers(nightlyBackups)
  .touches(data => [machines.get(data.host)]);
const renewals = H.lane('certificate-renewals', CertificateRenewal)
  .handler(renewalFlow)
  .suppliers(weeklyCertificateCheck)
  .touches(data => [machines.get(data.host)]);
const incidents = H.lane('incidents', Incident).handler(incidentFlow).suppliers(H.operator);

const threeFailedHeartbeatsOpenIncident = H.trigger(
  'three-failed-heartbeats-open-incident',
  H.on.streak(Heartbeat, 'unhealthy', 3, data => data.service),
  (event, act) =>
    act.create(
      incidents,
      {
        title: `${event.unit.data.service} failed ${event.streak ?? 3} heartbeats in a row`,
        service: event.unit.data.service,
        runbook: 'service-down',
      },
      `incident-heartbeat-${event.unit.data.service}`
    )
);

const failedBackupOpensIncident = H.trigger(
  'failed-backup-opens-incident',
  H.on.enters(Backup, 'backup-failed'),
  (event, act) =>
    act.create(
      incidents,
      {
        title: `Backup of ${event.unit.data.database} failed`,
        service: event.unit.data.database,
        runbook: 'backup-failed',
      },
      `incident-backup-${event.unit.data.database}`
    )
);

const slowBackupMs = 2 * 60 * 60 * 1000;

const slowBackupNoted = H.trigger(
  'slow-backup-noted',
  H.on.enters(Backup, 'completed'),
  (event, act) => {
    const tookMs = event.attempt === undefined ? 0 : event.attempt.durationMs;
    if (tookMs <= slowBackupMs) return [];
    return act.remember(opsJournal, {
      text: `When scheduling the ${event.unit.data.database} backup on ${event.unit.data.host}, start it earlier or move it to a quieter host`,
      because: `the backup of ${event.at.toISOString().slice(0, 10)} took ${Math.round(tookMs / 60000)} minutes`,
      when: { kinds: [Backup], resources: [machines.get(event.unit.data.host)] },
    });
  }
);

const isIncident = (unit: { readonly kind: string }) => unit.kind === Incident.name;
const isBackup = (unit: { readonly kind: string }) => unit.kind === Backup.name;
const kindOrder = [Incident.name, Heartbeat.name, Backup.name, CertificateRenewal.name];
const rank = (unit: PendingView) => kindOrder.indexOf(unit.kind);

const incidentsPreempt = H.policy.scheduler('incidents-preempt', view => {
  const incidentPending = view.pending.some(isIncident);
  const incidentLive = incidentPending || view.active.some(isIncident);
  const held = (unit: PendingView) => incidentLive && isBackup(unit);
  return {
    start: view.pending.filter(unit => held(unit) === false).sort((a, b) => rank(a) - rank(b)),
    preempt: incidentPending ? view.active.filter(unit => isIncident(unit) === false && isBackup(unit) === false) : [],
  };
});

const incidentToSlack = slack.notify({
  webhook: H.env('SLACK_OPS_WEBHOOK'),
  message: entry =>
    entry.entry === 'transition' && entry.kind === Incident.name
      ? `Incident ${entry.unit ?? ''}: ${entry.from ?? 'new'} to ${entry.to}`
      : null,
});

const operatorApi = http.control({
  port: 8080,
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.manageAttempts, H.ops.readMemory, H.ops.readTelemetry],
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('operations.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .triggers(threeFailedHeartbeatsOpenIncident, failedBackupOpensIncident, slowBackupNoted)
  .scheduler(incidentsPreempt)
  .clients(operatorApi)
  .observers(incidentToSlack, markdown.board('BOARD.md'));
