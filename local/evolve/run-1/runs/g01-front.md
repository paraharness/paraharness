# Generation 1 front

- g01-durable-able-0-2 (durable, merge): bt 2.7786, compile errors 0, escapes 0, any-in-dts 0, surface 331, coverage 10/10, cannot: none, strikes: none
- g01-durable-able-1-2 (durable, inference): bt -0.455, compile errors 0, escapes 0, any-in-dts 0, surface 252, coverage 10/10, cannot: none, strikes: none
- g01-minimal-imal-0-2 (minimal, surface-cut): bt -1.2362, compile errors 0, escapes 0, any-in-dts 0, surface 188, coverage 10/10, cannot: none, strikes: none
- g00-minimal-0 (minimal, materialize): bt -7.7527, compile errors 0, escapes 0, any-in-dts 0, surface 175, coverage 8/10, cannot: none, strikes: none

## Critiques

### g01-durable-able-0-2

# Adversary report: g01-durable-able-0-2

## 1. Worst-handled scenario: 2, support triage

- **A rejection lies about the unit.** The lane maps `exits: { rejected: New, sent: Sent }`. A rejected draft returns to `New`, which is `pending`. The scheduler restarts it at once from `classify`, with the same message and none of the reviewer's notes. The reviewer's "no" becomes an unbounded redraft loop. It never reaches a terminal state, so it never counts against approval in `outcomes`.
- **The ceiling halt has no shape.** `.ceiling({ maxUsd: 0.4, onExceed: 'halt' })` names no `ask` and no decision schema, and gives no step name to resume at. The human cannot be told what they are deciding. The flow cannot branch on the decision.
- **Escalation's cause is guessed after the fact.** `escalatedOpensEscalation` computes `reason` from `slaDueAtMs <= e.at.getTime()`. Both `onAttemptFailed(Escalated)` and `slaBreached` land in the same state, so the trigger cannot know why. A timer-driven `enter` and a failure that happens past the SLA are indistinguishable.
- **"Human-only" is not enforced.** The `escalations` lane is supplied by `H.operator`, but nothing stops a model step being added to it. The only thing that keeps it human is that no model step happens to appear.

## 2. New scenario: two signatures

> A contract unit, Contract, is supplied by the operator over HTTP. Its flow halts twice: `legalReview`, resolved only by the legal team's dashboard (plain HTTP client), then `financeSignoff`, resolved only by the CFO's Claude Code supervisor.
>
> - Neither client may resolve the other's halt.
> - Both clients may read all work.
> - A third client, an auditor, may read decisions but resolve nothing.
> - Metrics must report median time-to-decision per halt and per client, with sample counts.

**Why this variant cannot express it:**

- `H.ops.blockersResolve` is one `Grant` with no lane, step or halt scope. Both clients either hold it and can sign each other's halts, or lack it and cannot sign at all.
- Expressing it needs a raw-string convention inside the decision schema plus a runtime check in an exit predicate, which is an escape hatch.
- `decisionRecorded.by` exists on the ledger, but no `Metrics` method or `StepEvent` field exposes it. Per-client timing has no way to be computed.

## 3. Sharpest critiques

1. **Model-to-pool routing is hidden coupling through raw strings.** Rule 12 says "the engine serves a model from the first registered pool whose accounts' `family` the model's driver accepts".
   - `Account.family: string` and `Model.families: readonly string[]` form an undeclared relationship.
   - It depends on registration order: in scenario 10, `.pools(subscriptionPool, apiPool)` decides which pool serves `reviewModel` only by position in that call.
   - This is a pivot without a noun (principle 9). Principle 10 is dodged by moving the relationship into a string match instead of into a named entity.
2. **Success is defined by attempts in one file and by verdicts in another.** Principle 18 says success comes from the kind's terminal states.
   - Scenario 1's `builderModel` reads `ctx.metrics.attempts({ of: ctx.kind, model: sonnet, ... })`. That is the attempt outcome, which is succeeded when the flow reaches *any* exit, including `exhausted`.
   - Scenario 7's copy of the same policy reads `ctx.metrics.outcomes(...)`.
   - The same requirement is written two ways, and the scenario 1 version counts "flow finished" as success.
   - `AttemptOutcome` 'succeeded' meaning "reached an exit" is exactly the lie principle 18 forbids.
3. **The step-to-state map duplicates the lifecycle.**
   - **One step, several states.** `HandlerMap.during` lets `AwaitingApproval` sit at position `active` while the attempt is `blocked` and holds nothing. Scenarios 2, 5 and 10 all do this, so the board shows active work that consumes no capacity.
   - **Several steps, one state.** Scenario 5 maps `validationReview` and `summarize` both to `Validating`. The state vocabulary goes stale whenever a flow changes.

   Two further problems:
   - **Two words for one thing.** "Halt" and "blocked" name one phenomenon. "Suspended" (await, wait, spawn) and the unit position `waiting` describe overlapping things.
   - **A stranger must learn three axes.** Position, attempt status and wait reason are separate, and two of them can contradict each other.

### g01-durable-able-1-2

## 1. Worst-handled scenario: 2 (support triage)

As written, scenario 2 fails the variant's own startup validation.

- **It cannot start.** `const Drafting = H.state('Drafting', 'active')` and `const AwaitingApproval = H.state('AwaitingApproval', 'active')` are both on `Conversation`. design.md says: "A kind declares at most one state with position `active`… A second active state is a startup error." So `start()` refuses the harness.
- **The fix exposes a deeper problem.** The `mark('drafting')` and `mark('awaitingApproval')` labels map to states inside `handler.states`. That mixes progress markers and outcomes in one map. "Awaiting approval" is really a *blocked attempt*, yet it is modelled as a unit state.
- **The "full inference" goal breaks here.** The webhook mapper needs `type ConversationSupply = Supply<NonNullable<typeof Conversation.types>['attributes'], …>` and the annotation `(e): ConversationSupply | null`. design.md's stated goal is that no scenario needs a type annotation, and this is one.
- **The poll can resurrect closed conversations.** Dedupe applies only to "an open (non-terminal) unit". Every 10 minutes `zendesk.poll` emits `{ create }` for every ticket. A ticket already `Sent` or `ClosedByCustomer` therefore gets a fresh unit. Nothing in the surface prevents this.
- **The safe-category rule is approximated.** It reads `window: { days: 365 }`, which is not "200 approved samples, zero rejections" ever. A rejection 366 days ago is forgotten.
- **Rejection loops.** `rejected: Classifying` sends a rejected draft back through classify and draft. Nothing bounds this except the $0.40 budget halt.

## 2. New scenario: "the tracker is the truth"

```
# Scenario 11: tracker-owned lifecycle

Bugs live in Linear; the harness is not the source of truth (as in scenario 1).

## Must express
- A human moves a Bug to "Canceled" in Linear while the builder is mid-attempt:
  the attempt is cancelled within one poll interval and the unit becomes Abandoned.
- A human moves a Done Bug back to "Todo" (regression): the same unit (same key,
  same history) re-enters pending; no new unit is created.
- A human edits the issue description while the bug is pending: the next attempt
  sees the new description; the running attempt does not.
- The board shows which transitions came from the tracker versus from the harness.

## Hostile aspects
- A store whose state changes underneath the harness.
- A supplier that updates rather than creates, on a vendor adapter.
- Field changes that must not leak into a running attempt.
```

The variant cannot express this for three reasons:

- `linear.issues(..., map: (issue) => NoInfer<Create<A, F>>)` can only *create*. Unlike `zendesk.webhook`, it cannot emit `{ key, event, payload }`.
- `Store` has `create`, `load`, `save` and `transition`, but no watch or diff. The harness writes state into the tracker and never reads it back.
- `.reacts` needs kind-declared events. `Bug` has none, and no adapter would emit them.

Scenario 1's claim that "state is kept in the tracker" is therefore one-way mirroring, not truth-keeping.

## 3. Sharpest critiques

1. **`Quota` is a second kernel store wearing the ledger's name.**
   - `sqlite.ledger('.harness/product.sqlite', { accounts: sqlite.accounts('~/.harness-shared/accounts.sqlite') })` places account state in a different file, shared across two harnesses, outside the writer lease (`append(lease, …)` does not cover `Quota.consume`).
   - Calling it "a partition of the ledger" does not make it one. Principle 15 ("the ledger is the kernel's only state") is broken in substance and declared "none" in design notes.
   - Shares also live on the `Pool`, so `setShares` mutates a descriptor-declared value. That conflicts with principle 11.

2. **Raw strings stand in for entities, with two idioms for one test.**
   - Scenario 1 schedules on `x.entry.lane === heartbeatLane.name`, while scenarios 7–10 use `x.is(bugs)`.
   - Policies build fake entities: `kind: { name: c.unit.kind }`, `agent: 'builder'` (`MetricQuery.agent?: Named | string`), `c.unit.attributes['category'] ?? ''`.
   - `GateContext.unit` is typed, but `PolicyContext.unit` is untyped, so model policies lose the kind.
   - This violates principles 19, 20 and 22.

3. **Halt, block, wait and suspend are four words for overlapping things (principle 22).**
   - `BlockView.reason` includes `'decision'`, while `WaitView.on` includes `'human'`.
   - `AttemptStatus` has `blocked` and `suspended`, and the unit position is `waiting`.
   - A Tenancy's `Suspended` state is a unit state named after an attempt status.
   - `Harness.start()` and `Harness.control()` both return `Running`. The only difference is a `scheduling: boolean` flag, a hidden mode switch rather than a named pivot.
   - The `reaction` pivot cancels open attempts implicitly. That one side effect is the only external-cancellation mechanism, and nothing in its name says "cancels".

### g01-minimal-imal-0-2

## 1. Worst-handled scenario: 4 (operations)

`design.md` cut `Command.on(fn)` because it "put runner names in kind data (critique b)". Scenario 4 then does exactly that, by hand:

```ts
const host = z.enum(['db-1', 'db-2']);
const Backup = H.kind('backup').data(z.object({ database: z.string(), host }))
```

- **Principle 10 broken.** The work kind now knows which runner handles it.
- **One-use descriptors.** The workaround is three factories (`backupOn`, `certificateCheckOn`, `certificateRenewOn`) minting six renamed descriptors (`backup-on-db-1`, …).
- **Hidden routing.** The flow selects a descriptor by indexing with domain data: `backupCommands[ctx.unit.data.host]`.
- **Placement lives in the wrong layer.** Nothing in the lane or runner says "Backups run on these SSH hosts, one at a time each". Placement is in the schema and the flow.

Other workarounds in the same file:

- **Incident preemption is fudged.** The scheduler preempts heartbeats (`view.active.filter(a => a.lane === heartbeats.name && !a.blocked)`) to simulate "Incidents preempt everything". Heartbeats run on `local` and Incidents on `local`, so this frees no slot that an Incident actually lacks.
- **The unresolved Incident loops.** It returns `'open'`, which is pending, so the flow re-pages on-call from the top. That is an accidental retry, not the specified "halt, runbook, halt".
- **The Slack observer filters by raw string:** `entry.kind === Incident.name`.

## 2. New scenario: legal clause review, owner-authored recall

A law firm reviews contract clauses.

- **Kind:** Clause, supplied from a document-management poll and stored there.
- **Agents:** a drafter and a checker.
- **Memory:** precedent experience (vector store) and partner taste (JSONL).

Must express:

- The **drafter's recall policy**, written by the owner:
  - Exclude experience items whose track record is below 0.5 with at least 10 samples.
  - Decay items older than 180 days by half.
  - Return at most 5 items, with taste items always first.
- The **checker's recall policy** is different: precedent only, no decay, at most 12 items.
- Both policies read `metrics` at decision time. Each recall decision is a recorded `decision` entry, with the samples of every item it excluded.
- A **metric on halt latency**: the median time from a partner halt being raised to being resolved, per partner, with sample counts. The scheduler reads it to route clauses to faster partners.

Hostile aspects:

- `H.policy.recall` and `Library.recall` were cut. Recall is "the kernel's deterministic ranking", which is fixed.
- Two agents sharing one library cannot rank differently. `RunOptions.scope` only narrows scope; it cannot exclude, decay or cap.
- `Measure` is only `'costUsd' | 'durationMs'`. Halt-resolution latency is not measurable without the author smuggling a duration into tags.

This violates principle 14 as written ("Recall is a deterministic policy"). The variant must either lie (pretend kernel ranking is the owner's policy) or escape (pre-filter in the role's `prompt`, which reads no memory).

## 3. Sharpest critiques

**a. Halts, decisions and tags are raw strings that stand in for entities.** Metrics depend on untyped names that the type system never checks:

- `{ entry: 'halt', halt: 'approve-reply', decision: { approved: true } }`
- `byTag: 'model'`
- `trigger: auditTrigger` (a `const` string)
- `choice.agent === 'reviewer-a'` in scenario 6's `reviewerLineup`

A typo yields `samples: 0`, and every policy silently falls back to its default.

- Principle 18's "honest metrics" become fragile.
- Principle 10 is bent: a model policy knows agent names.

A halt should be a named entity, declared once and referenced by both `ctx.halt` and `EntryFilter`.

**b. `on.metric` is grouped-only, so lane-level thresholds fake a group.** In scenario 9:

```ts
const modelErrorRate = (metrics: Metrics) => ({ [conversationsLane]: metrics.rate(...) });
```

- A lane name becomes a fake group key, so the "group" tag on the firing entry is a lie about its source.
- `conversationsLane` itself is a raw string declared before the lane exists, coupling the trigger to the lane by text.

**c. Multi-attempt re-entry is resumption code by another name, and `failures` invites more.** These are flow-written branches on unit history:

- `if (ctx.unit.state === 'smoked')` in scenario 10
- `if (children.length > 0)` in scenario 7
- `if (ctx.unit.failures >= 3) return 'abandoned'` in scenario 3

Scenario 10 forbids "if already done" branches. Calling it "lifecycle" does not change that the author hand-writes phase dispatch at the top of every multi-attempt flow.

Two related inconsistencies:

- **Same domain, contradictory lifecycles.** Scenario 2 makes `sent` `terminal/success` and `escalated` `failure`. Scenario 9, the same support harness, makes `sent` `waiting` and `escalated` `neutral`.
- **One concept, two names.** Recovery appears as `.recovery(...)` on commands and as `Executable.recover` / `Model.recover` elsewhere, against principle 22.

### g00-minimal-0

## 1. Worst-handled scenario: 8 (lifecycles that do not fit)

Scenario 8 forbids lies. This variant tells several.

**Negotiation maps failure onto a state that means something else.**
- `if (!proposal.ok) return 'vendor-replied';` and `if (!sent.ok) return 'vendor-replied';`
- A model or mail failure is recorded as "the vendor replied." This is a `pending`-mapped state, so the unit loops forever with no failure counted.
- The ledger transition says `cause: 'flow'`, `to: 'vendor-replied'`. Metrics on rounds-per-negotiation are now wrong.

**Tenancy suspension races the wake condition.**
- `ctx.until('current', { at: +30d, then: 'review-due' })` arms a wake.
- The billing webhook then moves the unit to `suspended`. Rule 5 and Rule 7 never say whether a supplier move clears `wakeAt`.
- A suspended tenancy may wake into `review-due` on day 30 and be reviewed while suspended.

**Experiment silently swallows measurement failures.**
- `sample.ok ? [...] : ctx.unit.data.observations` drops a failed hourly sample with no record.
- The experiment can end `inconclusive` from missing data, and nothing distinguishes that from a genuine tie.

**The same pattern recurs in scenario 2.**
- `if (!classified.ok) return 'escalated';` reaches an `ended` state named "escalated", but no Escalation unit is created.
- `escalated` therefore has two meanings: a real SLA escalation, and "the classifier crashed."

## 2. New scenario: canary rollout

*Scenario 9: canary rollout*

A `Deploy` kind is supplied by a webhook from CI and handled by deterministic commands only.

**Must express**
- Rollout runs as 5% → 25% → 100%. Each stage waits 20 minutes, then reads the error rate from a probe command.
- If the error rate of `Deploy` invocations tagged `stage=canary` exceeds 0.02 over the last hour, with at least 30 samples, a trigger:
  - creates a `Rollback` unit in another lane;
  - pauses all pending `Deploy` units.
- The probe command hangs in practice. Any invocation exceeding 10 minutes is killed, counted as failed, and the runner slot is freed.
- A deploy for service X must not start while a `Rollback` for X is active, keyed by service, not by kind.

**Hostile aspects**
- **A trigger whose source is a metric threshold.** `H.on` offers only `enters | streak | deadline | clock`.
  - The only workaround is a schedule policy that filters `start`. That policy cannot create the `Rollback` unit, because policies return orderings and not effects.
  - Faking it with `clock` plus a flow that polls metrics means a flow reading `Metrics`, which `FlowContext` does not expose. Metrics are only reachable through `ctx.decide`, a misuse of the rule policy.
- **A per-invocation timeout.** The design notes list "`timeout`: removed." A hung probe therefore holds its runner slot indefinitely, and nothing in `RunOptions` can bound it.
- **Exclusion keyed by a resource, not a kind.** There is no resource entity ("strings in scopes and leases"). The policy must compare `unit.data.service` strings across kinds by hand.

## 3. Three sharpest critiques

**a. "schedule" names three different things, breaking principle 22.**
- `H.schedule(...)` is a supplier.
- `H.policy.schedule(...)` is the scheduler.
- `.scheduler(policy)` is the harness setting.
- `H.on.clock(..., { daily })` and `TimeSpec` are a fourth time-based mechanism.

A newcomer reading `H.schedule('two-am', ...)` and `H.policy.schedule('daily-budget', ...)` side by side cannot tell which one decides what runs next. Separately, `ctx.halt` and `ModelResponse { status: 'asked' }` with `Intent 'ask'` are two mechanisms for one concept. Scenario 1's builder works around this with an output field `question`.

**b. Kind data carries runner identity, breaking principles 8 and 10.**
- In scenario 4, `databases = [{ database: 'orders', host: hostA.name }]` puts the backup's host into the kind's data.
- `hostFor = input => input.host === hostA.name ? hostA : hostB` then resolves runners by string comparison.
- The kind `Backup` (vocabulary) now knows an instance's name. A typo silently routes to `hostB`, and startup validation (Rule 15) cannot catch it.
- The same raw-string-for-entity pattern appears in `resources: ['section:sports']` and `'payments'`. This is exactly the seed's W4, left unfixed and listed as "cut."

**c. `Ledger extends QuotaBook` conflates two owners of state, bending principle 15.**
- Rule 11 says quota lives "by default" in the ledger and otherwise in `sqlite.quota(path)`. So the ledger is both the kernel's only state and, sometimes, not the home of quota.
- Accounts select their book through a vendor-subpath option: `claudeCode.subscription(..., { quota })`.
- Nothing stops one account from being declared with a shared book in harness A and the default ledger book in harness B. That silently reintroduces scenario 7's double-counting.
- Because `QuotaBook` is an interface the ledger implements rather than a named pivot, principle 9 is also strained. The design never says what account state is part of.
