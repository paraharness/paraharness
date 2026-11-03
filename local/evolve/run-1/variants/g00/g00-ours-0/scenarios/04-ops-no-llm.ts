import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { manual, schedule } from 'harness-dsl/supply';
import { board } from 'harness-dsl/observers';
import { slack } from 'harness-dsl/slack';
import { http } from 'harness-dsl/http';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';

const heartbeat = z.object({ service: z.string() });
type HeartbeatData = z.infer<typeof heartbeat>;
const backup = z.object({ database: z.string() });
type BackupData = z.infer<typeof backup>;
const renewal = z.object({ domain: z.string() });
type RenewalData = z.infer<typeof renewal>;
const incident = z.object({ title: z.string(), service: z.string(), origin: z.string() });
type IncidentData = z.infer<typeof incident>;

const HeartbeatDue = H.state('heartbeat-due').pending();
const HeartbeatOk = H.state('heartbeat-ok').succeeded();
const HeartbeatFailed = H.state('heartbeat-failed').failed();

const BackupDue = H.state('backup-due').pending();
const BackingUp = H.state('backing-up').active();
const BackupDone = H.state('backup-done').succeeded();
const BackupFailed = H.state('backup-failed').failed();

const RenewalDue = H.state('renewal-due').pending();
const CertificateValid = H.state('certificate-valid').succeeded();
const CertificateRenewed = H.state('certificate-renewed').succeeded();
const RenewalFailed = H.state('renewal-failed').failed();

const IncidentOpen = H.state('incident-open').pending();
const Paged = H.state('paged').active();
const Mitigating = H.state('mitigating').active();
const IncidentResolved = H.state('incident-resolved').succeeded();
const IncidentFailed = H.state('incident-failed').failed();

const Heartbeat = H.work('heartbeat').schema(heartbeat).states(HeartbeatDue, HeartbeatOk, HeartbeatFailed);
const Backup = H.work('backup')
  .schema(backup)
  .states(BackupDue, BackingUp, BackupDone, BackupFailed)
  .resources(job => [job.database]);
const CertificateRenewal = H.work('certificate-renewal')
  .schema(renewal)
  .states(RenewalDue, CertificateValid, CertificateRenewed, RenewalFailed);
const Incident = H.work('incident')
  .schema(incident)
  .states(IncidentOpen, Paged, Mitigating, IncidentResolved, IncidentFailed);

const OperationalExperience = H.memory('operational-experience').content(
  z.object({ do: z.string(), when: z.string(), because: z.string() }),
);
const operationsNotes = H.journal('operations-notes')
  .of(OperationalExperience)
  .store(jsonl.store('.harness/operations-notes.jsonl'));

const diskSpacePreflight = H.command('disk-space-preflight').run(async ({ exec }) => {
  const result = await exec('df --output=avail -BG /var/backups | tail -1');
  if (result.exitCode !== 0 || parseInt(result.stdout, 10) < 50) {
    throw new Error(`less than 50G free: ${result.stdout.trim()}`);
  }
});

const sshKey = H.env('OPS_SSH_KEY');
const localRunner = H.runner('local', local()).slots(8);
const opsHost1 = H.runner('ops-host-1', ssh({ host: 'ops-1.internal', user: 'ops', keyFile: sshKey }))
  .slots(1)
  .preflight(diskSpacePreflight);
const opsHost2 = H.runner('ops-host-2', ssh({ host: 'ops-2.internal', user: 'ops', keyFile: sshKey }))
  .slots(1)
  .preflight(diskSpacePreflight);

const probe = H.command('probe')
  .input(heartbeat)
  .output(z.object({ healthy: z.boolean() }))
  .runner(localRunner)
  .run(async ({ input, exec }) => {
    const result = await exec(`curl -fsS --max-time 10 https://${input.service}.internal/health`);
    return { healthy: result.exitCode === 0 };
  });

const runBackup = H.command('run-backup')
  .input(backup)
  .runner(opsHost1, opsHost2)
  .run(async ({ input, exec }) => {
    const result = await exec(
      `pg_dump --format=custom ${input.database} > /var/backups/${input.database}-$(date +%F).dump`,
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
  });

const checkExpiry = H.command('check-expiry')
  .input(renewal)
  .output(z.object({ daysLeft: z.number() }))
  .runner(opsHost1, opsHost2)
  .run(async ({ input, exec }) => {
    const result = await exec(`cert-days-left ${input.domain}`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
    return { daysLeft: Number(result.stdout.trim()) };
  });

const renewCertificate = H.command('renew-certificate')
  .input(renewal)
  .runner(opsHost1, opsHost2)
  .run(async ({ input, exec }) => {
    const result = await exec(`certbot renew --cert-name ${input.domain} --non-interactive`);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
  });

const page = H.command('page')
  .input(incident)
  .runner(localRunner)
  .env({ PAGER_TOKEN: H.env('PAGER_TOKEN') })
  .run(async ({ input, exec }) => {
    const result = await exec('page-oncall', { stdin: `${input.title} (${input.service}, ${input.origin})` });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr);
    }
  });

const runbook = H.command('runbook')
  .input(z.object({ service: z.string() }))
  .output(z.object({ log: z.string() }))
  .runner(localRunner)
  .run(async ({ input, exec }) => {
    const result = await exec(`runbooks/${input.service}.sh`);
    return { log: `${result.stdout}\n${result.stderr}` };
  });

const Acknowledgement = H.blocker('acknowledgement').resolution(z.object({ by: z.string() }));
const ResolutionConfirmed = H.blocker('resolution-confirmed').resolution(
  z.object({ by: z.string(), summary: z.string() }),
);

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .step('probe', probe)
  .transition(result => (result.healthy ? HeartbeatOk : HeartbeatFailed))
  .onError(HeartbeatFailed);

const backupFlow = H.flow('backup')
  .for(Backup)
  .transition(BackingUp)
  .step('backup', runBackup)
  .transition(BackupDone)
  .onError(BackupFailed);

const renewalFlow = H.flow('certificate-renewal')
  .for(CertificateRenewal)
  .step('check-expiry', checkExpiry)
  .when(
    expiry => expiry.daysLeft >= 14,
    valid => valid.transition(CertificateValid),
  )
  .step('renew', renewCertificate, { input: (_, ctx) => ctx.unit.data })
  .transition(CertificateRenewed)
  .onError(RenewalFailed);

const incidentFlow = H.flow('incident-runbook')
  .for(Incident)
  .step('page', page)
  .transition(Paged)
  .halt(Acknowledgement, (_, ctx) => ctx.unit.data.title)
  .transition(Mitigating)
  .step('runbook', runbook, { input: (_, ctx) => ({ service: ctx.unit.data.service }) })
  .halt(ResolutionConfirmed, result => result.log)
  .transition(IncidentResolved)
  .onError(IncidentFailed);

const services = ['api', 'web', 'worker'];
const databases = ['orders', 'billing'];
const domains = ['example.com', 'api.example.com'];

const heartbeats = H.lane('heartbeats')
  .of(Heartbeat)
  .from(
    schedule<HeartbeatData>({ every: '5m' }, tick =>
      services.map(service => ({ key: `${service}@${tick.now.toISOString()}`, data: { service } })),
    ),
  )
  .handle(heartbeatFlow);

const backups = H.lane('backups')
  .of(Backup)
  .from(
    schedule<BackupData>({ cron: '0 1 * * *' }, tick =>
      databases.map(database => ({
        key: `${database}@${tick.now.toISOString().slice(0, 10)}`,
        data: { database },
      })),
    ),
  )
  .handle(backupFlow);

const renewals = H.lane('certificate-renewals')
  .of(CertificateRenewal)
  .from(
    schedule<RenewalData>({ cron: '0 4 * * 1' }, tick =>
      domains.map(domain => ({
        key: `${domain}@${tick.now.toISOString().slice(0, 10)}`,
        data: { domain },
      })),
    ),
  )
  .handle(renewalFlow);

const incidents = H.lane('incidents').of(Incident).from(manual<IncidentData>()).handle(incidentFlow);

const threeFailedHeartbeatsOpenIncident = H.trigger('three-failed-heartbeats-open-incident')
  .on(
    heartbeats.enters(HeartbeatOk, HeartbeatFailed).streak(3, {
      matches: beat => beat.to.name === HeartbeatFailed.name,
      groupBy: beat => beat.unit.data.service,
    }),
  )
  .add(incidents, beat => ({
    title: `${beat.unit.data.service} failed three consecutive heartbeats`,
    service: beat.unit.data.service,
    origin: 'heartbeat',
  }));

const failedBackupOpensIncident = H.trigger('failed-backup-opens-incident')
  .on(backups.enters(BackupFailed))
  .add(incidents, failed => ({
    title: `Backup of ${failed.unit.data.database} failed`,
    service: failed.unit.data.database,
    origin: 'backup',
  }));

const twoHoursMs = 2 * 60 * 60 * 1000;
const slowBackupNotesExperience = H.trigger('slow-backup-notes-experience')
  .on(backups.enters(BackupDone).where(done => (done.attempt?.durationMs ?? 0) > twoHoursMs))
  .record(operationsNotes, done => ({
    content: {
      do: `start the ${done.unit.data.database} backup earlier or split it`,
      when: `scheduling backups of ${done.unit.data.database}`,
      because: `the backup on ${done.at.toISOString().slice(0, 10)} took ${Math.round(
        (done.attempt?.durationMs ?? 0) / 60000,
      )} minutes`,
    },
    when: { kinds: [Backup], resources: [done.unit.data.database] },
  }));

const scheduler = H.scheduler('operations')
  .concurrency(8)
  .policy(
    H.policy.schedule('incidents-preempt', ctx => {
      const pendingIncidents = ctx.pending.filter(unit => unit.lane === incidents.name);
      const incidentActive =
        pendingIncidents.length > 0 || ctx.active.some(open => open.unit.lane === incidents.name);
      const others = ctx.pending
        .filter(unit => unit.lane !== incidents.name)
        .filter(unit => !(incidentActive && unit.lane === backups.name))
        .sort((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime());
      return {
        start: [...pendingIncidents, ...others],
        preempt:
          pendingIncidents.length > 0
            ? ctx.active.filter(
                open =>
                  open.attempt.status === 'running' &&
                  open.unit.lane !== incidents.name &&
                  open.unit.lane !== backups.name,
              )
            : [],
      };
    }),
  );

const controlApi = H.supervisor('ops-control')
  .client(http.client({ port: 8080, token: H.env('OPS_CONTROL_TOKEN') }))
  .grant(
    H.ops.work.read,
    H.ops.work.write,
    H.ops.blockers.resolve,
    H.ops.memory.read,
    H.ops.telemetry.read,
  );

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, backups, renewals, incidents)
  .journals(operationsNotes)
  .triggers(threeFailedHeartbeatsOpenIncident, failedBackupOpensIncident, slowBackupNotesExperience)
  .scheduler(scheduler)
  .supervisor(controlApi)
  .observe(
    slack.notifier({
      webhookUrl: H.env('SLACK_WEBHOOK_URL'),
      when: record => record.type === 'transition' && record.unit.lane === incidents.name,
    }),
    board('BOARD.md'),
  );

export const running = operations.start();
