import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Resource } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { http } from 'harness-dsl/http';
import { supply } from 'harness-dsl/supply';
import { observers } from 'harness-dsl/observers';

const due = H.state('due').pending();
const probing = H.state('probing').active();
const up = H.state('up').terminal('success');
const down = H.state('down').terminal('failure');

const queued = H.state('queued').pending();
const dumping = H.state('dumping').active();
const backedUp = H.state('backedUp').terminal('success');
const backupFailed = H.state('backupFailed').terminal('failure');

const scheduledCheck = H.state('scheduledCheck').pending();
const checking = H.state('checking').active();
const renewed = H.state('renewed').terminal('success');
const current = H.state('current').terminal('neutral');
const renewalFailed = H.state('renewalFailed').terminal('failure');

const open = H.state('open').pending();
const responding = H.state('responding').active();
const resolved = H.state('resolved').terminal('success');
const stuck = H.state('stuck').waiting();

const hostName = z.enum(['alpha', 'beta']);
type HostName = z.infer<typeof hostName>;

const heartbeatSchema = z.object({ service: z.string() });
const backupSchema = z.object({ database: z.string(), host: hostName });
const renewalSchema = z.object({ domain: z.string(), host: hostName });
const incidentSchema = z.object({ title: z.string(), source: z.string(), detail: z.string() });

const Heartbeat = H.work('Heartbeat').schema(heartbeatSchema).states(due, probing, up, down);
const Backup = H.work('Backup').schema(backupSchema).states(queued, dumping, backedUp, backupFailed);
const CertificateRenewal = H.work('CertificateRenewal').schema(renewalSchema).states(scheduledCheck, checking, renewed, current, renewalFailed);
const Incident = H.work('Incident').schema(incidentSchema).states(open, responding, resolved, stuck);

const serviceFacet = H.facet('service');

const local = H.runner.local('local', { slots: 4 });
const alpha = H.runner.ssh('alpha', { host: H.env('ALPHA_HOST'), user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1 });
const beta = H.runner.ssh('beta', { host: H.env('BETA_HOST'), user: 'ops', key: H.env('OPS_SSH_KEY'), slots: 1 });
const hosts = { alpha, beta };

const onDataHost = H.policy.runner<{ readonly input: { readonly host: HostName } }>(
  'onDataHost',
  [alpha, beta],
  ({ state }) => [hosts[state.input.host]],
);

const services: readonly string[] = ['api', 'web', 'worker', 'scheduler'];

const databases: ReadonlyArray<{ readonly database: string; readonly host: HostName; readonly resource: Resource }> = [
  { database: 'orders', host: 'alpha', resource: H.resource('orders') },
  { database: 'billing', host: 'alpha', resource: H.resource('billing') },
  { database: 'analytics', host: 'beta', resource: H.resource('analytics') },
];

const certificates: ReadonlyArray<z.infer<typeof renewalSchema>> = [
  { domain: 'example.com', host: 'alpha' },
  { domain: 'api.example.com', host: 'beta' },
];

const resourcesOf = (database: string): Resource[] =>
  databases.filter(entry => entry.database === database).map(entry => entry.resource);

const opsNote = H.memory('operationalExperience').content(z.object({ note: z.string() })).trust('experience');
const opsJournal = H.journal('operationalExperience').of(opsNote).store(jsonl.store('memory/operations.jsonl'));

const probeService = H.command('probeService')
  .input(heartbeatSchema)
  .output(z.object({ up: z.boolean() }))
  .runner(local)
  .run(async (input, ctx) => ({
    up: (await ctx.sh(`curl -fsS --max-time 10 https://${input.service}.internal/healthz`)).code === 0,
  }));

const diskPreflight = H.command('diskPreflight')
  .input(backupSchema)
  .output(z.object({ freeGb: z.number() }))
  .run(async (_, ctx) => {
    const result = await ctx.sh("df -BG --output=avail /var/backups | tail -1 | tr -dc '0-9'");
    if (result.code !== 0) throw new Error(result.stderr);
    return { freeGb: Number(result.stdout) };
  });

const dumpDatabase = H.command('dumpDatabase')
  .input(backupSchema)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(
      `pg_dump ${input.database} | gzip > /var/backups/${input.database}-$(date +%F).sql.gz`,
      { timeoutSeconds: 6 * 3600 },
    );
    if (result.code !== 0) throw new Error(result.stderr);
  });

const certificateCheck = H.command('certificateCheck')
  .input(renewalSchema)
  .output(z.object({ daysLeft: z.number() }))
  .run(async (input, ctx) => {
    const result = await ctx.sh(
      `echo | openssl s_client -servername ${input.domain} -connect ${input.domain}:443 2>/dev/null | openssl x509 -noout -enddate | cut -d= -f2`,
    );
    if (result.code !== 0) throw new Error(result.stderr);
    const expires = new Date(result.stdout.trim());
    return { daysLeft: Math.floor((expires.getTime() - ctx.now.getTime()) / 86400000) };
  });

const renewCertificate = H.command('renewCertificate')
  .input(renewalSchema)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`certbot renew --cert-name ${input.domain} --non-interactive`);
    if (result.code !== 0) throw new Error(result.stderr);
  });

const pageOnCall = H.command('pageOnCall')
  .input(incidentSchema)
  .runner(local)
  .effect('unrepeatable')
  .run(async (input, ctx) => {
    const response = await fetch('https://pager.example.com/v1/pages', {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.resolve(H.env('PAGER_TOKEN'))}`, 'content-type': 'application/json' },
      body: JSON.stringify({ summary: input.title, detail: input.detail, dedupKey: ctx.unit.key }),
    });
    if (!response.ok) throw new Error(`pager refused: ${response.status}`);
  });

const runRunbook = H.command('runRunbook')
  .input(incidentSchema)
  .output(z.object({ output: z.string() }))
  .runner(local)
  .run(async (input, ctx) => {
    const result = await ctx.sh(`./runbooks/${input.source}.sh`, { stdin: input.detail, timeoutSeconds: 1800 });
    return { output: `${result.stdout}\n${result.stderr}` };
  });

const acknowledgement = H.halt('acknowledgement')
  .context(incidentSchema)
  .ask(c => `Acknowledge incident: ${c.title}`)
  .decision(z.object({ by: z.string() }));

const resolution = H.halt('resolution')
  .context(z.object({ title: z.string(), runbookOutput: z.string() }))
  .ask(c => `Runbook finished for "${c.title}". Is the incident resolved?`)
  .decision(z.object({ resolved: z.boolean(), note: z.string() }));

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatSchema)
  .step('probe', probeService)
  .exit(s => (s.steps.probe.up ? 'up' : 'down'));

const backupFlow = H.flow('backup')
  .input(backupSchema)
  .step('preflight', diskPreflight, { runner: onDataHost })
  .when(s => s.steps.preflight.freeGb < 50, f => f.exit('noDiskSpace'))
  .step('dump', dumpDatabase, { runner: onDataHost })
  .exit('backedUp');

const renewalFlow = H.flow('renewal')
  .input(renewalSchema)
  .step('check', certificateCheck, { runner: onDataHost })
  .when(s => s.steps.check.daysLeft >= 14, f => f.exit('current'))
  .step('renew', renewCertificate, { runner: onDataHost })
  .exit('renewed');

const incidentFlow = H.flow('incident')
  .input(incidentSchema)
  .step('page', pageOnCall)
  .halt('acknowledge', acknowledgement, s => s.input)
  .step('runbook', runRunbook)
  .halt('confirm', resolution, s => ({ title: s.input.title, runbookOutput: s.steps.runbook.output }))
  .exit(s => (s.steps.confirm.resolved ? 'resolved' : 'unresolved'));

const heartbeats = H.lane('heartbeats')
  .of(Heartbeat)
  .from(supply.schedule({ cron: '*/5 * * * *', units: () => services.map(service => ({ service })) }).key(beat => beat.service))
  .facet(serviceFacet, beat => beat.service)
  .handle(heartbeatFlow, {
    exits: { up, down },
    retry: { tries: 0, backoff: 'none', exhausted: down },
  });

const backups = H.lane('backups')
  .of(Backup)
  .from(
    supply.schedule({ cron: '0 1 * * *', units: () => databases.map(entry => ({ database: entry.database, host: entry.host })) })
      .key(backup => backup.database),
  )
  .handle(backupFlow, {
    exits: { backedUp, noDiskSpace: backupFailed },
    retry: { tries: 1, backoff: 'linear', delaySeconds: 600, exhausted: backupFailed },
  });

const renewals = H.lane('renewals')
  .of(CertificateRenewal)
  .from(supply.schedule({ cron: '0 4 * * 1', units: () => certificates }).key(certificate => certificate.domain))
  .handle(renewalFlow, {
    exits: { renewed, current },
    retry: { tries: 2, backoff: 'exponential', delaySeconds: 300, exhausted: renewalFailed },
  });

const incidents = H.lane('incidents')
  .of(Incident)
  .from(supply.manual())
  .handle(incidentFlow, {
    exits: { resolved, unresolved: open },
    retry: { tries: 3, backoff: 'linear', delaySeconds: 60, exhausted: stuck },
  });

const threeHeartbeatsDown = H.trigger('threeHeartbeatsDown')
  .on(H.streak(heartbeats, down, 3, { by: serviceFacet }))
  .do(
    H.create(
      incidents,
      p => ({
        title: `${p.key ?? 'a service'} failed three consecutive heartbeats`,
        source: 'heartbeat',
        detail: p.units.map(unit => unit.updatedAt.toISOString()).join(', '),
      }),
      { key: p => `heartbeat:${p.key ?? 'unknown'}` },
    ),
  );

const failedBackupOpensIncident = H.trigger('failedBackupOpensIncident')
  .on(H.entered(backups, backupFailed))
  .do(
    H.create(
      incidents,
      p => ({ title: `Backup of ${p.unit.data.database} failed`, source: 'backup', detail: `host ${p.unit.data.host}` }),
      { key: p => `backup:${p.unit.data.database}` },
    ),
  );

const slowBackupBecomesNote = H.trigger('slowBackupBecomesNote')
  .on(H.entered(backups, backedUp))
  .when(p => (p.attempt?.durationSeconds ?? 0) > 2 * 3600)
  .do(
    H.record(opsJournal, p => ({
      content: {
        note: `When planning the ${p.unit.data.database} backup on ${p.unit.data.host}, allow more than two hours of window, because the run of ${p.unit.createdAt.toISOString().slice(0, 10)} took ${Math.round((p.attempt?.durationSeconds ?? 0) / 60)} minutes`,
      },
      when: { kinds: [Backup], resources: resourcesOf(p.unit.data.database) },
    })),
  );

const lanePriority = (candidate: Candidate): number => {
  if (candidate.lane === incidents) return 0;
  if (candidate.lane === heartbeats) return 1;
  if (candidate.lane === renewals) return 2;
  return 3;
};

const incidentsPreempt = H.policy.schedule('incidentsPreempt', ({ candidates, marking }) => {
  const incidentActive = marking.count(incidents, 'active', 'waiting') > 0;
  return candidates
    .filter(candidate => !(incidentActive && candidate.lane === backups && !candidate.resuming))
    .sort((a, b) => lanePriority(a) - lanePriority(b) || b.waitingSeconds - a.waitingSeconds);
});

const operator = http.client('operator', { port: 8080, token: H.env('OPS_API_TOKEN') });

const operatorGrant = H.grant(
  operator,
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(acknowledgement),
  H.ops.resolve(resolution),
  H.ops.memory.read(opsJournal),
  H.ops.telemetry.read,
);

export default H.harness('operations')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(incidents, heartbeats, backups, renewals)
  .journals(opsJournal)
  .triggers(threeHeartbeatsDown, failedBackupOpensIncident, slowBackupBecomesNote)
  .schedule(incidentsPreempt)
  .grants(operatorGrant)
  .observe(
    observers.slack({ webhookUrl: H.env('SLACK_WEBHOOK_URL'), lanes: [incidents] }),
    observers.board({ path: 'BOARD.md' }),
  );
