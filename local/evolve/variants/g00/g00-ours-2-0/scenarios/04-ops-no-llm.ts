import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Runner } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { observers } from 'harness-dsl/observers';

const scheduled = H.state('scheduled').pending();
const running = H.state('running').active();
const healthy = H.state('healthy').terminal('success');
const unhealthy = H.state('unhealthy').terminal('failure');
const backedUp = H.state('backedUp').terminal('success');
const backupFailed = H.state('backupFailed').terminal('failure');
const renewed = H.state('renewed').terminal('success');
const stillValid = H.state('stillValid').terminal('success');
const renewalFailed = H.state('renewalFailed').terminal('failure');
const open = H.state('open').pending();
const resolved = H.state('resolved').terminal('success');
const handedOff = H.state('handedOff').terminal('failure');

const heartbeatSchema = z.object({ service: z.string(), at: z.string() });
const backupSchema = z.object({ database: z.string(), night: z.string() });
const renewalSchema = z.object({ domain: z.string(), week: z.string() });
const incidentSchema = z.object({ title: z.string(), service: z.string(), source: z.string() });

const heartbeat = H.work('Heartbeat').schema(heartbeatSchema).states(scheduled, running, healthy, unhealthy);
const backup = H.work('Backup').schema(backupSchema).states(scheduled, running, backedUp, backupFailed);
const certificateRenewal = H.work('CertificateRenewal').schema(renewalSchema).states(scheduled, running, renewed, stillValid, renewalFailed);
const incident = H.work('Incident').schema(incidentSchema).states(open, running, resolved, handedOff);

const serviceFacet = H.facet('service');

const opsExperience = H.memory('ops-experience')
  .content(z.object({ action: z.string(), condition: z.string(), reason: z.string() }))
  .trust('experience');
const opsJournal = H.journal('ops-experience').of(opsExperience).store(jsonl.store('memory/ops.jsonl'));

const local = H.runner.local('local', { slots: 8 });
const sshKey = H.env('OPS_SSH_KEY');
const hostA = H.runner.ssh('db-host-a', { host: H.env('DB_HOST_A'), user: 'ops', key: sshKey, slots: 1 });
const hostB = H.runner.ssh('db-host-b', { host: H.env('DB_HOST_B'), user: 'ops', key: sshKey, slots: 1 });

const probe = H.command('probe-service')
  .input(heartbeatSchema)
  .output(z.object({ healthy: z.boolean() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const response = await fetch(ctx.resolve(H.env(`HEALTH_URL_${input.service.toUpperCase()}`)), { signal: ctx.signal });
    return { healthy: response.ok };
  });

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatSchema)
  .step('probe', probe)
  .exit(s => (s.steps.probe.healthy ? 'healthy' : 'unhealthy'));

const services = ['api', 'web', 'queue'];
const heartbeats = H.lane('heartbeats')
  .of(heartbeat)
  .from(supply.schedule({
    cron: '*/5 * * * *',
    units: now => services.map(service => ({ service, at: now.toISOString() })),
  }).key(data => `${data.service}-${data.at}`))
  .handle(heartbeatFlow)
  .exits({ healthy, unhealthy })
  .retry({ tries: 1, backoff: 'none', exhausted: unhealthy })
  .facet(serviceFacet, data => data.service);

const minimumFreeGb = 50;
const diskPreflight = (host: Runner) => H.command(`disk-preflight-${host.name}`)
  .output(z.object({ freeGb: z.number() }))
  .runner(host)
  .effect('repeatable')
  .run(async (_input, ctx) => {
    const result = await ctx.sh('df -BG --output=avail /var/backups | tail -1 | tr -dc 0-9');
    return { freeGb: Number.parseInt(result.stdout, 10) };
  });

const backupCommand = (host: Runner) => H.command(`backup-${host.name}`)
  .input(backupSchema)
  .runner(host)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`pg_dump --format=custom --file=/var/backups/${input.database}-${input.night}.dump ${input.database}`);
    if (result.code !== 0) throw new Error(result.stderr);
  });

const backupFlow = (host: Runner) => H.flow(`backup-${host.name}`)
  .input(backupSchema)
  .step('preflight', diskPreflight(host))
  .when(s => s.steps.preflight.freeGb < minimumFreeGb, low => low.exit('insufficientDisk'))
  .step('backup', backupCommand(host))
  .exit('backedUp');

const backupLane = (host: Runner, databases: readonly string[]) => H.lane(`backups-${host.name}`)
  .of(backup)
  .from(supply.schedule({
    cron: '0 1 * * *',
    units: now => databases.map(database => ({ database, night: now.toISOString().slice(0, 10) })),
  }).key(data => `${data.database}-${data.night}`))
  .handle(backupFlow(host))
  .exits({ insufficientDisk: backupFailed, backedUp })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 600, exhausted: backupFailed });

const renewalFlow = (host: Runner) => H.flow(`renewal-${host.name}`)
  .input(renewalSchema)
  .step('check', H.command(`certificate-days-left-${host.name}`)
    .input(renewalSchema)
    .output(z.object({ daysLeft: z.number() }))
    .runner(host)
    .effect('repeatable')
    .run(async (input, ctx) => {
      const result = await ctx.sh(`openssl x509 -enddate -noout -in /etc/ssl/${input.domain}.pem | cut -d= -f2`);
      return { daysLeft: Math.floor((Date.parse(result.stdout.trim()) - ctx.now.getTime()) / 86_400_000) };
    }))
  .when(s => s.steps.check.daysLeft >= 14, valid => valid.exit('stillValid'))
  .step('renew', H.command(`certificate-renew-${host.name}`)
    .input(renewalSchema)
    .runner(host)
    .effect('repeatable')
    .run(async (input, ctx) => {
      const result = await ctx.sh(`certbot renew --cert-name ${input.domain} --non-interactive`);
      if (result.code !== 0) throw new Error(result.stderr);
    }))
  .exit('renewed');

const renewalLane = (host: Runner, domains: readonly string[]) => H.lane(`renewals-${host.name}`)
  .of(certificateRenewal)
  .from(supply.schedule({
    cron: '0 4 * * 1',
    units: now => domains.map(domain => ({ domain, week: now.toISOString().slice(0, 10) })),
  }).key(data => `${data.domain}-${data.week}`))
  .handle(renewalFlow(host))
  .exits({ stillValid, renewed })
  .retry({ tries: 2, backoff: 'linear', delaySeconds: 3600, exhausted: renewalFailed });

const backupLanes = [backupLane(hostA, ['orders', 'customers']), backupLane(hostB, ['analytics', 'billing'])];
const renewalLanes = [renewalLane(hostA, ['shop.example.com']), renewalLane(hostB, ['api.example.com'])];

const acknowledge = H.halt('incident-acknowledgement')
  .context(incidentSchema)
  .ask(c => `Acknowledge incident: ${c.title}`)
  .decision(z.object({ acknowledgedBy: z.string() }));

const confirmResolution = H.halt('incident-resolution')
  .context(z.object({ title: z.string(), runbookOutput: z.string() }))
  .ask(c => `Is "${c.title}" resolved?\n\n${c.runbookOutput}`)
  .decision(z.object({ resolved: z.boolean(), note: z.string().optional() }));

const page = H.command('page-on-call')
  .input(incidentSchema)
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const response = await fetch(ctx.resolve(H.env('PAGER_URL')), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: input.title, service: input.service }),
    });
    if (!response.ok) throw new Error(`pager returned ${response.status}`);
  });

const runbook = H.command('run-runbook')
  .input(incidentSchema)
  .output(z.object({ output: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./runbooks/${input.service}.sh`, { timeoutSeconds: 900 });
    return { output: `${result.code}\n${result.stdout}\n${result.stderr}` };
  });

const incidentFlow = H.flow('incident')
  .input(incidentSchema)
  .step('page', page)
  .halt('acknowledge', acknowledge, s => s.input)
  .step('runbook', runbook)
  .halt('confirmResolution', confirmResolution, s => ({ title: s.input.title, runbookOutput: s.steps.runbook.output }))
  .exit(s => (s.steps.confirmResolution.resolved ? 'resolved' : 'unresolved'));

const incidents = H.lane('incidents')
  .of(incident)
  .from(supply.manual())
  .handle(incidentFlow)
  .exits({ resolved, unresolved: { to: open, maxTimes: 3, then: handedOff } })
  .retry({ tries: 2, backoff: 'none', exhausted: handedOff });

const failingHeartbeatsOpenIncident = H.trigger('three-failed-heartbeats-open-incident')
  .on(heartbeats.streak(unhealthy, 3, { by: serviceFacet }))
  .do(incidents.create(
    p => ({ title: `${p.key ?? 'unknown'} failed three heartbeats in a row`, service: p.key ?? 'unknown', source: 'heartbeat' }),
    p => `heartbeat-${p.key ?? 'unknown'}`,
  ));

const backupFailuresOpenIncidents = backupLanes.map(lane => H.trigger(`${lane.name}-failure-opens-incident`)
  .on(lane.enters(backupFailed))
  .do(incidents.create(
    p => ({ title: `Backup of ${p.unit.data.database} failed on ${p.unit.data.night}`, service: p.unit.data.database, source: 'backup' }),
    p => `backup-${p.unit.data.database}-${p.unit.data.night}`,
  )));

const slowBackupSeconds = 2 * 3600;
const slowBackupsBecomeExperience = backupLanes.map(lane => H.trigger(`${lane.name}-slow-backup-note`)
  .on(lane.enters(backedUp))
  .when(p => p.attempt !== undefined && p.attempt.durationSeconds > slowBackupSeconds)
  .do(opsJournal.record(p => ({
    content: {
      condition: `when scheduling the backup of ${p.unit.data.database}`,
      action: 'start it earlier or split it',
      reason: `the ${p.unit.data.night} backup took ${Math.round((p.attempt?.durationSeconds ?? 0) / 60)} minutes`,
    },
    when: { kinds: [backup] },
  }))));

const incidentsOpened = H.metric('incidents-opened').count(H.events.created());
const incidentsClosed = H.metric('incidents-closed').count(H.events.terminal());

const backupNames = new Set(backupLanes.map(lane => lane.name));
const renewalNames = new Set(renewalLanes.map(lane => lane.name));
const laneRank = (lane: string) =>
  lane === incidents.name ? 0 : lane === heartbeats.name ? 1 : renewalNames.has(lane) ? 2 : 3;

const incidentsPreempt = H.policy.schedule('incidents-preempt', ({ candidates, metrics }) => {
  const openIncidents =
    (metrics.read(incidentsOpened, { where: { lane: incidents } }).value ?? 0) -
    (metrics.read(incidentsClosed, { where: { lane: incidents } }).value ?? 0);
  return [...candidates]
    .filter(c => openIncidents <= 0 || !backupNames.has(c.lane.name))
    .sort((a, b) => laneRank(a.lane.name) - laneRank(b.lane.name));
});

const operator = H.grant(
  http.client('operator-api', { port: 8443, token: H.env('OPS_API_TOKEN') }),
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(acknowledge),
  H.ops.resolve(confirmResolution),
  H.ops.memory.curate(opsJournal),
  H.ops.telemetry.read,
);

export default H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, incidents, ...backupLanes, ...renewalLanes)
  .journals(opsJournal)
  .triggers(failingHeartbeatsOpenIncident, ...backupFailuresOpenIncidents, ...slowBackupsBecomeExperience)
  .scheduler(H.scheduler().policy(incidentsPreempt))
  .grants(operator)
  .observe(
    observers.slack({ webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    observers.board({ path: 'BOARD.md' }),
  );
