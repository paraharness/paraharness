import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Runner } from 'harness-dsl/kernel';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { manual, schedule } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { observers } from 'harness-dsl/observers';

const heartbeatTarget = z.object({ service: z.string() });
const backupTarget = z.object({ database: z.string(), host: z.string() });
const certificateTarget = z.object({ domain: z.string(), host: z.string() });
const incidentReport = z.object({ title: z.string(), source: z.string(), runbook: z.string() });
type HeartbeatTarget = z.infer<typeof heartbeatTarget>;
type BackupTarget = z.infer<typeof backupTarget>;
type CertificateTarget = z.infer<typeof certificateTarget>;
type IncidentReport = z.infer<typeof incidentReport>;

const due = H.state('due').pending();
const running = H.state('running').active();
const healthy = H.state('healthy').terminal('success');
const unhealthy = H.state('unhealthy').terminal('failure');
const backedUp = H.state('backed-up').terminal('success');
const backupFailed = H.state('backup-failed').terminal('failure');
const stillValid = H.state('still-valid').terminal('success');
const renewed = H.state('renewed').terminal('success');
const renewalFailed = H.state('renewal-failed').terminal('failure');
const open = H.state('open').pending();
const resolved = H.state('resolved').terminal('success');
const stalled = H.state('stalled').waiting();

const Heartbeat = H.work('heartbeat').schema(heartbeatTarget).states(due, running, healthy, unhealthy);
const Backup = H.work('backup').schema(backupTarget).states(due, running, backedUp, backupFailed);
const CertificateRenewal = H.work('certificate-renewal').schema(certificateTarget).states(due, running, stillValid, renewed, renewalFailed);
const Incident = H.work('incident').schema(incidentReport).states(open, running, resolved, stalled);

const acknowledgement = H.halt('acknowledgement')
  .context(z.object({ title: z.string(), source: z.string() }))
  .decision(z.object({ acknowledgedBy: z.string() }))
  .ask(context => `Acknowledge incident: ${context.title} (${context.source})`);
const resolutionCheck = H.halt('resolution-check')
  .context(z.object({ title: z.string(), runbookOutput: z.string() }))
  .decision(z.object({ resolved: z.boolean(), note: z.string() }))
  .ask(context => `Is "${context.title}" resolved?`);

const operationalExperience = H.memory('operational-experience').content(z.object({ rule: z.string() })).trust('experience');

const enoughDisk = async (runner: Runner) => {
  const result = await runner.exec(['df', '--output=pcent', '/var/backups'], {}, AbortSignal.timeout(10_000));
  const usedPercent = Number.parseInt(result.stdout.split('\n')[1] ?? '100', 10);
  return usedPercent < 85 ? { ok: true } : { ok: false, reason: `/var/backups is ${usedPercent}% full` };
};

const local = runners.local({ name: 'local', slots: 8 });
const dbHost1 = runners.ssh({ name: 'db-host-1', host: 'db1.internal', user: 'ops', identity: H.env('OPS_SSH_KEY'), slots: 1 }).preflight('disk-space', enoughDisk);
const dbHost2 = runners.ssh({ name: 'db-host-2', host: 'db2.internal', user: 'ops', identity: H.env('OPS_SSH_KEY'), slots: 1 }).preflight('disk-space', enoughDisk);
const hostFor = (host: string) => (host === 'db1.internal' ? dbHost1 : dbHost2);

const probeService = H.command('probe-service')
  .input(heartbeatTarget)
  .output(z.object({ healthy: z.boolean() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['curl', '-fsS', `https://${input.service}.internal/health`], { timeoutMs: 10_000 });
    return { healthy: result.code === 0 };
  });

const backupDatabase = H.command('backup-database')
  .input(backupTarget)
  .output(z.object({ archive: z.string() }))
  .runner(input => hostFor(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const archive = `/var/backups/${input.database}-${ctx.now.toISOString().slice(0, 10)}.dump`;
    const result = await ctx.exec(['pg_dump', '--format=custom', `--file=${archive}`, input.database]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { archive };
  });

const certificateExpiry = H.command('certificate-expiry')
  .input(certificateTarget)
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => hostFor(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['cert-days-left', input.domain]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { daysLeft: Number.parseInt(result.stdout, 10) };
  });

const renewCertificate = H.command('renew-certificate')
  .input(certificateTarget)
  .output(z.object({ renewedUntil: z.string() }))
  .runner(input => hostFor(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['certbot', 'renew', '--cert-name', input.domain, '--non-interactive']);
    if (result.code !== 0) throw new Error(result.stderr);
    return { renewedUntil: result.stdout.trim() };
  });

const runRunbook = H.command('run-runbook')
  .input(z.object({ runbook: z.string() }))
  .output(z.object({ output: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['sh', `runbooks/${input.runbook}.sh`]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { output: result.stdout };
  });

const heartbeatCheck = H.flow('heartbeat-check')
  .input(heartbeatTarget)
  .step('probe', probeService, state => ({ service: state.input.service }))
  .when(state => state.probe.healthy, ok => ok.exit('healthy'))
  .exit('unhealthy');

const nightlyBackup = H.flow('nightly-backup')
  .input(backupTarget)
  .step('dump', backupDatabase, state => state.input)
  .exit('backed-up');

const certificateCheck = H.flow('certificate-check')
  .input(certificateTarget)
  .step('expiry', certificateExpiry, state => state.input)
  .when(state => state.expiry.daysLeft >= 14, valid => valid.exit('still-valid'))
  .step('renewal', renewCertificate, state => state.input)
  .exit('renewed');

const incidentRunbook = H.flow('incident-runbook')
  .input(incidentReport)
  .halt('acknowledge', acknowledgement, state => ({ title: state.input.title, source: state.input.source }))
  .step('runbook', runRunbook, state => ({ runbook: state.input.runbook }), { onFailure: 'block' })
  .halt('confirm', resolutionCheck, state => ({ title: state.input.title, runbookOutput: state.runbook.output }))
  .when(state => !state.confirm.resolved, unresolved => unresolved.exit('still-open'))
  .exit('resolved');

const services = ['api', 'web', 'worker'];
const databases = [{ database: 'orders', host: 'db1.internal' }, { database: 'users', host: 'db2.internal' }];
const certificates = [{ domain: 'example.com', host: 'db1.internal' }, { domain: 'api.example.com', host: 'db2.internal' }];

const heartbeats = H.lane('heartbeats').of(Heartbeat)
  .from(schedule.cron<HeartbeatTarget>({
    name: 'heartbeat-every-five-minutes',
    cron: '*/5 * * * *',
    children: at => services.map(service => ({ key: `${service}@${at.toISOString()}`, data: { service } })),
  }))
  .handle(heartbeatCheck, { exits: { healthy, unhealthy }, retry: { retries: 0, backoff: 'none', exhausted: unhealthy } });

const backups = H.lane('backups').of(Backup)
  .from(schedule.cron<BackupTarget>({
    name: 'nightly-backups',
    cron: '0 1 * * *',
    children: at => databases.map(target => ({ key: `${target.database}@${at.toISOString().slice(0, 10)}`, data: target })),
  }))
  .handle(nightlyBackup, { exits: { 'backed-up': backedUp }, retry: { retries: 0, backoff: 'none', exhausted: backupFailed } });

const renewals = H.lane('certificate-renewals').of(CertificateRenewal)
  .from(schedule.cron<CertificateTarget>({
    name: 'weekly-certificate-check',
    cron: '0 4 * * 1',
    children: at => certificates.map(target => ({ key: `${target.domain}@${at.toISOString().slice(0, 10)}`, data: target })),
  }))
  .handle(certificateCheck, {
    exits: { 'still-valid': stillValid, renewed },
    retry: { retries: 2, backoff: { initial: '15m', factor: 2 }, exhausted: renewalFailed },
  });

const incidents = H.lane('incidents').of(Incident)
  .from(manual<IncidentReport>('operator-incidents'))
  .store(sqlite.store<IncidentReport>('.harness/incidents.sqlite'))
  .handle(incidentRunbook, {
    exits: { resolved, 'still-open': { to: open, atMost: 3, then: stalled } },
    retry: { retries: 1, backoff: { initial: '1m', factor: 2 }, exhausted: stalled },
  });

const opsJournal = H.journal('operational-experience-journal').of(operationalExperience).store(jsonl.memory('.harness/operational-experience.jsonl'));

const threeFailedHeartbeats = H.trigger('three-failed-heartbeats-open-incident')
  .on(H.events.transitions(heartbeats, { terminal: true }).streak(3, {
    group: event => event.unit.data.service,
    matches: event => event.to === unhealthy.name,
  }))
  .do(incidents.create(streak => ({
    key: `heartbeat-${streak.group}-${streak.events.map(event => event.unit.key).join('+')}`,
    data: { title: `${streak.group} failed three heartbeats in a row`, source: 'heartbeat', runbook: `restart-${streak.group}` },
  })));

const failedBackup = H.trigger('failed-backup-opens-incident')
  .on(H.events.transitions(backups, { to: backupFailed }))
  .do(incidents.create(event => ({
    key: `backup-${event.unit.key}`,
    data: { title: `Backup of ${event.unit.data.database} failed`, source: 'backup', runbook: `inspect-backup-${event.unit.data.database}` },
  })));

const slowBackupMs = 2 * 60 * 60 * 1000;
const slowBackup = H.trigger('slow-backup-records-experience')
  .on(H.events.attempts(backups).where(event => event.outcome === 'succeeded' && event.durationMs > slowBackupMs))
  .do(opsJournal.record(event => ({
    content: { rule: `When scheduling the backup ${event.unit.key.split('@')[0]}, start it before 01:00, because the last run took ${(event.durationMs / 3_600_000).toFixed(1)} hours.` },
    when: { kinds: [Backup] },
  })));

const incidentsPreempt = H.policy.units('incidents-preempt', choice => {
  const incidentActive = choice.active.some(unit => unit.lane === incidents.name);
  const rank = (lane: string) => (lane === incidents.name ? 0 : lane === heartbeats.name ? 1 : 2);
  return choice.candidates
    .filter(candidate => !(incidentActive && candidate.lane === backups.name))
    .sort((a, b) => rank(a.lane) - rank(b.lane) || a.queuedAt.getTime() - b.queuedAt.getTime());
});

const operatorHttp = http.client({ name: 'ops-http', port: 8080, token: H.env('OPS_CONTROL_TOKEN') });

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(incidents, heartbeats, backups, renewals)
  .journals(opsJournal)
  .triggers(threeFailedHeartbeats, failedBackup, slowBackup)
  .scheduler(incidentsPreempt)
  .grants(H.grant(
    operatorHttp,
    H.ops.work.read,
    H.ops.work.write,
    H.ops.resolve(acknowledgement),
    H.ops.resolve(resolutionCheck),
    H.ops.memory.read(operationalExperience),
    H.ops.telemetry.read,
    H.ops.attempts.manage,
  ))
  .observe(
    observers.slack({
      webhookUrl: H.env('SLACK_WEBHOOK_URL'),
      on: H.events.transitions(incidents),
      text: event => `Incident ${event.unit.key} "${event.unit.data.title}": ${event.from ?? 'created'} → ${event.to}`,
    }),
    observers.board({ path: 'BOARD.md' }),
  );

export default harness;
