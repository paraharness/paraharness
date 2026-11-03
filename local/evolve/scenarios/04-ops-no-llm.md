# Scenario 4: operations, no model anywhere

A platform team uses the harness purely as a durable scheduler of deterministic work. There is no model, no account, no agent in this harness. If a variant needs any of them to compile or start, it fails the scenario.

## Must express

- Kinds: Heartbeat (every 5 minutes per service), Backup (nightly per database), CertificateRenewal (weekly check, act when under 14 days), Incident (created by triggers, handled by a runbook flow that pages a human and waits).
- Suppliers: schedules only, plus the operator creating Incidents by hand through the control API over plain HTTP (no Claude Code, no MCP).
- Runners: local for heartbeats; SSH to two hosts for backups and renewals, with per-host concurrency of 1 and a disk-space preflight.
- Triggers: three consecutive failed heartbeats of one service create an Incident (a trigger over a pattern of transitions, not a single transition). A failed Backup creates an Incident at once. A Backup that succeeded but took over 2 hours records a note in a journal of operational experience, which is also a memory kind, even though nothing here reads memory into a prompt; the supervisor reads it.
- The Incident flow halts for a human acknowledgement, then runs a runbook command, then halts for a human to confirm resolution.
- Scheduler: Incidents preempt everything; a running Backup is not interrupted, but no new Backup starts while an Incident is active.
- Observers: a Slack notification on every Incident transition, and the board file.

## Hostile aspects

- Zero model calls: every executable is a command.
- A trigger whose source is a pattern across several transitions.
- Preemption rules in the scheduler.
- A control API client that is plain HTTP.
- A memory kind with no agent reading it.
