import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const hostName = z.enum(['db-a', 'db-b']);
const heartbeatAttributes = z.object({ service: z.string(), tickAt: z.string() });
const backupAttributes = z.object({ database: z.string(), host: hostName, night: z.string() });
const renewalAttributes = z.object({ domain: z.string(), host: hostName, week: z.string() });
const incidentAttributes = z.object({ ref: z.string(), title: z.string(), service: z.string(), detail: z.string() });

const services: readonly string[] = ['api', 'web', 'worker'];
const databases: readonly z.infer<typeof backupAttributes>['host'][] = ['db-a', 'db-b'];
const databaseOnHost: Readonly<Record<z.infer<typeof hostName>, string>> = { 'db-a': 'orders', 'db-b': 'billing' };
const certificates: readonly { readonly domain: string; readonly host: z.infer<typeof hostName> }[] = [
  { domain: 'api.example.com', host: 'db-a' },
  { domain: 'www.example.com', host: 'db-b' },
];

const heartbeatDue = H.state('HeartbeatDue', 'pending');
const probing = H.state('Probing', 'active');
const up = H.state('Up', 'terminal', 'success');
const down = H.state('Down', 'terminal', 'failure');
const backupQueued = H.state('BackupQueued', 'pending');
const dumping = H.state('Dumping', 'active');
const backedUp = H.state('BackedUp', 'terminal', 'success');
const backupFailed = H.state('BackupFailed', 'terminal', 'failure');
const renewalDue = H.state('RenewalDue', 'pending');
const checking = H.state('CheckingExpiry', 'active');
const renewing = H.state('Renewing', 'active');
const stillValid = H.state('StillValid', 'terminal', 'success');
const renewed = H.state('Renewed', 'terminal', 'success');
const renewalFailed = H.state('RenewalFailed', 'terminal', 'failure');
const incidentOpen = H.state('IncidentOpen', 'pending');
const paged = H.state('Paged', 'waiting');
const mitigating = H.state('Mitigating', 'active');
const confirming = H.state('ConfirmingResolution', 'waiting');
const resolved = H.state('Resolved', 'terminal', 'success');
const unresolved = H.state('Unresolved', 'terminal', 'failure');
const dismissed = H.state('Dismissed', 'terminal', 'neutral');

const Heartbeat = H.kind('Heartbeat')
  .attributes(heartbeatAttributes)
  .states(heartbeatDue, probing, up, down)
  .key(attrs => `${attrs.service}@${attrs.tickAt}`);
const Backup = H.kind('Backup')
  .attributes(backupAttributes)
  .states(backupQueued, dumping, backedUp, backupFailed)
  .key(attrs => `${attrs.database}@${attrs.night}`);
const CertificateRenewal = H.kind('CertificateRenewal')
  .attributes(renewalAttributes)
  .states(renewalDue, checking, renewing, stillValid, renewed, renewalFailed)
  .key(attrs => `${attrs.domain}@${attrs.week}`);
const Incident = H.kind('Incident')
  .attributes(incidentAttributes)
  .states(incidentOpen, paged, mitigating, confirming, resolved, unresolved, dismissed)
  .key(attrs => attrs.ref);

const localRunner = local.runner('ops-local');
const sshKey = H.env('OPS_SSH_KEY');
const diskSpace = H.command('disk-space-preflight').argv(['sh', '-c', 'test "$(df --output=avail -BG /var/backups | tail -1 | tr -dc 0-9)" -ge 50']);
const hostA = ssh.host('db-a', { host: 'db-a.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace);
const hostB = ssh.host('db-b', { host: 'db-b.internal', user: 'ops', key: sshKey }).slots(1).preflight(diskSpace);

const healthCheck = H.command('health-check')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', '--max-time', '10', `https://${input.service}.internal/health`])
  .runner(localRunner);

const backupDump = H.command('backup-dump')
  .input(z.object({ database: z.string(), host: hostName }))
  .argv(input => ['backup-database', input.database])
  .runner(input => (input.host === 'db-a' ? hostA : hostB));

const certificateExpiry = H.command('certificate-expiry')
  .input(z.object({ domain: z.string(), host: hostName }))
  .argv(input => ['cert-days-left', '--json', input.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(input => (input.host === 'db-a' ? hostA : hostB));

const certificateRenew = H.command('certificate-renew')
  .input(z.object({ domain: z.string(), host: hostName }))
  .argv(input => ['cert-renew', input.domain])
  .runner(input => (input.host === 'db-a' ? hostA : hostB));

const runbook = H.command('incident-runbook')
  .input(z.object({ service: z.string() }))
  .argv(input => ['runbook', 'mitigate', '--service', input.service])
  .runner(localRunner);

const probeService = H.flow('probe-service')
  .input(heartbeatAttributes)
  .step('probe', healthCheck, ctx => ({ service: ctx.unit.attributes.service }), { timeoutMs: 30000, onCrash: 'rerun' })
  .exit('up');

const backUpDatabase = H.flow('back-up-database')
  .input(backupAttributes)
  .step('dump', backupDump, ctx => ({ database: ctx.unit.attributes.database, host: ctx.unit.attributes.host }), {
    timeoutMs: 6 * 3600000,
    onCrash: 'rerun',
  })
  .exit('done');

const renewCertificate = H.flow('renew-certificate')
  .input(renewalAttributes)
  .step('check', certificateExpiry, ctx => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }), { onCrash: 'rerun' })
  .exit('stillValid', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', certificateRenew, ctx => ({ domain: ctx.unit.attributes.domain, host: ctx.unit.attributes.host }), { onCrash: 'rerun' })
  .exit('renewed');

const respondToIncident = H.flow('respond-to-incident')
  .input(incidentAttributes)
  .halt('acknowledge', {
    ask: ctx => `Incident: ${ctx.unit.attributes.title}\n${ctx.unit.attributes.detail}\nAcknowledge to run the runbook.`,
    decision: z.object({ acknowledgedBy: z.string() }),
  })
  .step('runbook', runbook, ctx => ({ service: ctx.unit.attributes.service }), { onCrash: 'park' })
  .halt('confirmResolution', {
    ask: ctx => `The runbook finished for ${ctx.unit.attributes.service}. Is the incident resolved?`,
    decision: z.object({ resolved: z.boolean(), notes: z.string().optional() }),
  })
  .exit('resolved', ctx => ctx.steps.confirmResolution.resolved)
  .exit('unresolved');

const heartbeatLane = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('heartbeat-clock').every({ minutes: 5 }), (tick, to) =>
    services.map(service => to.create({ service, tickAt: tick.at.toISOString() })),
  )
  .handler(probeService, { exits: { up }, during: { probe: probing }, failure: down });

const backupLane = H.lane('backups', Backup)
  .supply(H.clock('nightly-backups').daily('01:30', { tz: 'UTC' }), (tick, to) =>
    databases.map(host => to.create({ database: databaseOnHost[host], host, night: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/ops-units.db' }))
  .handler(backUpDatabase, { exits: { done: backedUp }, during: { dump: dumping }, failure: backupFailed });

const renewalLane = H.lane('certificate-renewals', CertificateRenewal)
  .supply(H.clock('weekly-certificates').weekly('mon', '04:00', { tz: 'UTC' }), (tick, to) =>
    certificates.map(certificate => to.create({ ...certificate, week: tick.at.toISOString().slice(0, 10) })),
  )
  .store(sqlite.store({ path: '.harness/ops-units.db' }))
  .handler(renewCertificate, {
    exits: { stillValid, renewed },
    during: { check: checking, renew: renewing },
    failure: renewalFailed,
  });

const incidentLane = H.lane('incidents', Incident)
  .supply(H.operator)
  .store(sqlite.store({ path: '.harness/ops-units.db' }))
  .handler(respondToIncident, {
    exits: { resolved, unresolved },
    during: { acknowledge: paged, runbook: mitigating, confirmResolution: confirming },
    failure: unresolved,
    cancelled: dismissed,
  });

const operationalExperience = H.memory('operational-experience', 'experience');
const operationsJournal = H.journal('operations-journal', operationalExperience)
  .store(jsonl.memoryStore({ path: '.harness/memory/operations.jsonl' }));

const repeatedHeartbeatFailures = H.trigger('repeated-heartbeat-failures')
  .on(H.when.pattern(heartbeatLane, { to: down, consecutive: 3, per: unit => unit.attributes.service }))
  .create(incidentLane, event => ({
    ref: `heartbeat:${event.group}`,
    title: `${event.group} failed ${event.streak} consecutive heartbeats`,
    service: event.group,
    detail: `Last failure at ${event.at.toISOString()}.`,
  }));

const failedBackup = H.trigger('failed-backup')
  .on(H.when.transition(backupLane, { to: backupFailed }))
  .create(incidentLane, event => ({
    ref: `backup:${event.unit.attributes.database}:${event.unit.attributes.night}`,
    title: `Backup of ${event.unit.attributes.database} failed`,
    service: event.unit.attributes.database,
    detail: `Nightly backup on ${event.unit.attributes.host} for ${event.unit.attributes.night} failed.`,
  }));

const slowBackup = H.trigger('slow-backup')
  .on(H.when.transition(backupLane, {
    to: backedUp,
    if: event => (event.attempt?.durationMs ?? 0) > 2 * 3600000,
  }))
  .record(operationsJournal, event => ({
    text: `When scheduling the ${event.unit.attributes.database} backup on ${event.unit.attributes.host}, allow more than two hours, because the run for ${event.unit.attributes.night} took ${Math.round((event.attempt?.durationMs ?? 0) / 60000)} minutes.`,
    when: { kinds: [Backup], resources: [event.unit.attributes.database] },
    status: 'active',
  }));

const opsScheduler = H.scheduler('ops-scheduler')
  .priority(incidentLane, heartbeatLane, renewalLane, backupLane)
  .admit(backupLane, ctx => ctx.open(incidentLane) === 0);

const controlApi = http.controlApi('ops-control', {
  port: H.slot.port(1),
  token: H.env('OPS_CONTROL_TOKEN'),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.blockersResolve, H.ops.memoryRead, H.ops.telemetryRead],
});

export const operations = H.harness('operations')
  .ledger(sqlite.ledger({ path: '.harness/ops-ledger.db' }))
  .lanes(incidentLane, heartbeatLane, backupLane, renewalLane)
  .journals(operationsJournal)
  .triggers(repeatedHeartbeatFailures, failedBackup, slowBackup)
  .scheduler(opsScheduler)
  .clients(controlApi)
  .observers(
    slack.notifier('incident-notifier', { webhookUrl: H.env('OPS_SLACK_WEBHOOK'), lanes: [incidentLane] }),
    markdown.board({ path: 'BOARD.md' }),
  );
