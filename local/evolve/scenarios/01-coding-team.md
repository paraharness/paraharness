# Scenario 1: coding team

A product team's harness, the shape harness-dsl was first built for.

## Must express

- Three kinds of work in a hierarchy: Epic decomposes into Features; Bugs arrive on their own. Epic completes when its Features do. Feature and Bug share most of their lifecycle and handler but differ in how many build-and-audit rounds they get (Bug 3, Feature 5).
- Supply from three places at once for Bugs: an issue tracker (Linear), a folder of markdown files, and the operator typing to the supervisor. Features from the tracker and the operator. Epics from the tracker only.
- Bug and Feature state is kept in the tracker; the harness is not the source of truth for them.
- A builder agent on a worktree per attempt, with a file-lease guard (two attempts may not write the same file) and a stop check that runs the project's checks before the agent may stop.
- An auditor agent that finds deficits; the loop continues until none remain or rounds run out. The builder may halt the attempt for an owner decision.
- Accounts: three Claude subscriptions in a pool with per-account quota shares, drained soonest-expiring first, falling back to an API account. Model choice for the builder reads the ledger: use the cheaper model until its success rate on this kind of work, over 14 days and at least 20 samples, drops below 0.85.
- Memory: experience ("when touching payments, run the ledger fixture first, because the migration reorders rows") recalled by builder and auditor, recorded by the auditor; taste ("prefer early returns over nested conditionals") recalled by builder and planner, written by the owner.
- A service heartbeat every five minutes, all deterministic, whose failure creates a Bug through a trigger. The heartbeat flow must not reference the Bug kind.
- Scheduler: heartbeats first, then bugs, features, epics; a WIP limit of 2 concurrent bugs and 1 epic; starvation protection for features.
- Supervisor: a Claude Code session granted read and write on work, blocker resolution, memory writes, telemetry and account shares, plus one custom operation (a production health probe).
- Board and telemetry projections written as Markdown files.

## Hostile aspects

- The heartbeat kind must have no store and must still appear in telemetry.
- The same handler flow serves two kinds with different round counts without duplication.
- The model-choice policy must expose sample counts; a variant that hides them fails.
