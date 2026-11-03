# harness-dsl, surface cut (child of g01-durable-0-2-0-1--2-0-1-2)

This child keeps the parent's engine: a Kanban lens, one ledger, replay at zero cost, per-step crash rules and collected jobs.

It makes two kinds of change:

1. **Surface cut.** Every method or option the battery never calls is deleted. Wherever the only caller is one scenario, the option is folded into something more general that already exists.
2. **Repairs.** It repairs the worst-handled scenario and the adversary's three sharpest critiques.

## Execution vocabulary (one definition each)

- **Unit.** One card, with a stable id and a `key`. At most one non-terminal unit per lane holds a key. A unit outlives its attempts.
- **Attempt.** One pull of a unit through its lane's flow. It ends `succeeded`, `failed` or `cancelled`.
  - While open, it is *running* (position `active`, holding WIP, slots, leases and account reservations) or *blocked* (position `waiting`, holding nothing).
  - A blocked attempt records what it is blocked on: `decision`, `timer`, `children`, `job`, `recovery` or `capacity`.
- **Step.** A named address in a flow. `loop` and `exit` are structure, not steps.
- **Iteration.** One pass of a loop body inside one attempt. It is *counted* if the body completed, and not counted if a rewind interrupted it.
- **Invocation.** One call of an executable within a step. Step retries and job polls are new invocations.

## Lifecycle (principle 12)

**States.**
- `H.state(name, 'pending' | 'waiting')` declares a non-terminal state.
- `H.terminal(name, verdict)` declares a terminal state. The verdict has no default.
- A kind declares no active states.
- A kind's **initial state is the first pending state it lists**. A kind with no pending state is a startup error. `Kind.initial` is deleted; it had no caller that differed from this rule.

**`UnitView.state` is the State entity**, not its name. Comparisons are by identity (`unit.state === Delivered`), and `Metrics.outcomes(...).inState(Inconclusive)` replaces the string-keyed `byState`.

**Failure.**
- A failed attempt returns the unit to pending under the lane's `retry`.
- On exhaustion the unit moves to `retry.exhausted`, a state of the kind.
- A lane without `retry` is a startup error.

**Cancellation.**
- An `enter` reaction cancels the open attempt and moves the unit to the named state.
- `H.cancel` is an ordinary signal.

## Reactions: enter or rewind

`Lane.on(signal, { update, enter, rewind, at })` declares how a lane reacts to a signal.

- **`update`** always applies.
- **`enter: state`** cancels the open attempt (outcome `cancelled`, never a failure) and moves the unit to that state.
  - Scenario 2's "customer replies while awaiting approval" uses this: enter `New` with the updated message.
- **`rewind: step`** keeps the same attempt.
  - The kernel records `attemptRewound`, discards the outputs of the current iteration from that step on, and continues at the step.
  - If the step is the first step of a loop body, a new iteration begins. The interrupted iteration is recorded as not counted and contributes no feedback.
  - A blocked attempt that is rewound becomes blocked on `capacity` until WIP admits it.
  - The attempt id, the loop's counted iterations and the carried feedback all survive the rewind.
  - This replaces the parent's `restart`, which cancelled the attempt and so reset every per-attempt bound. That is the hole in the adversary's grant-application scenario and in scenario 11.
- **`at: [steps]`** gates `enter` and `rewind` to the named steps. Outside those steps only `update` applies, recorded with `gatedAtStep`.

## Loops carry feedback (repairs scenario 1)

```
.loop(name, feedbackSchema, body, { max, until?, feed })
```

- **`feed`.** At the end of each counted iteration the kernel records `feed(ctx)` as that iteration's feedback, in `iterationEnded.feedback`.
- **The loop's name.** Inside the body, `ctx.steps[name]` is the typed list of earlier iterations' feedback.
  - In scenario 1 the builder's task reads the auditor's deficits, and the owner's decision, from every earlier round.
  - In scenario 11 the drafter reads every counsel note verbatim.
- **Replay.** The feedback is a recorded step output like any other and replays like one. The flow reads no ledger, holds no counter and stores nothing in memory.
- **Bounds.** `max` is required, so every loop has a declared bound. It counts counted iterations, and the count survives a rewind.
  - Scenario 11's "Declined after the second return" is `max: 2` and holds across redlines.
- **`ctx.iteration` is deleted.** The feedback list's length is the round number. A backfill's offset is the sum or count of its fed batches.

## Seat-raised halts become flow halts (surface cut)

`Seat.halts`, `ModelRequest.halts`, `ModelResponse.halt` and the session-resume request are deleted.

- **The builder asks instead of halting.** Its output carries an optional `question`.
- **The flow decides whether to ask.** A `flow.halt(..., { when })` inside the loop asks the owner only when there is a question.
- **The answer feeds forward.** The decision reaches the next round through the loop's feedback.

Halting for the owner is now one mechanism, not two. There is also no hidden state in a driver session (principle 1).

## Time (repairs critique 2)

```
H.when.timer(lane, { in: states, at: unit => Date | undefined })
```

**Arming and clearing.**
- The timer is armed when the unit enters one of the `in` states, which may include terminal states.
- It is cleared when the unit leaves them (`timerCleared: leftState`).
- While an attempt is open the unit's state is its last named state, so the timer stays armed through the attempt.

**Re-arming.**
- After every `attributesUpdated`, the kernel recomputes `at(unit)` and re-arms only if the deadline changed.
- A redline that does not touch the deadline re-arms nothing.
- Scenario 9's SLA extension is a `workUpdate` that changes `slaDeadline`: the timer moves and the old deadline never fires.
- The dependency is the declared pure function, not a hidden rule.

**What this replaces.**
- The `in` filter replaces the string comparisons the parent wrote in trigger bodies (`event.unit.state === 'AwaitingCustomer'`, `unit.position === 'terminal'`).
- It also replaces `sqlite.scan` and `StoredUnit`:
  - Scenario 3's weekly re-open is a timer `in: Delivered` that fires next Monday for recurring topics. Its trigger creates a fresh unit under the same key, which is free because the old unit is terminal.
  - Scenario 8's monthly tenancy review is a timer `in: Customer` whose signal enters `ReviewDue`. The review's exit re-enters `Customer`, which re-arms the timer.

**Halt clocks.** `timeout` and `escalate` run from the recorded `attemptBlocked`, never from unit data.

## Halts

**Entity and address.**
- `H.halt(name).decision(schema)` is the entity.
- `flow.halt(step, halt, { ask, skip?, facets?, timeout?, escalate?, when? })` is an address of it. One halt may have several addresses.

**Resolvers.**
- `human`, through a client granted `H.ops.resolve(halt)`.
- `policy`, through `H.policy.halt(name, kind, halt, decide)`. Its decision is recorded with every metric figure it read, and the sample counts.
- `timeout`, which resolves the halt and continues the same attempt.

**`when` false.** The halt is not asked: the kernel records `haltNotAsked` and the step's output is `D | undefined`.

**Cost ceiling.** `Lane.ceiling({ maxUsd, halt })` always halts on a `CeilingDecision` (raise or fail). The parent's `'fail'` option is deleted. It had one caller, scenario 3, which now names a ceiling halt and grants it.

## Seats (repairs critique 3)

**What a seat is now:** `H.seat(name).role().model(model | policy).pool().output()`, plus `.workspace(ws, guard?)` for agents that edit files.
- Workspace and guard are one method.
- Raisable halts are gone (see above).
- Batching is gone from the seat.

That leaves the seat with four concerns. The workspace and its guard are one environment.

**Batch is a step, not a seat property.**
- `flow.job(step, seat, ctx => tasks)` submits the tasks through the seat's driver's batch API and collects them later. Its output is `O[]`.
- `flow.job(step, job, input)` runs a command-pair job.
- Both hold no capacity while they run, are collected on restart and are never resubmitted.
- `seat.batch()` is deleted.

**Pairing a model with a pool.** Whether a model can be served by a pool stays a driver question (`ModelDriver.serves`), checked at startup (rule 9).
- A type-level brand would forbid scenario 1's legitimate fallback, which takes a subscription pool to an API account served by the same driver.
- The adversary's case, a batch on a pool whose accounts' drivers lack `submitBatch`, fails startup rule 10 before any supplier starts.

**Model lookup by seat entity.** `DecisionEvent` and `StepEvent` expose `modelOf(seat)`, keyed by the seat entity. The `.find(a => a.seat.name === x.name)` string comparisons are gone.

**The A/B in scenario 6.**
- *No collapse.* Each reviewer seat gets disjoint candidates (reviewer-a: opus or challenger-a; reviewer-b: sonnet or challenger-b), so the two seats can never land on one model.
- *No rival reference.* Each policy compares its own seat's rate with the overall rate of the metric, which covers both seats. That needs no reference to the rival seat, so the forward-reference thunk is gone.
- *Measures the current model.* The policy reads its own series per candidate model, so after a swap it measures the challenger and can swap back.

## Strings that stood for entities (repairs critique 1)

| Was | Now |
|---|---|
| `UnitView.state` held a name | holds the `State` entity |
| `ChildResult.state` held a name | holds the `State` entity |
| `OutcomeCounts.byState` keyed by name | `inState(State)` |
| A free-string facet | `H.facet(name, schema)` gives a `Facet<V>`, with `of(value: V)` |
| `CrossingEvent.value?: string` | When a band is split `per` a facet, the event's `value` is the typed `V`. Without `per` it is `undefined`, so there is no guard on every consequence. |
| `PatternEvent.group: string` | `group: K`, inferred from `per` |
| Resource and section lookup by name (`sectionsOf(section: string)`) | Scenario code keys typed records by an enum attribute parsed at supply time (`sections[draft.section]`). No DSL entity is ever looked up by name. |

Skills remain strings: principle 8 does not make them entities.

## Metrics

**Dimensions** are the typed columns (kind, lane, state, seat, model, resource, halt) or facet values. A facet named like a column is a startup error.

**`Metrics.jobs({ job, window })`** answers scenario 12's question correctly.
- It returns GPU-hours in flight, computed from the `jobSubmitted` to `jobCollected` intervals clipped to the window.
- Jobs still running count up to now.
- It returns sample counts and the number still running.
- The parent's step-end `durationMs` metric, which put a job running at midnight on the wrong day, is deleted.

**Other figures** with sample counts:
- `outcomes`
- `attempts`
- `rate`
- `total`
- `paused`
- `decisions` (median time per halt and per resolver)
- `leases` (wait time per resource)

## Scheduling (Kanban core, unchanged)

**Classes of service.**
- `expedite(lane, { holds })`
- `fixedDate(lane, due)`
- `standard(...lanes)` with `aging`

**Other controls.**
- `wip(lane | lanes, max)` counts running attempts only.
- `admit(lane, gate)` is kept for scenario 3's daily budget. `AdmitCtx.count` had no caller and is deleted.
- Admission gates that re-implemented rules nobody asked for (scenarios 8, 9 and 12) are removed from the scenarios.

**Heartbeats first.** Scenarios 1 and 7 both write this one way: heartbeats lead the `standard` order.

**Pause.** `pause` and `resume` triggers are ledger events carrying the reason.

## Accounts and quota (principle 15, unchanged)

**The partition.** The account names its `QuotaPartition`. Each harness appends its own consumption events and folds the window at read time, so no harness takes a lock over another's account state.

**Share caps** are per harness, because each harness declares its own pools.
- `share(account, fraction)` is the fraction of that account's window this harness may consume.
- Shares need not sum to 1, since another harness may use the rest. Scenario 1's 0.5/0.5/0.3 is the owner's choice; scenario 7's 0.6 and 0.3 split one account across two harnesses.

**One supervisor across harnesses.** `claudeCode.session(name, { endpoints })` names a supervisor session pointed at several harness endpoints. Every client's `endpoint` now has a required port.

## Restart (scenario 10, unchanged mechanism)

- **Writer claim.** There is one writer claim with a TTL.
- **Completed steps** replay.
- **The running step** follows `afterCrash`: `rerun`, `park` (unless `alreadyDone` reports true) or `askDriver`.
- **Moved state** is read from the ledger: resolved halts, collected jobs, finished children.
- **Changed definitions.** A `flowVersion` mismatch parks the attempt. The supervisor may restart it from the top or abandon it.
- **Metrics.** `attemptInterrupted` is excluded from rates.
- **Loops.** Loop iterations and their feedback are recorded, so a backfill resumes at its next batch.

## Entities

**Kinds** (vocabulary, no backend):
- work kind, state, signal, role, memory kind;
- halt, resource, facet;
- command, job, flow, operation.

**Instances** (carry a backend, built in subpaths):
- account, quota partition, model, embedder;
- runner, workspace;
- supplier, store, memory store, ledger;
- client, observer.

`H.clock` and `H.operator` are kernel suppliers.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store map × flow × retry × lease × order × ceiling × reactions | a swimlane of managed units |
| Seat | role × model or model policy × pool (× workspace) | a model-call executable |
| Pool | accounts × shares × drain × fallback | quota-eligible access |
| Journal | memory kind × store × recall × reader and recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples or amounts with typed dimensions | a windowed figure with sample counts |
| Scheduler | classes of service × WIP × aging × admission | pull decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

## Startup validation

`start()` fails before any supplier starts on any of the following. The `Ledger` and `QuotaPartition` interfaces give the kernel what it needs to check each.

1. Two descriptors of one sort sharing a name.
2. A lane without `retry`, or with an `exhausted` state outside its kind.
3. An exit or reaction state outside the kind, or a flow path reaching no exit.
4. A kind with no pending state.
5. A lane in no class of service, or in two.
6. A lane, journal or metric referenced by a trigger, scheduler entry, spawn or WIP group but not registered.
7. A signal routed or triggered into a lane without a reaction to it. This includes `H.cancel` or `workCancel` on a lane with no cancel reaction.
8. A reaction `at` or `rewind` naming a missing step. Types prevent this; the check guards untyped clients.
9. A seat without a pool, or a seat model or policy candidate whose driver serves no account of its pool.
10. A seat `job` on a driver without `submitBatch`, or `askDriver` on a driver without `session`.
11. A guard the driver cannot `enforce`.
12. A grant naming a halt that no registered flow address or ceiling uses.
13. A halt policy over a halt or kind other than its address's.
14. A halt timeout not later than its escalation.
15. A crossing over a total metric.
16. A facet named like a column.
17. `Lane.after` on a kind without a key.
18. One account name bound to two quota partitions.
19. A quota partition refusing this harness name because a live holder holds it.
20. A timer `in` a state outside the lane's kind.
21. A loop feedback schema that does not serialize to JSON.

## What changed and why

### Surface cut (operator)

**Deleted, because no caller in the battery uses it:**
- `Kind.initial`
- `StoreMap.steps`
- `FlowCtx.metrics` and `FlowCtx.now`. A flow reading metrics read the ledger, against scenarios 10 and 11.
- `UnitView.costUsd`, `attempts`, `failedAttempts` and `attempt`
- `StepEvent.outputs`, `durationMs` and `at`
- `DecisionEvent.halt`, `resolver`, `waitedMs` and `at`
- `TransitionEvent.to`
- `AdmitCtx.count`
- `H.ops.lanesPause`
- `Flow` step-level `iteration`
- The `Kind`, `Signal` and `Halt` name generics
- `HaltPolicyDraft`. `H.policy.halt` takes `decide` positionally; inference still flows from the halt.

**Folded, because only one scenario used it:**

| Removed | Now expressed as |
|---|---|
| `Command.acceptExitCodes` (scenario 5) | The validate command reports pass or fail in its JSON output. |
| `Runner.preflight` (scenario 4) | A disk-space step runs before the backup on the same host. A preflight is a step, and it is recorded like one. |
| `Seat.halts` and the session-resume protocol (scenario 1) | A flow halt with `when`. |
| `seat.batch()` | A `flow.job` overload. |
| `ceiling onExceed: 'fail'` (scenario 3) | Every ceiling halts. |
| `ops.workSignal` (scenario 8) | Covered by `workUpdate`, which updates attributes and delivers signals. |
| `ops.accountsRead` | Covered by `telemetryRead`. |
| `sqlite.scan` and `StoredUnit` (scenarios 3, 8) | Timers `in` a state. |
| The `Seat.guard` method | An argument of `Seat.workspace`. |

**Added (each with a named caller):**
- loop `feedback` and `feed` (scenarios 1, 8, 11, 12)
- `Reaction.rewind` (scenario 11)
- `timer.in` (scenarios 2, 3, 5, 8, 9)
- `H.facet` value schema (scenarios 2, 9, 11)
- `Assignments.modelOf` (scenarios 2, 3, 6)
- `OutcomeCounts.inState` (scenario 8)
- `Metrics.jobs` (scenario 12)
- `CalendarOptions` on `H.nextTime` (scenarios 3, 8)
- the ledger events `attemptRewound`, `iterationEnded` and `jobCollected`
- the blocked reason `capacity`

### Repairs to the adversary's critique

1. **Scenario 1 deficits.** Loops carry typed feedback, so each build round reads every earlier audit's deficits and owner decision. The builder role's instruction is now true.
2. **Grant application and scenario 11 bound reset.** `rewind` keeps the attempt, so `max` and the carried notes survive applicant revisions and redlines.
3. **Strings for entities.** State, seat, facet value and pattern group identities are now typed.
4. **Timer coupling.** A timer re-arms only when its declared deadline function changes value, and is scoped by `in`.
5. **Seat overload.** The seat is down to role, model, pool, output and an optional workspace. Batch moved to the step, raised halts moved to the flow.
6. **A/B collapse and the forward-reference thunk.** Disjoint candidates prevent the collapse, and comparing against the overall rate removes the thunk.
7. **Economy.** Unrequested admit lambdas are removed. GPU hours come from job intervals.
8. **Other noted defects.**
   - "Heartbeats first" has one encoding.
   - Share fractions are explained.
   - A trigger `create` into a lane with an external store calls `Store.create`. Every `Store` must implement it, so it is typed by the interface.

### Open

- **Known weakness 4.** A file-lease guard still maps files to leases inside the driver.
- **Known weakness 10.** Memory capture still needs an author-written trigger.

## Principles broken

None knowingly.

- **Principle 8: seat and agent.** It defines an agent as "a seat with one model". A seat whose `model` is a fixed instance is that agent. Only one builder exists, so standard 22 holds.
- **Principle 3: batch as a step kind.** A batch stays a step kind in substance, as `flow.job` given a seat. It shares the external-job semantics (submitted now, collected later, no capacity held), as principle 3 lists both.
