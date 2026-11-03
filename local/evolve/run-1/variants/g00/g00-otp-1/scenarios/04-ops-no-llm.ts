import { z } from 'zod';
import { H, Candidate, PolicyEnv, SchedulingInput } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as local from 'harness-dsl/local';
import * as ssh from 'harness-dsl/ssh';
import * as http from 'harness-dsl/http';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';

const BeatDue = H.state('due', 'pending');
const BeatProbing = H.state('probing', 'active');
const BeatUp = H.state('up', 'succeeded');
const BeatDown = H.state('down', 'failed');
const HeartbeatSchema = z.object({ service: z.string(), url: z.string(), at: z.string() });
const Heartbeat = H.work('Heartbeat', HeartbeatSchema)
  .states(BeatDue, BeatProbing, BeatUp, BeatDown)
  .key(beat => `${beat.service}@${beat.at}`);

const Hosts = z.enum(['db-1', 'db-2']);
type HostName = z.infer<typeof Hosts>;

const BackupDue = H.state('due', 'pending');
const BackingUp = H.state('backing-up', 'active');
const BackedUp = H.state('backed-up', 'succeeded');
const BackupFailed = H.state('backup-failed', 'failed');
const BackupSchema = z.object({ database: z.string(), host: Hosts, night: z.string() });
const Backup = H.work('Backup', BackupSchema)
  .states(BackupDue, BackingUp, BackedUp, BackupFailed)
  .key(backup => `${backup.database}@${backup.night}`);

const CertDue = H.state('due', 'pending');
const CertChecking = H.state('checking', 'active');
const CertValid = H.state('valid', 'succeeded');
const CertRenewed = H.state('renewed', 'succeeded');
const CertFailed = H.state('renewal-failed', 'failed');
const CertSchema = z.object({ domain: z.string(), host: Hosts, week: z.string() });
const CertificateRenewal = H.work('CertificateRenewal', CertSchema)
  .states(CertDue, CertChecking, CertValid, CertRenewed, CertFailed)
  .key(cert => `${cert.domain}@${cert.week}`);

const IncidentOpen = H.state('open', 'pending');
const IncidentPaged = H.state('paged', 'active');
const IncidentMitigating = H.state('mitigating', 'active');
const IncidentConfirming = H.state('confirming', 'active');
const IncidentResolved = H.state('resolved', 'succeeded');
const IncidentSchema = z.object({ id: z.string(), title: z.string(), service: z.string(), origin: z.string() });
const Incident = H.work('Incident', IncidentSchema)
  .states(IncidentOpen, IncidentPaged, IncidentMitigating, IncidentConfirming, IncidentResolved)
  .key(incident => incident.id);

const services = [
  { service: 'api', url: 'https://api.internal/health' },
  { service: 'queue', url: 'https://queue.internal/health' },
];
const databases: readonly { database: string; host: HostName }[] = [
  { database: 'orders', host: 'db-1' },
  { database: 'customers', host: 'db-2' },
];
const certificates: readonly { domain: string; host: HostName }[] = [
  { domain: 'example.com', host: 'db-1' },
  { domain: 'api.example.com', host: 'db-2' },
];

const diskSpace = H.command('disk-space-preflight').run(() => [
  'sh',
  '-c',
  'test "$(df --output=avail -BG /var/backups | tail -1 | tr -dc 0-9)" -gt 50',
]);
const sshKey = H.env('OPS_SSH_KEY');
const db1 = ssh.host('db-1', { host: 'db-1.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace);
const db2 = ssh.host('db-2', { host: 'db-2.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace);
const hostRunner = (host: HostName) => (host === 'db-1' ? db1 : db2);
const localRunner = local.runner('local');

const probeHealth = H.command('probe-health').run((input: { url: string }) => ['curl', '-fsS', '--max-time', '10', input.url]);
const dumpDatabase = H.command('dump-database')
  .run((input: { database: string; night: string }) => ['backup-db', input.database, '--tag', input.night])
  .timeoutSeconds(6 * 3600);
const checkExpiry = H.command('check-expiry')
  .run((input: { domain: string }) => ['cert-days-left', input.domain])
  .output(z.object({ daysLeft: z.number() }));
const renewCertificate = H.command('renew-certificate').run((input: { domain: string }) => ['certbot', 'renew', '--cert-name', input.domain]);
const runbook = H.command('incident-runbook').run((input: { service: string }) => ['runbook', 'mitigate', input.service]);

const probe = H.flow<z.infer<typeof HeartbeatSchema>>('probe')
  .exits('up', 'down')
  .call('probe', probeHealth, ctx => ({ url: ctx.unit.data.url }), { onFailure: { exit: 'down' } })
  .exit('up');

const backup = H.flow<z.infer<typeof BackupSchema>>('backup')
  .exits('stored')
  .call('dump', dumpDatabase, ctx => ({ database: ctx.unit.data.database, night: ctx.unit.data.night }), {
    on: ctx => hostRunner(ctx.unit.data.host),
  })
  .exit('stored');

const renewalDays = 14;
const renewal = H.flow<z.infer<typeof CertSchema>>('certificate-renewal')
  .exits('valid', 'renewed')
  .call('expiry', checkExpiry, ctx => ({ domain: ctx.unit.data.domain }), { on: ctx => hostRunner(ctx.unit.data.host) })
  .exitWhen(ctx => (ctx.steps.expiry.daysLeft >= renewalDays ? 'valid' : undefined))
  .call('renew', renewCertificate, ctx => ({ domain: ctx.unit.data.domain }), { on: ctx => hostRunner(ctx.unit.data.host) })
  .exit('renewed');

const respond = H.flow<z.infer<typeof IncidentSchema>>('incident-response')
  .exits('resolved', 'unresolved')
  .halt('acknowledge', {
    ask: ctx => `Incident ${ctx.unit.data.id} on ${ctx.unit.data.service}: ${ctx.unit.data.title}. Acknowledge to run the runbook.`,
    decision: z.object({ by: z.string() }),
  })
  .call('runbook', runbook, ctx => ({ service: ctx.unit.data.service }), { on: localRunner })
  .halt('confirm', {
    ask: ctx => `Runbook finished for ${ctx.unit.data.service}. Is the incident resolved?`,
    decision: z.object({ resolved: z.boolean(), notes: z.string() }),
  })
  .exit(ctx => (ctx.steps.confirm.resolved ? 'resolved' : 'unresolved'));

const heartbeatLane = H.lane(Heartbeat)
  .supply(
    H.supply.schedule(Heartbeat, { every: { minutes: 5 } }).create(tick =>
      services.map(target => ({ ...target, at: tick.now.toISOString() })),
    ),
  )
  .handler(probe)
  .exits({ up: BeatUp, down: BeatDown, crashed: BeatDown })
  .phases({ probe: BeatProbing })
  .runner(localRunner);

const backupLane = H.lane(Backup)
  .supply(
    H.supply.schedule(Backup, { daily: { at: '01:00' } }).create(tick =>
      databases.map(target => ({ ...target, night: tick.now.toISOString().slice(0, 10) })),
    ),
  )
  .store(sqlite.store(Backup, '.harness/ops.db'))
  .handler(backup)
  .exits({ stored: BackedUp, crashed: BackupFailed })
  .phases({ dump: BackingUp });

const renewalLane = H.lane(CertificateRenewal)
  .supply(
    H.supply.schedule(CertificateRenewal, { weekly: { on: 'mon', at: '04:00' } }).create(tick =>
      certificates.map(target => ({ ...target, week: tick.now.toISOString().slice(0, 10) })),
    ),
  )
  .store(sqlite.store(CertificateRenewal, '.harness/ops.db'))
  .handler(renewal)
  .exits({ valid: CertValid, renewed: CertRenewed, crashed: CertFailed })
  .phases({ expiry: CertChecking, renew: CertChecking });

const incidentLane = H.lane(Incident)
  .supply(H.supply.operator())
  .store(sqlite.store(Incident, '.harness/ops.db'))
  .handler(respond)
  .exits({ resolved: IncidentResolved, unresolved: IncidentOpen, crashed: IncidentOpen })
  .phases({ acknowledge: IncidentPaged, runbook: IncidentMitigating, confirm: IncidentConfirming });

const operations = H.journal('operational-experience', H.memory.experience('operational-experience')).store(
  jsonl.memory('.harness/operations.jsonl'),
);

const repeatedHeartbeatFailure = H.trigger('three-failed-heartbeats-open-incident')
  .on(H.on.streak(Heartbeat, { state: BeatDown, count: 3, by: unit => unit.data.service }))
  .do(event =>
    H.do.create(incidentLane, {
      id: `heartbeat-${event.group}-${event.units.map(unit => unit.data.at).join('|')}`,
      title: `${event.group} failed three consecutive heartbeats`,
      service: event.group,
      origin: 'heartbeat',
    }),
  );

const failedBackup = H.trigger('failed-backup-opens-incident')
  .on(H.on.enter(Backup, BackupFailed))
  .do(event =>
    H.do.create(incidentLane, {
      id: `backup-${event.unit.data.database}-${event.unit.data.night}`,
      title: `Backup of ${event.unit.data.database} failed on ${event.unit.data.host}`,
      service: event.unit.data.database,
      origin: 'backup',
    }),
  );

const slowBackupSeconds = 2 * 3600;
const slowBackup = H.trigger('slow-backup-notes-experience')
  .on(H.on.enter(Backup, BackedUp))
  .do(event =>
    event.attempt !== undefined && event.attempt.durationSeconds > slowBackupSeconds
      ? H.do.record(operations, {
          do: `schedule the ${event.unit.data.database} backup earlier or split it`,
          when: `backing up ${event.unit.data.database} on ${event.unit.data.host}`,
          because: `the ${event.unit.data.night} backup took ${Math.round(event.attempt.durationSeconds / 60)} minutes`,
        })
      : undefined,
  );

const incidentsFirst = H.policy('incidents-first', (input: SchedulingInput, env: PolicyEnv): readonly Candidate[] => {
  const incidentOpen =
    env.metrics.active({ kind: Incident }) > 0 || input.pending.some(candidate => candidate.lane === incidentLane.name);
  const rank = (candidate: Candidate): number =>
    candidate.lane === incidentLane.name ? 0 : candidate.lane === heartbeatLane.name ? 1 : 2;
  return input.pending
    .filter(candidate => !(incidentOpen && candidate.lane === backupLane.name))
    .sort((a, b) => rank(a) - rank(b) || b.waitingSeconds - a.waitingSeconds);
});

const operatorGrant = H.grant(
  'ops-operator',
  H.op.readWork,
  H.op.createWork,
  H.op.cancelWork,
  H.op.resolveBlocker,
  H.op.readMemory,
  H.op.readTelemetry,
);

export const operationsHarness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeatLane, backupLane, renewalLane, incidentLane)
  .triggers(repeatedHeartbeatFailure, failedBackup, slowBackup)
  .scheduler(H.scheduler('ops').order(incidentsFirst))
  .clients(http.server({ grant: operatorGrant, port: H.slot.port(7400), token: H.env('OPS_CONTROL_TOKEN') }))
  .observe(
    slack.notify({
      webhook: H.env('SLACK_INCIDENTS_WEBHOOK'),
      kinds: [Incident],
      text: event => `Incident ${event.unit.key}: ${event.from} -> ${event.to}`,
    }),
    markdown.board({ path: 'BOARD.md' }),
  );

void operationsHarness.start();
