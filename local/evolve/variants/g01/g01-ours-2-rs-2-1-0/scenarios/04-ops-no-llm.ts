import { z } from 'zod';
import { H } from 'harness-dsl';
import type { AttemptEvent, Candidate, StreakEvent, TransitionEvent } from 'harness-dsl/kernel';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { manual, schedule } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import type { Runner } from 'harness-dsl/kernel';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const due = H.state('due').pending();
const succeeded = H.state('succeeded').terminal('success');
const failed = H.state('failed').terminal('failure');
const incidentOpen = H.state('incident-open').pending();
const incidentResolved = H.state('incident-resolved').terminal('success');
const incidentUnresolved = H.state('incident-unresolved').terminal('failure');

const heartbeatSchema = z.object({ service: z.string() });
type HeartbeatData = z.infer<typeof heartbeatSchema>;
const backupSchema = z.object({ database: z.string(), host: z.string() });
type BackupData = z.infer<typeof backupSchema>;
const certificateSchema = z.object({ domain: z.string(), host: z.string() });
type CertificateData = z.infer<typeof certificateSchema>;
const incidentSchema = z.object({ title: z.string(), service: z.string(), runbook: z.string() });
type IncidentData = z.infer<typeof incidentSchema>;

const heartbeat = H.work('heartbeat').schema(heartbeatSchema).states(due, succeeded, failed);
const backup = H.work('backup').schema(backupSchema).states(due, succeeded, failed);
const certificateRenewal = H.work('certificate-renewal').schema(certificateSchema).states(due, succeeded, failed);
const incident = H.work('incident').schema(incidentSchema).states(incidentOpen, incidentResolved, incidentUnresolved);

const operationalExperience = H.memory('operational-experience').content(z.object({ rule: z.string() })).trust('experience');
const operationsLog = H.journal('operations-log')
  .of(operationalExperience)
  .store(jsonl.memory('memory/operations.jsonl'))
  .recall(policies.specificity({ limit: 20 }));

const diskSpace = async (runner: Runner) => {
  const result = await runner.exec(['df', '--output=pcent', '/var/backups'], {}, new AbortController().signal);
  const used = parseInt(result.stdout.trim().split('\n').pop() ?? '100', 10);
  return used < 85 ? { ok: true } : { ok: false, reason: `backup volume ${used}% full` };
};

const local = runners.local({ name: 'local', slots: 8 });
const hostA = runners
  .ssh({ name: 'db-a', host: H.env('DB_A_HOST'), user: 'ops', identity: H.env('OPS_SSH_KEY'), slots: 1 })
  .preflight('disk-space', diskSpace);
const hostB = runners
  .ssh({ name: 'db-b', host: H.env('DB_B_HOST'), user: 'ops', identity: H.env('OPS_SSH_KEY'), slots: 1 })
  .preflight('disk-space', diskSpace);
const hostFor = (host: string) => (host === 'db-a' ? hostA : hostB);

const probe = H.command('probe-service')
  .input(heartbeatSchema)
  .output(z.object({ ok: z.boolean() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['curl', '-fsS', `https://${input.service}/health`], { timeoutMs: 10000 });
    if (result.code !== 0) throw new Error(`${input.service}: ${result.stderr}`);
    return { ok: true };
  });

const runBackup = H.command('run-backup')
  .input(backupSchema)
  .output(z.object({ archive: z.string() }))
  .runner(input => hostFor(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const archive = `/var/backups/${input.database}-${ctx.now.toISOString()}.dump`;
    const result = await ctx.exec(['pg_dump', '-Fc', '-f', archive, input.database]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { archive };
  });

const checkCertificate = H.command('check-certificate')
  .input(certificateSchema)
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => hostFor(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/cert-days-left', input.domain]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { daysLeft: Number(result.stdout.trim()) };
  });

const renewCertificate = H.command('renew-certificate')
  .input(certificateSchema)
  .output(z.object({ renewed: z.boolean() }))
  .runner(input => hostFor(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['certbot', 'renew', '--cert-name', input.domain]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { renewed: true };
  });

const pageOnCall = H.command('page-on-call')
  .input(z.object({ title: z.string(), service: z.string() }))
  .output(z.object({ pageId: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/page', input.service, input.title]);
    if (result.code !== 0) throw new Error(result.stderr);
    return { pageId: result.stdout.trim() };
  });

const runRunbook = H.command('run-runbook')
  .input(z.object({ runbook: z.string(), service: z.string() }))
  .output(z.object({ log: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec([`./runbooks/${input.runbook}`, input.service]);
    return { log: result.stdout + result.stderr };
  });

const acknowledgement = H.halt('incident-acknowledgement')
  .context(z.object({ title: z.string(), service: z.string() }))
  .decision(z.object({ acknowledgedBy: z.string() }))
  .ask(c => `Acknowledge incident on ${c.service}: ${c.title}`);
const resolution = H.halt('incident-resolution')
  .context(z.object({ title: z.string(), log: z.string() }))
  .decision(z.object({ resolved: z.boolean(), note: z.string() }))
  .ask(c => `Is "${c.title}" resolved?\n\n${c.log}`);

const heartbeatFlow = H.flow('heartbeat').input(heartbeatSchema).step('probe', probe, s => s.input).exit('ok');

const backupFlow = H.flow('backup').input(backupSchema).step('backup', runBackup, s => s.input).exit('ok');

const certificateFlow = H.flow('certificate-renewal')
  .input(certificateSchema)
  .step('check', checkCertificate, s => s.input)
  .when(s => s.check.daysLeft < 14, f => f.step('renew', renewCertificate, s => s.input))
  .exit('ok');

const incidentFlow = H.flow('incident-runbook')
  .input(incidentSchema)
  .step('page', pageOnCall, s => ({ title: s.input.title, service: s.input.service }))
  .halt('acknowledge', acknowledgement, s => ({ title: s.input.title, service: s.input.service }))
  .step('runbook', runRunbook, s => ({ runbook: s.input.runbook, service: s.input.service }))
  .halt('confirm', resolution, s => ({ title: s.input.title, log: s.runbook.log }))
  .when(s => !s.confirm.resolved, f => f.exit('unresolved'))
  .exit('resolved');

const services = ['api', 'web', 'queue'];
const databases = [
  { database: 'orders', host: 'db-a' },
  { database: 'billing', host: 'db-b' },
];
const domains = [
  { domain: 'example.com', host: 'db-a' },
  { domain: 'status.example.com', host: 'db-b' },
];
const day = (at: Date) => at.toISOString().slice(0, 10);

const heartbeats = H.lane('heartbeats')
  .of(heartbeat)
  .from(
    schedule.cron<HeartbeatData>({
      name: 'heartbeat-every-five-minutes',
      cron: '*/5 * * * *',
      children: at => services.map(service => ({ key: `${service}-${at.toISOString()}`, data: { service } })),
    }),
  )
  .handle(heartbeatFlow, { exits: { ok: succeeded }, retry: { retries: 0, backoff: 'none', exhausted: failed } });

const backups = H.lane('backups')
  .of(backup)
  .from(
    schedule.cron<BackupData>({
      name: 'nightly-backups',
      cron: '0 1 * * *',
      children: at => databases.map(d => ({ key: `${d.database}-${day(at)}`, data: d })),
    }),
  )
  .handle(backupFlow, { exits: { ok: succeeded }, retry: { retries: 1, backoff: { initial: '10m', factor: 2 }, exhausted: failed } });

const certificates = H.lane('certificates')
  .of(certificateRenewal)
  .from(
    schedule.cron<CertificateData>({
      name: 'weekly-certificate-check',
      cron: '0 4 * * 1',
      children: at => domains.map(d => ({ key: `${d.domain}-${day(at)}`, data: d })),
    }),
  )
  .handle(certificateFlow, { exits: { ok: succeeded }, retry: { retries: 2, backoff: { initial: '1h', factor: 2 }, exhausted: failed } });

const incidents = H.lane('incidents')
  .of(incident)
  .from(manual<IncidentData>('operator-incidents'))
  .handle(incidentFlow, {
    exits: { resolved: incidentResolved, unresolved: incidentUnresolved },
    retry: { retries: 0, backoff: 'none', exhausted: incidentUnresolved },
  });

const heartbeatStreak = H.trigger('three-failed-heartbeats-open-incident')
  .on(
    H.events
      .transitions(heartbeats, { terminal: true })
      .streak(3, { group: e => e.unit.data.service, matches: e => e.verdict === 'failure' }),
  )
  .do(
    incidents.create((e: StreakEvent<TransitionEvent<HeartbeatData>>) => ({
      key: `heartbeat-${e.group}-${e.events.map(x => x.unit.key).join('+')}`,
      data: { title: `${e.group} failed three heartbeats in a row`, service: e.group, runbook: 'restart-service.sh' },
    })),
  );

const backupFailure = H.trigger('failed-backup-opens-incident')
  .on(H.events.transitions(backups, { to: failed }))
  .do(
    incidents.create((e: TransitionEvent<BackupData>) => ({
      key: `backup-${e.unit.key}`,
      data: { title: `Backup of ${e.unit.data.database} failed`, service: e.unit.data.database, runbook: 'retry-backup.sh' },
    })),
  );

const slowBackup = H.trigger('slow-backup-noted')
  .on(H.events.attempts(backups).where(e => e.outcome === 'succeeded' && e.durationMs > 2 * 60 * 60 * 1000))
  .do(
    operationsLog.record((e: AttemptEvent) => ({
      content: {
        rule: `when scheduling backup ${e.unit.key.split('-')[0]}, start it earlier, because it took ${(e.durationMs / 3600000).toFixed(1)}h`,
      },
      when: { kinds: [backup] },
    })),
  );

const laneRank = (candidate: Candidate): number => {
  if (candidate.lane === incidents.name) return 0;
  if (candidate.lane === heartbeats.name) return 1;
  if (candidate.lane === certificates.name) return 2;
  return 3;
};

const incidentsPreempt = H.policy.units('incidents-preempt', choice => {
  const incidentActive = choice.active.some(a => a.lane === incidents.name);
  return [...choice.candidates]
    .filter(c => !(incidentActive && c.lane === backups.name))
    .sort((a, b) => laneRank(a) - laneRank(b) || a.queuedAt.getTime() - b.queuedAt.getTime());
});

const opsConsole = http.client({ name: 'ops-console', port: H.slot.port(0), token: H.env('OPS_CONSOLE_TOKEN') });

export const operations = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(heartbeats, backups, certificates, incidents)
  .journals(operationsLog)
  .triggers(heartbeatStreak, backupFailure, slowBackup)
  .scheduler(incidentsPreempt)
  .grants(
    H.grant(
      opsConsole,
      H.ops.work.read,
      H.ops.work.write,
      H.ops.resolve(acknowledgement),
      H.ops.resolve(resolution),
      H.ops.memory.read(operationalExperience),
      H.ops.telemetry.read,
    ),
  )
  .observe(
    observers.slack({
      webhookUrl: H.env('SLACK_WEBHOOK_URL'),
      on: H.events.transitions(incidents),
      text: e => `Incident ${e.unit.key} (${e.unit.data.service}): ${e.from ?? 'new'} -> ${e.to}`,
    }),
    observers.board({ path: 'BOARD.md' }),
  );
