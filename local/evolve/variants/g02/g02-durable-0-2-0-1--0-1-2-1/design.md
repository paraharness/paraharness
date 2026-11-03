# harness-dsl: Kanban lens, workspace merged into runner (child of g01-durable-0-2-0-1--2-0-1-2)

The parent's engine is kept: one ledger, completed steps replayed at zero cost, per-step crash rules, collected jobs, classes of service and lanes as swimlanes.

This child applies the **merge** operator. The **workspace** and the **runner** rhymed (each is "where an executable executes, prepared per attempt, with checks around it"), so they become one entity: the runner.

It also repairs the adversary's three sharpest critiques and the founding-scenario defect, which was that the builder could not see the auditor's deficits.

## Execution vocabulary (one definition each)

- **Unit.** One card. It has a stable id and a `key`. At most one non-terminal unit per lane holds a given key. A unit outlives its attempts.
- **Attempt.** One pull of a unit through its lane's flow. It ends `succeeded`, `failed` or `cancelled`. While open it is one of:
  - *running*: the unit is at `active` and holds WIP, slots, leases and an account reservation;
  - *blocked* on `decision`, `timer`, `children`, `job` or `recovery`: the unit is at `waiting` and holds nothing;
  - *blocked* on `queued`: a rewound attempt waiting to be pulled again; the unit is at `pending`.
- **Step.** A named column of a flow. The name is the address that reactions, triggers, metrics and halts use. `loop` and `exit` are structure, not steps.
- **Invocation.** One call of an executable within a step. A step retry and each job poll are new invocations.

"Run" is not used.

## The merge: workspace into runner

The parent had two instances that rhymed.

| Instance | What it was |
|---|---|
| `Runner` | Where a command runs: `slots`, `preflight` |
| `Workspace` | Where an agent works: per-attempt `prepare` and `release`, plus the seat's `guard` (file leases, stop check) |

Both answer one question: *where does this executable execute, and what checks bracket it?* They are now one entity, the **Runner**:

- `slots(n)` and `preflight(cmd)` work as before.
- `exitCheck(cmd)` is a check that must pass before a step on this runner may end. It replaces `guard.beforeStop`.
- `leaseFiles()` stops two attempts from writing one file. It replaces `guard.leaseFiles`.
- `git.worktree(name, …)` is now a runner. Its backend implements the optional `prepare` and `release`, so it hands out one worktree per attempt.
- `Seat.runner(runner)` mirrors `Command.runner(runner)`. `Seat.workspace` and `Seat.guard` are deleted, as are the `Workspace` and `WorkspaceBackend` types.

This also answers the seat-overload critique. A seat now carries role, model or model policy, pool, runner, raisable halts and output. Workspace, guard and batch are gone.

### What the merge costs in honesty

1. **`exitCheck` means two things.**
   - On a seat, a failing check returns the agent to work inside the same invocation, which is the scenario-1 stop check.
   - On a command, there is no agent to send back, so a failing check fails the step.
   - The name covers both ("must pass before the step may end"), but the consequence differs by executable sort. A reader who knows only commands will not predict the agent behaviour.
2. **`leaseFiles` is meaningless on a runner whose executables are commands.** The driver cannot enforce a file lease on an opaque shell process. Using it there is a startup error (rule 11) instead of a type error. Splitting the runner would have kept that error in the types.
3. **A worktree runner used by a command now gets a fresh worktree per attempt.** That is correct, but it is a cost the parent never imposed on commands silently.

These costs are accepted. One noun replaces two, and a command running in a per-attempt worktree, such as the project checks, becomes expressible for free.

## Repairs to the adversary's critiques

### Scenario 1: deficits never reached the builder (and the Grant scenario)

**Loops carry.** `flow.loop(name, carry, body, { max, until, keep })` takes a carry schema.

- At the end of each iteration, `keep(ctx)` extracts a value. The kernel records it as `iterationEnded.carry`.
- Inside the body, `ctx.steps[loopName]` is the typed array of carries from *earlier completed* iterations.
- After the loop, it is all of them.
- The schema comes before the body, so `C` is inferred first. There is no circular inference.

In scenario 1 the builder's round-N task lists every earlier round's deficits from `ctx.steps.rounds`. Nothing goes through a vendor session or memory, so principles 1 and 14 hold.

**Rewind replaces restart.** `Lane.on(signal, { rewind: step, at })` moves the *same open attempt* back to the step.

- A pending halt is withdrawn and recorded as `haltWithdrawn`. The attempt waits as `queued` until it is pulled.
- Iteration counters and carries are never cleared by a rewind. Rewinding into a loop restarts the current iteration at that step, and the iteration index does not change.
- Cancelling and returning to a state is still `enter: state`. That is what scenario 2 asks for.

**The Grant application.** It becomes `loop('review', Notes, b => b.step('assess', …).halt('panel', …), { max: 3, until: approved, keep: ctx => ctx.steps.panel })` with `on(revision, { rewind: 'assess', at: ['panel'] })`.

- A revision during the panel rewinds the current round and does not reset the count.
- Each `assess` prompt reads every prior panel note verbatim from `ctx.steps.review`.
- The flow reads no ledger, does no arithmetic over attempts, and writes no memory.

The same mechanism gives scenario 11 its return bound across redlines. In the parent, a restart started a fresh attempt and reset the loop.

### Strings standing in for entities (critique 1)

- **States are entities in views.** `UnitView<A, S, N>.state` is the `State` entity, so comparisons are `unit.state === AwaitingCustomer` by identity.
  - `AttemptView.step` is typed `N`, from the lane's flow.
  - `AttemptView.halt` is a `HaltRef`.
  - `OutcomeCounts.count(state)` replaces `byState.Inconclusive`.
  - Backends see names, through `StoredUnit` and `UnitRecord`.
- **`sqlite.scan` is deleted.**
  - Scenario 3 re-opens recurring topics with a timer on delivered units: `at: unit => unit.state === Delivered && … ? H.nextTime('06:00', { on: 'mon', after: unit.stateSince }) : undefined`, whose consequence `create`s a fresh unit under the same key.
  - Scenario 8's monthly tenancy review is the same: a timer on units in `Customer`, signalling `review-due`.
  - Timers may now arm on terminal units; `at` returning `undefined` disarms them. `UnitView.stateSince` was added for this.
- **Facets carry typed values.** `H.facet('category', ['billing', …])` gives a `Facet<V>`, and `of(value: V)`.
  - A crossing band `per: facet` yields `FacetCrossingEvent<V>`, whose `value` is required and typed. There is no `=== undefined` guard.
  - `H.when.pattern`'s `per` returns a `FacetValue<V>`, so `PatternEvent.group` is typed.
  - `DecisionEvent.valueOf(facet)` and `HaltPolicyCtx.valueOf(facet)` read a facet back as `V`.
- **Seat lookup by identity.** `DecisionEvent.modelFor(seat)` replaces `assignment.seat.name === drafter.name`.
- **Section resources.** Lookup by name is a scenario-authoring defect. Sections are written as an enum-keyed record of `Resource` entities, so `sections[draft.section]` is indexed by a typed key and never by `resource.name`.
- **Remaining strings.** `Router.signal(signal, key, payload)` still takes a unit key string. A key is domain identity (a ticket id), not an entity. Skills remain strings, as principle 8 does not list them.

### Timer re-arm coupling (critique 2)

A timer's deadline is the value of its `at(unit)` function.

- The kernel re-evaluates `at` after every recorded `attributesUpdated` and `transition` on the unit.
- The timer moves only when the computed deadline changes. That records `timerCleared: moved` plus a new `timerSet`.
- Returning `undefined` disarms the timer.

The dependency is therefore exactly what `at` reads, and nothing else:
- A redline that does not touch the deadline field re-arms nothing.
- A reviewer's SLA extension through `workUpdate` changes `slaDue`, so it moves the timer, and the old deadline never fires.

The rule is declared here and is not an accident of `update`.

### The seat (critique 3)

- **Batch moved off the seat.** `H.batch(seat)` is a kernel function returning a `Job`, run with `flow.job`. Batch-ness is a way of running a seat's call, not a property of the seat.
  - A batch job whose model's driver lacks `submitBatch`, or whose pool has no account that driver serves, is a startup error.
  - Types do not catch the pool/model mismatch, because driver ↔ account service is a backend value relation (known weakness 5, still open).
- **The A/B collapse.** `PolicyCtx` now carries:
  - `current`: this seat's last assigned model;
  - `assigned`: seats already assigned in this attempt;
  - `peers`: the other seats of the same role in this flow.
  
  The kernel assigns every seat of a flow at attempt start, in flow order, and records each as `seatAssigned` with its metric reads.
  - Reviewer B's policy sees reviewer A's model in `assigned` and must choose differently. Scenario 6 can therefore never end with both seats on one model.
  - Each policy reads its own series by `{ seat: ctx.seat, model: ctx.current }`. After a swap the new model accrues samples and can be swapped back.
- **No more rival thunk.** The forward-reference `(): SeatRef => reviewerB` is gone. The rival comes from `ctx.peers`.

### Smaller wounds

- **Scenario 1.**
  - Heartbeats go in `expedite` in both scenario 1 and scenario 7, so there is one encoding.
  - The share caps sum deliberately and are written as such.
  - A trigger-created Bug enters the tracker through the lane's typed `StoreMap`.
- **Scenario 12.** `Metrics.jobs({ job, window })` reports `hoursInFlight` by overlapping each job's `jobSubmitted` to `jobCollected` span with the window. Running jobs count up to now, and a job spanning midnight splits across days. Samples and the running count sit beside the figure.
- **`admit` lambdas.** Lambdas that re-implement rules no scenario asked for are dropped from the scenarios. `admit` remains for scenario 3's budget.
- **Arithmetic over attempts.** `UnitView.attempts` and `failedAttempts` are removed, so flows cannot do attempt arithmetic.

## Lifecycle (principle 12)

- **States.** `H.state(name, 'pending' | 'waiting')` declares a non-terminal state, and `H.terminal(name, verdict)` a terminal one. The verdict has no default.
- **What a kind declares.** No active states and nothing about failure. Where an active unit stands is its attempt's current step.
- **What the lane declares.**
  - Exits map to any state of the kind.
  - A failed attempt returns the unit to pending under `retry`.
  - `retry.exhausted` names the state where exhaustion leaves the unit. A lane without `retry` is a startup error.
- **Signals.** An `enter` reaction cancels the open attempt and moves the unit. A `rewind` keeps the attempt.

## Board and pull

These are unchanged from the parent:
- classes of service: `expedite` with `holds`, `fixedDate` and `standard`;
- `aging`;
- `wip` over lane groups;
- `admit`;
- `pause` and `resume`, recorded with their reason.

The board renders, per lane:
1. pending states, with queued rewound attempts shown in their step;
2. one column per step, split into running and blocked;
3. waiting states;
4. terminal states.

## Halts

- **Entity and address.** `H.halt(name).decision(schema)` is the entity. `flow.halt(step, halt, options)` is its address, and one halt may be asked at several addresses.
- **Resolvers:**
  - `human`, through `H.ops.resolve(halt)`;
  - `policy`, through `skip`, which is a registered `H.policy.halt` whose recorded decision carries its reads and sample counts;
  - `timeout`, which resolves the halt and does not cancel the attempt.
- **Clocks.** `escalate` and `timeout` run from the recorded `attemptBlocked`.
- **`when`.** A false `when` records `haltNotAsked` and types the output `D | undefined`.
- **Grants** name halts.

## Seats, pools, accounts, quota

- **Seat** = role × model or model policy × pool × runner × raisable halts × output. A seat with a fixed model is the agent of principle 8. The seat is a typed metric column.
- **Pool** = accounts × shares × drain policy × fallback.
- **Account and quota.**
  - An account names its `QuotaPartition`. The ledger carries no quota option and no quota methods.
  - Harness identity joins the partition, and share caps fold per harness.
  - `claudeCode.session` points one supervisor at several harness endpoints.

## Restart (scenario 10)

The restart mechanism is unchanged:
- one writer claim with a TTL;
- replay of completed steps;
- `afterCrash: rerun | park | askDriver`, with `alreadyDone` to tell whether a parked step's effect happened;
- moved state is read from the ledger: resolved halts, collected jobs (`jobCollected`), finished children;
- a `flowVersion` mismatch parks the attempt as `definitionChanged`;
- `attemptInterrupted` is excluded from every rate.

What is new is resuming from loop records. Iterations and carries are recorded, so a resumed loop continues at its first unrecorded iteration with its carries intact. That is how a backfill resumes at its next batch. Seat assignments are recorded, so a resumed attempt keeps its models.

## Entities

**Kinds** (vocabulary, no backend):
- work kind;
- state;
- signal;
- role;
- memory kind;
- halt;
- resource;
- facet (with values);
- command;
- job;
- flow;
- operation.

**Instances** (carry a backend):
- account;
- quota partition;
- model;
- embedder;
- runner (absorbs workspace);
- supplier;
- store;
- memory store;
- ledger;
- client;
- observer.

`H.clock` and `H.operator` are kernel suppliers.

**Pivots:**

| Pivot | Combines |
|---|---|
| Lane | kind × suppliers × store map × flow × retry × lease × order × ceiling |
| Seat | role × model or policy × pool × runner × halts |
| Pool | accounts × policy |
| Journal | memory kind × store × recall |
| Trigger | source → consequences |
| Metric | source → typed samples |
| Scheduler | classes of service, WIP and admission |
| Harness | everything above, under one name |

## Startup validation

`start()` fails before any supplier starts if any of these holds:

1. Two descriptors in one entity sort share a name.
2. A lane has no `retry`, or its `retry.exhausted` state is outside the kind.
3. An exit-map state is outside the kind, or a flow path reaches no exit.
4. A kind's `initial` state is missing.
5. A lane is in no class of service, or in two.
6. A lane, journal or metric is referenced but not registered.
7. A signal is routed or triggered into a lane without a reaction, including `H.cancel` and `workCancel`.
8. A reaction's `at` or `rewind` names a missing step.
9. A seat has no pool, or a seat's model or policy candidate is served by no account in its pool.
10. `H.batch` is used on a driver without `submitBatch`, or `askDriver` on a driver without `session`.
11. A runner declares `leaseFiles` but carries only commands, or a guard is declared that the driver cannot `enforce`.
12. A grant names an unused halt.
13. A halt policy's halt or kind is not the ones at its address.
14. A halt's timeout is not later than its escalation.
15. A crossing is declared over a total metric.
16. A facet's name is a column name, or a `FacetValue` is outside its facet's declared values (the latter at the first record, or at startup for constants).
17. `Lane.after` is used on a kind without a key.
18. One account name is bound to two quota partitions.
19. The quota partition refuses this harness name.
20. Two seats in one flow share a role, and any of their model policies has fewer candidates than there are peers. Distinct assignment would then be impossible.

## What changed and why

**Merged.**
- `Workspace` into `Runner`, by the operator, with its costs stated above.
- `Seat.guard` became `Runner.exitCheck` and `Runner.leaseFiles`.

**Moved.**
- `Seat.batch()` became `H.batch(seat)`.
- `Reaction.restart` became `Reaction.rewind`, which keeps the same attempt.

**Added.**
- The loop carry: the `carry` schema, `keep`, and the `iterationEnded` event.
- On `PolicyCtx`: `current`, `assigned` and `peers`, with `seatAssigned` events.
- Typed facets: `Facet<V>`, `FacetValue<V>`, `FacetCrossingEvent<V>` and `valueOf`.
- `DecisionEvent.modelFor`.
- `UnitView.stateSince`, with `state` typed as an entity and `step` typed as a name.
- `OutcomeCounts.count(state)`.
- `Metrics.jobs`, with `jobCollected`.
- `H.nextTime({ on })`.
- The `queued` block reason, `haltWithdrawn` and `attemptRewound`.
- Timer semantics: a timer moves only on a changed deadline, and timers may arm on terminal units.

**Deleted.**
- `sqlite.scan` and its `StoredUnit` adapter type.
- `Workspace` and `WorkspaceBackend`.
- `Seat.workspace`, `Seat.guard` and `Seat.batch`.
- `UnitView.attempts` and `UnitView.failedAttempts`.
- `AttemptView.number`.
- `Reaction.restart`.
- `CrossingEvent.value?: string` and `PatternEvent.group: string`.

**Open.**
- Pool ↔ model service is still checked at startup, not in types (weakness 5).
- Memory capture still needs an author-written trigger (weakness 10).
- Resource-to-glob mapping for file leases remains inside the driver (weakness 4).

## Principles broken

None knowingly.

- **Principle 8 (instances).** The merged runner is still an instance carrying its backend. The rule that "an agent is a seat with one model" is met as in the parent: there is one builder and no second noun.
- **Principle 12 (one attempt).** `rewind` keeps one attempt open across an outside event. The attempt still ends with exactly one of the three outcomes. A rewound attempt is at `pending`, because it is schedulable and holds nothing; it is not `active`.
