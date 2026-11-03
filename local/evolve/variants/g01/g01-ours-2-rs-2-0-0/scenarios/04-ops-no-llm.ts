import { z } from 'zod';
import { H } from 'harness-dsl';
import type { RunnerPolicyInput } from 'harness-dsl/kernel';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';

const due = H.state('due').pending();
const running = H.state('running').active();
const up = H.state('up').terminal('success');
const down = H.state('down').terminal('failure');
const backedUp = H.state('backed-up').terminal('success');
const backupFailed = H.state('backup-failed').terminal('failure');
const stillValid = H.state('still-valid').terminal('neutral');
const renewed = H.state('renewed').terminal('success');
const renewalFailed = H.state('renewal-failed').terminal('failure');
const incidentOpen = H.state('incident-open').pending();
const responding = H.state('responding').active();
const incidentResolved = H.state('incident-resolved').terminal('success');
const incidentFailed = H.state('incident-failed').terminal('failure');

const serviceSchema = z.object({ service: z.string() });
const databaseSchema = z.object({ database: z.string() });
const certificateSchema = z.object({ domain: z.string() });
const incidentSchema = z.object({ title: z.string(), service: z.string(), origin: z.string() });

const heartbeat = H.work('heartbeat').schema(serviceSchema).states(due, running, up, down);
const backup = H.work('backup').schema(databaseSchema).states(due, running, backedUp, backupFailed);
const renewal = H.work('certificate-renewal').schema(certificateSchema).states(due, running, stillValid, renewed, renewalFailed);
const incident = H.work('incident').schema(incidentSchema).states(incidentOpen, responding, incidentResolved, incidentFailed);

const serviceFacet = H.facet('service');

const opsNote = H.memory('operational-note')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');
const opsJournal = H.journal('operations').of(opsNote).store(jsonl.store('memory/operations.jsonl')).recall(policies.specificity());

const local = H.runner.local('local', { slots: 8 });
const hostA = H.runner.ssh('db-host-a', { host: H.env('DB_HOST_A'), user: 'ops', key: H.env('DB_HOST_KEY'), slots: 1 });
const hostB = H.runner.ssh('db-host-b', { host: H.env('DB_HOST_B'), user: 'ops', key: H.env('DB_HOST_KEY'), slots: 1 });

const databases = [
  { database: 'orders', host: hostA },
  { database: 'billing', host: hostA },
  { database: 'analytics', host: hostB },
  { database: 'auth', host: hostB },
];
const services = ['api', 'web', 'worker', 'gateway'];
const domains = ['example.com', 'api.example.com'];

const databaseHost = H.policy.runner(
  'database-host',
  [hostA, hostB],
  (input: RunnerPolicyInput<z.output<typeof databaseSchema>>) => [
    databases.find(entry => entry.database === input.input.database)?.host ?? hostA,
  ],
);

const probe = H.command('probe')
  .input(serviceSchema)
  .output(z.object({ healthy: z.boolean() }))
  .runner(local)
  .run(async (input, ctx) => {
    const result = await ctx.sh(`curl -fsS --max-time 10 https://${input.service}.internal/health`);
    return { healthy: result.code === 0 };
  });

const diskPreflight = H.command('disk-preflight')
  .input(databaseSchema)
  .output(z.object({ freeGb: z.number() }))
  .runners(databaseHost)
  .run(async (_input, ctx) => {
    const result = await ctx.sh('df -BG --output=avail /var/backups | tail -1 | tr -dc 0-9');
    const freeGb = Number.parseInt(result.stdout, 10);
    if (freeGb >= 50) return { freeGb };
    throw new Error(`only ${freeGb} GB free for backups`);
  });

const runBackup = H.command('run-backup')
  .input(databaseSchema)
  .output(z.object({ archive: z.string() }))
  .runners(databaseHost)
  .run(async (input, ctx) => {
    const archive = `/var/backups/${input.database}-${ctx.now.toISOString().slice(0, 10)}.dump`;
    const result = await ctx.sh(`pg_dump --format=custom --file=${archive} ${input.database}`, { timeoutSeconds: 6 * 3600 });
    if (result.code === 0) return { archive };
    throw new Error(result.stderr);
  });

const checkCertificate = H.command('check-certificate')
  .input(certificateSchema)
  .output(z.object({ daysLeft: z.number() }))
  .runner(local)
  .run(async (input, ctx) => {
    const result = await ctx.sh(`cert-days-left ${input.domain}`);
    return { daysLeft: Number.parseInt(result.stdout.trim(), 10) };
  });

const renewCertificate = H.command('renew-certificate')
  .input(certificateSchema)
  .runners(H.policy.runner('freest-host', [hostA, hostB], input =>
    input.candidates.slice().sort((a, b) => b.freeSlots - a.freeSlots).map(candidate => candidate.runner)))
  .run(async (input, ctx) => {
    const result = await ctx.sh(`certbot renew --cert-name ${input.domain} --non-interactive`);
    if (result.code === 0) return;
    throw new Error(result.stderr);
  });

const page = H.command('page-on-call')
  .input(z.object({ title: z.string(), service: z.string() }))
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const response = await fetch(ctx.resolve(H.env('PAGER_URL')), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: input.title, service: input.service }),
    });
    if (response.ok) return;
    throw new Error(`pager returned ${response.status}`);
  });

const runbook = H.command('runbook')
  .input(z.object({ service: z.string() }))
  .output(z.object({ log: z.string() }))
  .runner(local)
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./runbooks/${input.service}.sh`);
    return { log: result.stdout };
  });

const acknowledgement = H.halt('incident-acknowledgement')
  .context(z.object({ title: z.string() }))
  .ask(context => `Acknowledge incident: ${context.title}`)
  .decision(z.object({ responder: z.string() }));
const resolutionCheck = H.halt('incident-resolution')
  .context(z.object({ title: z.string(), runbookLog: z.string() }))
  .ask(context => `Is "${context.title}" resolved?\n\n${context.runbookLog}`)
  .decision(z.object({ resolved: z.boolean(), note: z.string() }));

const heartbeatFlow = H.flow('heartbeat')
  .input(serviceSchema)
  .step('probe', probe)
  .exit(s => (s.steps.probe.healthy ? 'up' : 'down'));

const backupFlow = H.flow('backup')
  .input(databaseSchema)
  .step('preflight', diskPreflight)
  .step('dump', runBackup)
  .exit('backedUp');

const renewalFlow = H.flow('certificate-renewal')
  .input(certificateSchema)
  .step('check', checkCertificate)
  .when(s => s.steps.check.daysLeft >= 14, f => f.exit('stillValid'))
  .step('renew', renewCertificate)
  .exit('renewed');

const respondFlow = H.flow('respond')
  .input(incidentSchema)
  .step('page', page, s => ({ title: s.input.title, service: s.input.service }))
  .halt('acknowledge', acknowledgement, s => ({ title: s.input.title }))
  .step('runbook', runbook, s => ({ service: s.input.service }))
  .halt('confirm', resolutionCheck, s => ({ title: s.input.title, runbookLog: s.steps.runbook.log }))
  .exit(s => (s.steps.confirm.resolved ? 'resolved' : 'unresolved'));

const checkHeartbeat = H.handler('check-heartbeat')
  .of(heartbeat)
  .flow(heartbeatFlow)
  .exits({ up, down })
  .retry({ tries: 0, backoff: 'none', exhausted: down });
const runBackups = H.handler('run-backup')
  .of(backup)
  .flow(backupFlow)
  .exits({ backedUp })
  .retry({ tries: 0, backoff: 'none', exhausted: backupFailed });
const renewCertificates = H.handler('renew-certificates')
  .of(renewal)
  .flow(renewalFlow)
  .exits({ stillValid, renewed })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 600, exhausted: renewalFailed });
const respondToIncident = H.handler('respond-to-incident')
  .of(incident)
  .flow(respondFlow)
  .exits({ resolved: incidentResolved, unresolved: { to: incidentOpen, maxTimes: 3, then: incidentFailed } })
  .retry({ tries: 1, backoff: 'linear', delaySeconds: 60, exhausted: incidentFailed });

const heartbeats = H.lane('heartbeats', checkHeartbeat)
  .from(supply.schedule({ cron: '*/5 * * * *', units: () => services.map(service => ({ service })) }))
  .facet(serviceFacet, data => data.service);
const backups = H.lane('backups', runBackups)
  .from(supply.schedule({ cron: '0 1 * * *', units: () => databases.map(entry => ({ database: entry.database })) }));
const renewals = H.lane('certificate-renewals', renewCertificates)
  .from(supply.schedule({ cron: '0 4 * * 1', units: () => domains.map(domain => ({ domain })) }));
const incidents = H.lane('incidents', respondToIncident)
  .from(supply.manual())
  .store(sqlite.store('.harness/incidents.db'));

const heartbeatStreak = H.trigger('three-failed-heartbeats-open-incident')
  .on(heartbeats.streak(down, 3, { by: serviceFacet }))
  .do(incidents.create(
    p => ({ title: `${p.key ?? 'unknown service'} failed three heartbeats in a row`, service: p.key ?? 'unknown', origin: 'heartbeat' }),
    p => `heartbeat:${p.key ?? 'unknown'}`,
  ));

const failedBackup = H.trigger('failed-backup-opens-incident')
  .on(backups.enters(backupFailed))
  .do(incidents.create(
    p => ({ title: `Backup of ${p.unit.data.database} failed`, service: p.unit.data.database, origin: 'backup' }),
    p => `backup:${p.unit.data.database}`,
  ));

const slowBackup = H.trigger('slow-backup-records-note')
  .on(backups.enters(backedUp))
  .when(p => (p.attempt?.durationSeconds ?? 0) > 2 * 3600)
  .do(opsJournal.record(p => ({
    content: {
      do: `start the ${p.unit.data.database} backup earlier or split it`,
      when: `backing up ${p.unit.data.database}`,
      because: `the backup took ${Math.round((p.attempt?.durationSeconds ?? 0) / 60)} minutes`,
    },
    when: { kinds: [backup] },
  })));

const incidentsFirst = H.policy.schedule('incidents-preempt', input => {
  const incidentActive = input.units(incidents, 'active', 'waiting').length > 0;
  return [
    ...input.of(incidents),
    ...input.of(heartbeats),
    ...input.of(renewals),
    ...(incidentActive ? [] : input.of(backups)),
  ];
});

const operator = http.client('operator', { port: 8080, token: H.env('OPS_CONTROL_TOKEN') });
const operatorGrant = H.grant(
  operator,
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(acknowledgement),
  H.ops.resolve(resolutionCheck),
  H.ops.memory.read(opsJournal),
  H.ops.telemetry.read,
);

export const harness = H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .journals(opsJournal)
  .triggers(heartbeatStreak, failedBackup, slowBackup)
  .scheduler(H.scheduler().policy(incidentsFirst))
  .grants(operatorGrant)
  .observe(
    observers.slack({ webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    observers.board({ path: 'BOARD.md' }),
  );

void harness.start();
