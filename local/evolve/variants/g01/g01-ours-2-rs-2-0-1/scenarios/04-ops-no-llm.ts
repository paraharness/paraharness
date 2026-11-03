import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const hostName = z.enum(['db-a', 'db-b']);
const heartbeatSchema = z.object({ service: z.string(), url: z.string() });
const backupSchema = z.object({ database: z.string(), host: hostName });
const renewalSchema = z.object({ domain: z.string(), host: hostName });
const incidentSchema = z.object({ title: z.string(), service: z.string(), source: z.enum(['heartbeat', 'backup', 'operator']) });

const queued = H.state('queued').pending();
const running = H.state('running').active();
const up = H.state('up').terminal('success');
const down = H.state('down').terminal('failure');
const backedUp = H.state('backedUp').terminal('success');
const backupFailed = H.state('backupFailed').terminal('failure');
const current = H.state('current').terminal('success');
const renewed = H.state('renewed').terminal('success');
const renewalFailed = H.state('renewalFailed').terminal('failure');
const resolved = H.state('resolved').terminal('success');
const needsEngineering = H.state('needsEngineering').waiting();

const heartbeat = H.work('Heartbeat').schema(heartbeatSchema).states(queued, running, up, down);
const backup = H.work('Backup').schema(backupSchema).states(queued, running, backedUp, backupFailed);
const renewal = H.work('CertificateRenewal').schema(renewalSchema).states(queued, running, current, renewed, renewalFailed);
const incident = H.work('Incident').schema(incidentSchema).states(queued, running, resolved, needsEngineering);

const serviceFacet = H.facet('service');

const operationalExperience = H.memory('operationalExperience')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');
const opsJournal = H.journal('operationalExperience').of(operationalExperience).store(jsonl.store('memory/ops.jsonl')).recall(policies.specificity());

const local = H.runner.local('local', { slots: 4 });
const dbHostA = H.runner.ssh('db-a', { host: H.env('DB_A_HOST'), user: 'ops', key: H.env('DB_A_SSH_KEY'), slots: 1 });
const dbHostB = H.runner.ssh('db-b', { host: H.env('DB_B_HOST'), user: 'ops', key: H.env('DB_B_SSH_KEY'), slots: 1 });
const hostRunner = (host: z.infer<typeof hostName>) => (host === 'db-a' ? dbHostA : dbHostB);

const probe = H.command('probeService')
  .input(heartbeatSchema)
  .runner(local)
  .effect('repeatable')
  .run(async input => {
    const response = await fetch(input.url);
    if (!response.ok) throw new Error(`${input.service} answered ${response.status}`);
  });

const diskPreflight = H.command('diskPreflight')
  .input(z.object({ host: hostName }))
  .runner(input => hostRunner(input.host))
  .effect('repeatable')
  .run(async (_input, ctx) => {
    const result = await ctx.sh("df --output=pcent /var/backups | tail -1 | tr -dc '0-9'");
    if (Number.parseInt(result.stdout, 10) > 85) throw new Error(`disk ${result.stdout}% full`);
  });

const dumpDatabase = H.command('dumpDatabase')
  .input(backupSchema)
  .runner(input => hostRunner(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`pg_dump ${input.database} | gzip > /var/backups/${input.database}.sql.gz`, { timeoutSeconds: 6 * 3600 });
    if (result.code !== 0) throw new Error(result.stderr);
  });

const certificateDays = H.command('certificateDays')
  .input(renewalSchema)
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => hostRunner(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`cert-days ${input.domain}`);
    return { daysLeft: Number.parseInt(result.stdout.trim(), 10) };
  });

const renewCertificate = H.command('renewCertificate')
  .input(renewalSchema)
  .runner(input => hostRunner(input.host))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`certbot renew --cert-name ${input.domain}`);
    if (result.code !== 0) throw new Error(result.stderr);
  });

const pageOnCall = H.command('pageOnCall')
  .input(incidentSchema)
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    await fetch(ctx.resolve(H.env('PAGER_URL')), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'dedup-key': ctx.unit.key },
      body: JSON.stringify({ title: input.title, service: input.service }),
    });
  });

const runRunbook = H.command('runRunbook')
  .input(z.object({ service: z.string(), source: z.string() }))
  .output(z.object({ log: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`runbooks/${input.source}.sh ${input.service}`);
    return { log: result.stdout };
  });

const acknowledgement = H.halt('incidentAcknowledgement')
  .context(z.object({ title: z.string(), service: z.string() }))
  .ask(c => `Acknowledge incident: ${c.title}`)
  .decision(z.object({ acknowledgedBy: z.string() }));

const resolutionConfirmation = H.halt('incidentResolution')
  .context(z.object({ title: z.string(), runbookLog: z.string() }))
  .ask(c => `Is "${c.title}" resolved?\n\n${c.runbookLog}`)
  .decision(z.object({ resolved: z.boolean(), notes: z.string() }));

const heartbeatFlow = H.flow('heartbeat').input(heartbeatSchema).step('probe', probe).exit('up');

const backupFlow = H.flow('backup')
  .input(backupSchema)
  .step('preflight', diskPreflight, s => ({ host: s.input.host }))
  .step('dump', dumpDatabase)
  .exit('backedUp');

const renewalFlow = H.flow('certificateRenewal')
  .input(renewalSchema)
  .step('check', certificateDays)
  .when(s => s.steps.check.daysLeft >= 14, notDue => notDue.exit('current'))
  .step('preflight', diskPreflight, s => ({ host: s.input.host }))
  .step('renew', renewCertificate)
  .exit('renewed');

const incidentFlow = H.flow('incidentRunbook')
  .input(incidentSchema)
  .step('page', pageOnCall)
  .halt('acknowledge', acknowledgement, s => ({ title: s.input.title, service: s.input.service }))
  .step('runbook', runRunbook, s => ({ service: s.input.service, source: s.input.source }))
  .halt('confirm', resolutionConfirmation, s => ({ title: s.input.title, runbookLog: s.steps.runbook.log }))
  .exit(s => (s.steps.confirm.resolved ? 'resolved' : 'stillBroken'));

const services = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://www.example.com/health' },
];
const databases = [
  { database: 'orders', host: 'db-a' },
  { database: 'billing', host: 'db-b' },
] as const;
const domains = [
  { domain: 'example.com', host: 'db-a' },
  { domain: 'api.example.com', host: 'db-b' },
] as const;

const heartbeats = H.lane('heartbeats')
  .of(heartbeat)
  .from(supply.schedule({ cron: '*/5 * * * *', units: () => services }).key(h => h.service))
  .handle(heartbeatFlow)
  .exits({ up, failed: { tries: 1, backoff: 'none', then: down } })
  .facet(serviceFacet, h => h.service);

const backups = H.lane('backups')
  .of(backup)
  .from(supply.schedule({ cron: '0 1 * * *', units: () => databases }).key(b => b.database))
  .handle(backupFlow)
  .exits({ backedUp, failed: { tries: 1, backoff: 'none', then: backupFailed } })
  .facet(serviceFacet, b => b.database);

const renewals = H.lane('renewals')
  .of(renewal)
  .from(supply.schedule({ cron: '0 3 * * 1', units: () => domains }).key(r => r.domain))
  .handle(renewalFlow)
  .exits({ current, renewed, failed: { tries: 2, backoff: 'linear', delaySeconds: 3600, then: renewalFailed } });

const incidents = H.lane('incidents')
  .of(incident)
  .from(supply.manual())
  .handle(incidentFlow)
  .exits({
    resolved,
    stillBroken: { to: queued, maxTimes: 3, then: needsEngineering },
    failed: { tries: 1, backoff: 'none', then: needsEngineering },
  });

const heartbeatStreak = H.trigger('threeFailedHeartbeats')
  .on(heartbeats.streak(down, 3, { by: serviceFacet }))
  .do(incidents.create(
    p => ({ title: `${p.key ?? 'a service'} failed three heartbeats in a row`, service: p.key ?? 'unknown', source: 'heartbeat' }),
    p => `heartbeat:${p.key ?? 'unknown'}`,
  ));

const backupFailure = H.trigger('backupFailureIncident')
  .on(backups.enters(backupFailed))
  .do(incidents.create(
    p => ({ title: `Backup of ${p.unit.data.database} failed`, service: p.unit.data.database, source: 'backup' }),
    p => `backup:${p.unit.data.database}`,
  ));

const slowBackup = H.trigger('slowBackupNote')
  .on(backups.enters(backedUp))
  .when(p => (p.attempt?.durationSeconds ?? 0) > 2 * 3600)
  .do(opsJournal.record(p => ({
    content: {
      do: `start the ${p.unit.data.database} backup earlier or check its table growth`,
      when: `backing up ${p.unit.data.database} on ${p.unit.data.host}`,
      because: `the backup took ${Math.round((p.attempt?.durationSeconds ?? 0) / 60)} minutes on ${p.unit.updatedAt.toISOString()}`,
    },
    when: { kinds: [backup] },
    status: 'accepted',
  })));

function rank(candidate: Candidate): number {
  if (candidate.lane === incidents) return 0;
  if (candidate.lane === heartbeats) return 1;
  if (candidate.lane === backups) return 2;
  return 3;
}

const incidentsPreempt = H.policy.schedule('incidentsPreempt', ({ candidates, load }) => {
  const incidentLoad = load(incidents);
  const incidentOpen = incidentLoad.pending + incidentLoad.active + incidentLoad.waiting > 0;
  return candidates
    .filter(c => !(incidentOpen && c.lane === backups))
    .sort((a, b) => rank(a) - rank(b) || b.waitingSeconds - a.waitingSeconds);
});

const operator = http.client('operator', { port: 8080, token: H.env('OPS_CONTROL_TOKEN') });

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, backups, renewals, incidents)
  .journals(opsJournal)
  .triggers(heartbeatStreak, backupFailure, slowBackup)
  .scheduler(H.scheduler().policy(incidentsPreempt))
  .grants(H.grant(
    operator,
    H.ops.work.read,
    H.ops.work.write,
    H.ops.resolve(acknowledgement),
    H.ops.resolve(resolutionConfirmation),
    H.ops.memory.read(opsJournal),
    H.ops.telemetry.read,
  ))
  .observe(
    observers.slack({ webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    observers.board({ path: 'BOARD.md' }),
  );

export const started = harness.start();
