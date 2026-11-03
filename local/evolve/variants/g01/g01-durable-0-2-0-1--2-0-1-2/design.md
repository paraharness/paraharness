# harness-dsl, Kanban lens on the execution model (child of g00-durable-0-2-0-1)

The parent treated a unit as a durable execution with replay. This child keeps that engine: one ledger, replay at zero cost, per-step crash rules and collected jobs. It redraws the execution model the way a Kanban board draws work.

- **Lanes are swimlanes.** A lane holds one kind of work, with its suppliers, its store and its handler.
- **Named states are columns outside the flow.** These are the backlog and ready columns (pending), the parking columns (waiting) and the done columns (terminal).
- **In-flight columns are the flow's steps.** While an attempt is open, the card sits in the column of its current step, read from the ledger.
- **The scheduler pulls.** It pulls a card from a pending column into the flow when WIP, capacity and the card's class of service allow it.
- **A blocked card is still on the board.** It carries a blocker (a halt, a timer, a job or children) and holds no capacity.

The owner's vocabulary is kept: unit, attempt, step, invocation, lane, state, position. The Kanban words adopted are **class of service**, **expedite**, **WIP** and **pull**, because each is better than what it replaces:
- class of service replaces `priority`, `rank` and `boost`;
- expedite replaces an ad-hoc preemption gate.

"Column" is a board rendering only, not an entity.

## Execution vocabulary (one definition each)

- **Unit**: one card.
  - It has a stable id and a `key` (from `Kind.key`).
  - At most one non-terminal unit per lane holds a key.
  - It outlives its attempts.
- **Attempt**: one pull of a unit through the lane's flow.
  - It ends with exactly one outcome: `succeeded`, `failed` or `cancelled`.
  - While open it is either *running* (unit position `active`, holding WIP, slots, leases and account reservations) or *blocked* (unit position `waiting`, holding nothing).
  - A blocked attempt records its blocker: `decision`, `timer`, `children`, `job` or `recovery`.
- **Step**: a named column of a flow. The step name is the address used by reactions, triggers, metrics and halts. `loop` and `exit` are structure, not columns.
- **Invocation**: one call of an executable within a step. A step retry and each job poll are new invocations.

"Run" is not used.

## Lifecycle (principle 12, as it stands now)

- **States.**
  - `H.state(name, 'pending' | 'waiting')` declares a non-terminal state.
  - `H.terminal(name, verdict)` declares a terminal state. The verdict has no default.
- **No active states.** A kind cannot declare an `active` state. Where an active unit stands is its attempt's current step.
  - The parent's `during` map, which mapped steps to states, is deleted.
  - Waiting on a human is recorded once, as the attempt's blocked state, and nowhere in the kind.
- **What a kind declares:** attributes, states, `key` and `initial` (a pending state). Nothing about failure, cancellation, suppliers, stores or handlers.
- **What the unit view carries:**
  - `UnitView.state` is the last named state.
  - `UnitView.position` is derived. It is the state's position when no attempt is open. Otherwise it is `active` (running) or `waiting` (blocked).
- **Where an ending attempt leaves the unit:**
  - **Exit.** The lane's `exits` map sends the exit to any state of the kind: pending (pull again), waiting (park) or terminal.
  - **Failure.** The unit returns to pending under the lane's `retry`. When `maxAttempts` attempts have failed, it moves to `retry.exhausted`. A lane without `retry` is a startup error, so no lane loops forever.
  - **Cancellation by reaction.** An `enter` reaction cancels the open attempt and moves the unit to the named state. `H.cancel` is a signal like any other; a lane that can receive it must react to it.

## Board and pull (the Kanban core)

**Classes of service** are declared on the scheduler. Each lane is in exactly one class.

| Class | Behaviour |
|---|---|
| `expedite(lane, { holds })` | Pulled first, ignoring WIP limits. While any unit of the lane is open, no new attempt starts in the `holds` lanes. Running attempts finish. |
| `fixedDate(lane, due)` | Pulled in order of `due(unit)`, soonest first. This is ordering by time to breach. |
| `standard(...lanes)` | Pulled in the listed lane order, first in first out within a lane. `aging(lane, { afterMinutes })` raises a starved card to the head of the standard class. |

Each hold and each release is recorded as `expediteHold`, with the lane that caused it. The board shows it.

**WIP and admission.**
- `wip(lanes, max)` counts running attempts across one lane or a group of lanes. Scenario 11 sets WIP 3 across `contracts-eu` and `contracts-us`.
- Waiting cards never count.
- `admit(lane, gate)` is the explicit pull policy for budgets.
- `AdmitCtx.count(lanes, ...positions)` counts cards at positions.

**Stopping the line.** `pause` and `resume` triggers, and the `lanesPause` operation, stop pulls in a lane. Running attempts finish. Both are ledger events carrying the reason.

**Board columns.** An observer renders, per lane: pending states, then one column per flow step (split into running and blocked), then waiting states, then terminal states. A blocked card shows its halt name and the time since its block.

## Re-entry, external events, time

### Signals and reactions

A supplier route `create`s a unit or `signal`s one by key. A signal to a key with no open unit is recorded as `signalSkipped`.

`Lane.on(signal, { update, restart, enter, at })` declares the lane's reaction:
- **`update`** always applies, and is recorded in `signalDelivered.applied`.
- **`restart: step`** cancels the open attempt (outcome `cancelled`, never a failure) and pulls a new attempt that starts at that step. Completed outputs from earlier steps are replayed.
- **`enter: state`** cancels the open attempt and moves the card to the state.
- **`at: [steps]`** gates `restart` and `enter`. They apply only when the open attempt sits at one of those steps; otherwise only `update` applies, recorded with `gatedAtStep`. All step names are typed from the flow.
  - The supplier and the trigger no longer compare `attempt.step` with a string. This repairs the parent's hidden coupling (critique 1, third bullet).
  - Scenario 11: a redline during `draft` updates the attributes, so the next round reads it. A redline at `counsel` restarts at `draft`.
  - Scenario 5: the 09:00 timer's signal reacts with `{ at: ['approval'], enter: Expired }`.

### Multi-attempt units (known weakness 7)

There is no loopback pivot. A unit re-enters by being in a pending column again:
- an exit that maps to a pending state;
- a reaction that `enter`s a pending state (Tenancy `ReviewDue`, Negotiation `OurMove`).

Each pull is a fresh attempt from the top or from a `restart` step. The flow reads only its own step outputs and attributes.

### Time

- **Timer triggers.** `H.when.timer(lane, { at })` arms a timer at creation and re-arms it after every `attributesUpdated`. The old deadline is cleared (`timerCleared: rearmed`) and never fires.
- **Halt clocks.** `timeout` and `escalate` run from the recorded `attemptBlocked`, never from unit data.
- **Waits.** `wait` blocks the attempt on a timer.

## Halts (single form)

- **Entity.** `H.halt(name).decision(schema)` is the entity: the question.
- **Address.** `flow.halt(step, halt, { ask, skip?, timeout?, escalate?, when?, facets? })` is its address. One halt may be asked at several addresses (known weakness 3).
- **Facets.** An address may declare `facets`: deterministic facet values computed from step outputs at the halt, for example the classifier's category.
  - The kernel records them on `attemptBlocked` and `decisionRecorded`.
  - It hands them to the `skip` policy (`HaltPolicyCtx.facets`) and to decision triggers and metrics (`DecisionEvent.facets`).
  - `DecisionEvent.seats` carries the seat assignments made earlier in the attempt, so a decision metric can key on the seat and model that produced what the human judged.
- **Resolvers** (`decisionRecorded.resolvedBy`):
  - `human`, through a client holding `H.ops.resolve(halt)`;
  - `policy`, through `skip: H.policy.halt(...)`, a registered policy whose recorded decision carries every metric figure it read, with dimensions and samples;
  - `timeout`, which resolves the halt without cancelling the attempt.
- **`when`.**
  - **Flow condition, not a resolver.** It is a deterministic condition on step outputs that decides whether the question is asked at all, for example "validation failed" in scenario 5.
  - **When it is false.** The kernel records `haltNotAsked` and the step's output is `undefined`. The type is `D | undefined`, so the flow must handle it. No fake decision is recorded.
- **Seat-raised halts.** `Seat.halts(...halts)` names the halts a model may raise mid-invocation (scenario 1's owner decision). The driver receives them in `ModelRequest.halts`.
- **Cost ceilings.** `Lane.ceiling({ maxUsd, onExceed: 'fail' | halt })` blocks on a halt entity whose decision is `H.ceilingDecision`.
- **Grants.** Grants name halts. The parent's capability-wide `blockersResolve` is deleted (critique 3).

## Seats (principle 8; known weakness 1)

`H.seat(name).role(role).model(model | modelPolicy)` is the one model-call pivot.

- **Seats and agents.** A seat with a fixed model is what principle 8 calls an agent; the choice policy is constant. There is one builder, so there are not two nouns for one pivot (standard 22). The seat's name is the metric key.
- **Model policy context.** `PolicyCtx` gives the policy the `seat` it is filling.
- **Seat column.**
  - The ledger's `invocation.seat` and `StepEvent.seats[step] = { seat, model }` make `seat` a typed column. A model swap therefore does not break a series keyed on the seat.
  - Scenario 6: two seats share one role, each with its own model policy. The metric is keyed on the seat.
- **Batch.** `Seat.batch()` returns a **Job**.

## Jobs (batch and job unified; known weakness 2)

A job is a descriptor with submit and collect semantics: `H.job(name, { submit, collect, pollEveryMinutes })`, or `seat.batch()` for a model batch API. It runs through `flow.job(step, job, input)`.

- **Capacity.** While the job runs, the attempt is blocked on `job` and holds no WIP and no slot.
- **Restart.** On restart the recorded job id is collected and never resubmitted.
- **Failure.** A `failed` poll fails the attempt.
- **Cost.** Batch invocations record `viaJob: true` with the driver's discounted cost.
- **Removed.** There is no separate batch step or `batch` blocker.

## Metrics and dimensions (principle 18; critique 1)

A sample or amount carries typed dimensions. The kernel adds kind, lane and state from the source event.

| Dimension | Type |
|---|---|
| `seat` | Seat entity |
| `model` | Model instance |
| `resource` | Resource entity |
| `halt` | Halt entity |
| `facets` | `FacetValue`s built by `H.facet('category').of(value)` |

- **No free strings.** The parent's free-string `group` is gone.
- **Queries.** Queries filter by the same typed dimensions.
- **Facet check.** A facet named `kind`, `lane`, `state`, `model`, `seat`, `resource` or `halt` is a startup error.
- **Crossings.** A crossing band may be split `per` a facet; the event carries that facet's `value`.

## Memory scope (principle 8, 14; critique 1)

- **Entities in scope.** `Scope.kinds`, `roles` and `resources` take entities. `AgentTask.resources` takes `Resource` entities.
- **Recall by resource.** An attempt's resource scope is its leases plus its task resources, so an item scoped to resource `glossary-db` is recalled only by attempts touching it.
- **Sections.** Sections (scenario 6) are resources, as principle 8 lists.
- **Skills.** Skills stay strings: principle 8 does not make them entities.
- **Serialization.** Stored items serialize identities as names (`StoredScope`). That is storage, not surface.

## Accounts and quota (principle 15; critique 1, scenario 7)

- **The account names its quota partition.** `claudeCode.subscription(name, { token, quota: sqlite.quota('owner-quota', { path }) })`. The ledger carries no quota option and no quota methods. `Ledger.appendQuota` and `Ledger.readQuota` are deleted.
- **The partition** (`QuotaPartition`) is an instance with its own backend. It holds append-only `QuotaEvent`s keyed by account and harness, folded at read time, with no cross-harness lock.
- **Harness identity.** It is the `H.harness(name)` name.
  - At start, the harness `join`s each account's partition under its name, with a holder id and a TTL.
  - A second live process joining under the same harness name is refused.
  - Two different harnesses coexist.
- **Share caps.** These are per harness, because pools are declared in the harness. `AccountState.shareUsed` folds only this harness's events, while `utilization` and `cooldownUntil` fold everyone's. A cooldown observed by harness A is seen by harness B on its next read.
- **One account, one partition.** The same `Account` descriptor imported by two harness files carries the same partition. Startup refuses one account name bound to two partitions within a harness.
- **Supervisor across harnesses** (known weakness 8). A client exposes its `endpoint` (transport and port). The adapter's `claudeCode.session(name, { endpoints })` names one supervisor session pointed at several harness endpoints. Each endpoint reports its harness's account state, which is shared through the partition.

## Leases, order, store maps

- **Leases.** `Lane.lease(unit => ({ resource, mode }))` takes an exclusive or shared lease whenever an attempt runs, and releases it when the attempt blocks or ends.
  - The scheduler does not pull a card whose lease is unavailable.
  - Each lease is recorded as `leaseTaken` with its wait time.
- **Order.** `Lane.after({ key, onPredecessorFailed })` holds a card until its predecessor reaches a success terminal. Any other verdict parks the card in the named waiting state, recorded as `orderHeld` with the reason.
- **Store maps.** A mapped store requires a total `states` map, an `inFlight` value and optional per-step values. Steps are typed, so `.store` follows `.handler` in a lane chain.

## Restart (scenario 10, unchanged mechanism)

- **Writer claim.** There is one ledger writer claim with a TTL. A second process refuses to start, or takes over once the TTL expires.
- **Completed steps** replay at zero cost.
- **The running step** follows its `afterCrash`:
  - `rerun`;
  - `park` (the supervisor gets `unsafeToRerun`, unless `alreadyDone` reports true);
  - `askDriver` (`ModelDriver.session`).
- **Moved state.** Halts resolved while the harness was down, finished jobs and finished children are read from the ledger.
- **Changed definitions.** A `flowVersion` mismatch parks the attempt as `definitionChanged`. The supervisor may then restart it from the top or abandon it (`attemptsRecover`).
- **Metrics.** `attemptInterrupted` is excluded from every rate. A resumed attempt keeps its id.
- **Loops.** Iterations are recorded, so a resumed loop continues at the first unrecorded iteration. This is how a backfill resumes at its next batch.

## Entities

**Kinds** (vocabulary, no backend):
- work kind;
- state;
- signal;
- role;
- memory kind;
- halt;
- resource;
- facet;
- command;
- job;
- flow;
- operation.

**Instances** (carry a backend, built in subpaths):
- account (with its quota partition);
- quota partition;
- model;
- embedder;
- runner;
- workspace;
- supplier;
- store;
- memory store;
- ledger;
- client;
- observer.

`H.clock` and `H.operator` are kernel suppliers.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store map × flow (exits, params) × retry × lease × order × ceiling | a swimlane of managed units |
| Seat | role × model or model policy × pool × workspace × guard × raisable halts | a model-call executable |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader and recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples or amounts with typed dimensions | a windowed figure with sample counts |
| Scheduler | classes of service × WIP × aging × admission | pull decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness, identified by name |

## Startup validation (known weakness 9)

`start()` fails, before any supplier starts, on any of:

1. Two descriptors with one name, within an entity sort.
2. A lane with no `retry`, or a `retry.exhausted` state outside the kind.
3. An exit-map state outside the kind, or a flow with a path that reaches no exit.
4. A kind whose `initial` state is missing.
5. A lane in no class of service, or in two.
6. A lane, journal or metric that a trigger, scheduler entry, spawn or WIP group references but the harness does not register.
7. A signal routed or triggered into a lane without a reaction. This includes `H.cancel` or the `workCancel` grant on a lane without a cancel reaction.
8. A reaction `at` or `restart` naming a step its flow lacks. (The type system already prevents this; the check guards untyped clients.)
9. A seat without a pool, or a seat model (or policy candidate) whose driver serves no account of its pool.
10. A `seat.batch()` job on a driver without `submitBatch`, or `askDriver` on a driver without `session`.
11. A guard the driver cannot `enforce`.
12. A grant naming a halt no registered flow, seat or ceiling uses.
13. A halt policy over a halt or kind other than the one at its address.
14. A halt timeout not later than its escalation.
15. A crossing over a total metric.
16. A facet whose name is a column name.
17. `Lane.after` on a kind without a key.
18. One account name bound to two quota partitions.
19. A quota partition refusing this harness name, because another live holder has joined under it.

## What changed and why

### Lens changes (Kanban)

- **Classes of service replace three settings.** `priority`, `rank` and `boost` become `expedite`, `fixedDate`, `standard` and `aging`.
  - Expedite with `holds` expresses scenario 4's preemption ("incidents first; no new backup while an incident is open") as one declared class, instead of an `admit` lambda that counts incidents.
- **WIP takes lane groups.** Scenario 11's shared drafting WIP is one declaration, not a hand-written gate over two lanes.
- **In-flight columns are steps.** The kind declares no active states, and `during` is deleted. This repairs a break of principle 12 as now ruled: "a kind declares no states for it".
  - This removes every `Building`, `Auditing` and `AwaitingApproval` state from the battery.
  - Mapped stores get an `inFlight` value instead.
- **Reactions are gated `at` typed steps.** The parent's deferred conditional restart and the string comparisons in suppliers and triggers are gone.

### Repairs to the adversary's critiques

1. **Scenario 7 and quota.** Quota moves onto the account, as a `QuotaPartition` instance.
   - The ledger loses its quota option and methods.
   - Harness identity joins the partition, and share caps are per harness.
   - A supervisor session entity covers several endpoints, and clients expose their transport.
2. **Strings standing in for entities.** Memory scope and task resources take entities. Metric dimensions are typed columns or facet entities. Step addresses are typed everywhere they are used.
3. **The kind declaring failure.** `Kind.onAttemptFailed` and `Kind.onCancelled` are deleted.
   - Failure always goes through the lane's retry, with a declared `exhausted` state. Heartbeats and migrations use `maxAttempts: 1`.
   - Cancellation goes through a reaction.
   - The "two failure mechanisms" startup rule is gone with the second mechanism.
4. **Halt and seat vocabulary.**
   - The inline halt form is deleted; one halt form remains, with an optional `when` for a not-asked branch.
   - `blockersResolve` is deleted; grants name halts.
   - The seat replaces the agent, and seat is a metric column.
5. **Scenario 2's inline skip** becomes a registered `H.policy.halt`.

### Surface fixes found while writing scenarios 1–6

1. **Halt address facets.** Scenario 2's skip policy must decide per category, and the category is a classifier step output, not a unit attribute. Before this fix, the policy saw only the unit and the metrics, so it could not know the category without a ledger read or an attribute hack.
   - `HaltOptions.facets` computes facet values at the address.
   - The kernel records them on `attemptBlocked` and `decisionRecorded` (the `facets` field in `kernel.d.ts`).
   - It passes them as `HaltPolicyCtx.facets` and `DecisionEvent.facets`.
   - The policy queries `metrics.rate(approval, { facets })` and its recorded read carries the facet dimension.
2. **Decision seats.** Scenarios 2 and 6 measure human decisions by the model that produced the judged work: approval rate by model, and which reviewer seat's critique the editor acted on. `DecisionEvent.seats` lists the seat assignments made earlier in the attempt.
   - The kernel derives them from recorded invocations, so no new ledger field is needed.
   - A decision metric keys on `seat` and `model` columns without a step-source workaround that cannot tell a human resolution from a policy one.

### Other deletions

- `Lane.during` and the `HandlerMap` type.
- `Agent` (replaced by `Seat`).
- The batch step and `BlockReason 'batch'`.
- The `batchSubmitted` event (folded into `jobSubmitted`).
- `Router.signal`'s predicate target.
- `Reaction.restart.{to, at}`.
- `Scheduler.priority`, `Scheduler.rank` and `Scheduler.boost`.
- `ops.blockersResolve`.
- `sqlite.ledger`'s `quotaPath` option.

### Additions

- `H.facet` and `FacetValue`.
- `H.job` and `Job`.
- `Seat.halts`.
- `H.ceilingDecision`.
- `QuotaPartition` and `sqlite.quota`.
- `Client.endpoint` and `claudeCode.session`.
- `StoreMap.inFlight`.
- The `haltNotAsked` and `expediteHold` events.
- `attemptStarted.serviceClass`.
- `HaltOptions.facets`.
- `HaltPolicyCtx.facets`.
- `DecisionEvent.facets` and `DecisionEvent.seats`.

### Open

- Pool still `serves` models implicitly through drivers (known weakness 5).
- Memory capture still requires an author-written trigger (known weakness 10).
- Resource-to-glob mapping for file leases remains a seat guard setting (known weakness 4).
- **Loop rounds cannot read the previous round's output.** A loop round's earlier steps cannot type-read the previous round's later step outputs. In scenario 1, the builder learns the auditor's deficits from the attempt's session and memory, not from `ctx.steps`.

## Principles broken

None knowingly.

- **Seats and agents (principle 8).** Principle 8 names both "agent" and "seat". This child gives them one builder: a seat whose model is fixed is the principle's agent. That satisfies the principle's own definition ("an agent is a seat with one model") without a second noun.
