import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { local } from 'harness-dsl/local';
import { ssh } from 'harness-dsl/ssh';
import { http } from 'harness-dsl/http';
import { slack } from 'harness-dsl/slack';
import { markdown } from 'harness-dsl/markdown';

const heartbeatAttrs = z.object({ service: z.string(), at: z.string() });
const backupAttrs = z.object({ database: z.string(), host: z.enum(['db-1', 'db-2']), night: z.string() });
const renewalAttrs = z.object({ domain: z.string(), host: z.enum(['db-1', 'db-2']), week: z.string() });
const incidentAttrs = z.object({ ref: z.string(), title: z.string(), source: z.string() });

const due = H.state('Due', 'pending');
const probing = H.state('Probing', 'active');
const healthy = H.terminal('Healthy', 'success');
const down = H.terminal('Down', 'failure');

const scheduled = H.state('Scheduled', 'pending');
const dumping = H.state('Dumping', 'active');
const backedUp = H.terminal('BackedUp', 'success');
const backupFailed = H.terminal('BackupFailed', 'failure');

const checkDue = H.state('CheckDue', 'pending');
const checking = H.state('Checking', 'active');
const fresh = H.terminal('Fresh', 'success');
const renewed = H.terminal('Renewed', 'success');
const renewalFailed = H.terminal('RenewalFailed', 'failure');

const open = H.state('Open', 'pending');
const awaitingAck = H.state('AwaitingAck', 'waiting');
const remediating = H.state('Remediating', 'active');
const awaitingConfirmation = H.state('AwaitingConfirmation', 'waiting');
const resolved = H.terminal('Resolved', 'success');
const abandoned = H.terminal('Abandoned', 'failure');

const heartbeat = H.kind('Heartbeat')
  .attributes(heartbeatAttrs)
  .states(due, probing, healthy, down)
  .key(a => `${a.service}@${a.at}`)
  .initial(due);

const backup = H.kind('Backup')
  .attributes(backupAttrs)
  .states(scheduled, dumping, backedUp, backupFailed)
  .key(a => `${a.database}@${a.night}`)
  .initial(scheduled);

const renewal = H.kind('CertificateRenewal')
  .attributes(renewalAttrs)
  .states(checkDue, checking, fresh, renewed, renewalFailed)
  .key(a => `${a.domain}@${a.week}`)
  .initial(checkDue);

const incident = H.kind('Incident')
  .attributes(incidentAttrs)
  .states(open, awaitingAck, remediating, awaitingConfirmation, resolved, abandoned)
  .key(a => a.ref)
  .initial(open);

const acknowledgement = H.halt('incident-acknowledged').decision(z.object({ by: z.string() }));
const resolutionConfirmed = H.halt('incident-resolution-confirmed').decision(z.object({ resolved: z.boolean(), note: z.string() }));

const localRunner = local.runner('local');

const diskSpace = H.command('disk-space-preflight').argv(['sh', '-c', 'test "$(df --output=avail /var/backups | tail -1)" -gt 52428800']);

const dbHost1 = ssh.host('db-1', { host: 'db-1.internal', user: 'ops', key: H.env('OPS_SSH_KEY') }).slots(1).preflight(diskSpace);
const dbHost2 = ssh.host('db-2', { host: 'db-2.internal', user: 'ops', key: H.env('OPS_SSH_KEY') }).slots(1).preflight(diskSpace);
const onHost = (host: 'db-1' | 'db-2') => (host === 'db-1' ? dbHost1 : dbHost2);

const probe = H.command('probe-service')
  .input(heartbeatAttrs)
  .argv(i => ['./bin/probe', i.service])
  .runner(localRunner)
  .acceptExitCodes(0, 1);

const dump = H.command('backup-database')
  .input(backupAttrs)
  .argv(i => ['/usr/local/bin/backup', i.database, i.night])
  .runner(i => onHost(i.host));

const checkCertificate = H.command('check-certificate')
  .input(renewalAttrs)
  .argv(i => ['/usr/local/bin/cert-days-left', i.domain])
  .output(z.object({ daysLeft: z.number() }))
  .runner(i => onHost(i.host));

const renewCertificate = H.command('renew-certificate')
  .input(renewalAttrs)
  .argv(i => ['/usr/local/bin/cert-renew', i.domain])
  .runner(i => onHost(i.host));

const pageOncall = H.command('page-oncall')
  .input(incidentAttrs)
  .argv(i => ['./bin/page', i.ref, i.title])
  .runner(localRunner);

const runbook = H.command('incident-runbook')
  .input(incidentAttrs)
  .argv(i => ['./runbooks/run', i.source, i.ref])
  .runner(localRunner)
  .acceptExitCodes(0, 1, 2);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatAttrs)
  .step('probe', probe, ctx => ctx.unit.attributes)
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('down');

const backupFlow = H.flow('backup').input(backupAttrs).step('dump', dump, ctx => ctx.unit.attributes).exit('backedUp');

const renewalFlow = H.flow('certificate-renewal')
  .input(renewalAttrs)
  .step('check', checkCertificate, ctx => ctx.unit.attributes)
  .exit('fresh', ctx => ctx.steps.check.daysLeft >= 14)
  .step('renew', renewCertificate, ctx => ctx.unit.attributes)
  .exit('renewed');

const incidentFlow = H.flow('incident')
  .input(incidentAttrs)
  .step('page', pageOncall, ctx => ctx.unit.attributes)
  .halt('acknowledge', acknowledgement, { ask: ctx => `Acknowledge incident: ${ctx.unit.attributes.title}` })
  .step('runbook', runbook, ctx => ctx.unit.attributes)
  .halt('confirm', resolutionConfirmed, {
    ask: ctx => `Runbook for ${ctx.unit.attributes.title} exited ${ctx.steps.runbook.exitCode}:\n${ctx.steps.runbook.stdout}\nIs the incident resolved?`,
  })
  .exit('resolved', ctx => ctx.steps.confirm.resolved)
  .exit('unresolved');

const services = ['api', 'web', 'worker'];

const heartbeats = H.lane('heartbeats', heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    services.map(service => to.create({ service, at: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, { exits: { healthy, down }, during: { probe: probing } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: down });

const backups = H.lane('backups', backup)
  .supply(H.clock('nightly').at('01:00', { tz: 'UTC' }), (tick, to) => {
    const night = tick.at.toISOString().slice(0, 10);
    return [to.create({ database: 'orders', host: 'db-1', night }), to.create({ database: 'users', host: 'db-2', night })];
  })
  .handler(backupFlow, { exits: { backedUp }, during: { dump: dumping } })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: backupFailed });

const renewals = H.lane('certificate-renewals', renewal)
  .supply(H.clock('weekly').at('04:00', { on: 'mon', tz: 'UTC' }), (tick, to) => {
    const week = tick.at.toISOString().slice(0, 10);
    return [
      to.create({ domain: 'example.com', host: 'db-1', week }),
      to.create({ domain: 'api.example.com', host: 'db-2', week }),
    ];
  })
  .handler(renewalFlow, { exits: { fresh, renewed }, during: { check: checking, renew: checking } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 3600000, exhausted: renewalFailed });

const incidents = H.lane('incidents', incident)
  .supply(H.operator)
  .handler(incidentFlow, {
    exits: { resolved, unresolved: open },
    during: { page: remediating, acknowledge: awaitingAck, runbook: remediating, confirm: awaitingConfirmation },
  })
  .retry({ maxAttempts: 3, backoff: 'fixed', initialDelayMs: 60000, exhausted: abandoned });

const operationsNotes = H.journal('operations-notes', H.memory('operational-experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/operations.jsonl' }))
  .recall({ by: 'specificity', limit: 20 });

const threeDownHeartbeats = H.trigger('three-down-heartbeats-open-incident')
  .on(H.when.pattern(heartbeats, { to: down, consecutive: 3, per: u => u.attributes.service }))
  .create(incidents, e => ({
    ref: `heartbeat:${e.group}`,
    title: `${e.group} failed ${e.streak} consecutive heartbeats`,
    source: 'heartbeat',
  }));

const failedBackup = H.trigger('failed-backup-opens-incident')
  .on(H.when.transition(backups, { to: backupFailed }))
  .create(incidents, e => ({
    ref: `backup:${e.unit.key}`,
    title: `Backup of ${e.unit.attributes.database} failed on ${e.unit.attributes.night}`,
    source: 'backup',
  }));

const slowBackup = H.trigger('slow-backup-notes-experience')
  .on(H.when.transition(backups, { to: backedUp, if: e => (e.attempt?.durationMs ?? 0) > 7200000 }))
  .record(operationsNotes, e => ({
    text: `When scheduling the ${e.unit.attributes.database} backup, start it earlier or split it, because the ${e.unit.attributes.night} run took ${((e.attempt?.durationMs ?? 0) / 3600000).toFixed(1)} hours`,
    when: { kinds: [backup] },
  }));

const scheduler = H.scheduler('operations')
  .priority(incidents, heartbeats, renewals, backups)
  .admit(backups, ctx => ctx.count(incidents, 'pending', 'active', 'waiting') === 0);

export const operations = H.harness('operations')
  .ledger(sqlite.ledger({ path: '/var/lib/harness/operations.db' }))
  .lanes(incidents, heartbeats, renewals, backups)
  .journals(operationsNotes)
  .triggers(threeDownHeartbeats, failedBackup, slowBackup)
  .scheduler(scheduler)
  .clients(
    http.controlApi('operations-api', {
      port: H.slot.port(0),
      token: H.env('OPS_API_TOKEN'),
      grants: [
        H.ops.workRead,
        H.ops.workCreate,
        H.ops.resolve(acknowledgement),
        H.ops.resolve(resolutionConfirmed),
        H.ops.attemptsRecover,
        H.ops.memoryRead,
        H.ops.telemetryRead,
      ],
    }),
  )
  .observers(
    slack.notifier('incident-feed', { webhookUrl: H.env('SLACK_INCIDENT_WEBHOOK'), lanes: [incidents] }),
    markdown.board({ path: '/var/lib/harness/BOARD.md' }),
  );

void operations.start();
