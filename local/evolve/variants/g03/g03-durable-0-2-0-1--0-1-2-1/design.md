# harness-dsl: demand-driven execution (child of g01-durable-0-2-0-1--2-0-1-2)

The parent drew the execution model as a Kanban board, on top of a durable replay engine. This child keeps that engine: one ledger, zero-cost replay, per-step crash rules and collected jobs. It redraws the flow of units the way GenStage and Broadway draw message flow:

- **Producers emit.** Suppliers are producers.
- **The ledger is the buffer.** The pending queue is the durable buffer between producers and consumers.
- **Lanes consume.** Each lane is a consumer.
- **The scheduler computes demand.** Demand is how many pending units each lane may pull now.
- **Demand is back-pressure.** Nothing starts that no one asked for.
- **Batching is a step.** A batch is one shape of submit-and-collect work.
- **Events are delivered to the open attempt.** An event arriving at a unit with an open attempt goes to that attempt as a message, like a message sent to a running stage. The attempt is not killed and replaced.

The owner's words are kept: unit, attempt, step, invocation, supplier, lane, WIP. Only one lens word is adopted, **demand**, because it names something the owner's vocabulary leaves implicit: the per-lane number the scheduler computes each tick. "Producer", "consumer" and "stage" are used in this document only to explain; none of them is an entity.

## Execution vocabulary (one definition each)

- **Unit**: one item of work.
  - It has an id and a `key`, taken from `Kind.key`.
  - At most one non-terminal unit per lane holds a key.
  - It outlives its attempts.
- **Attempt**: one pull of a unit through its lane's flow.
  - It ends with exactly one outcome: `succeeded`, `failed` or `cancelled`.
  - While open it is either *running* or *blocked*.
    - Running: the unit's position is `active`. The attempt holds WIP, runner slots, leases and account reservations.
    - Blocked: the unit's position is `waiting`. The attempt holds nothing.
  - An attempt is blocked on one of: a decision, a timer, its children, a job, or recovery.
- **Step**: a named address in a flow. `loop` and `exit` are structure, not steps.
- **Invocation**: one call of an executable within a step. A step retry and each job poll are new invocations.
- **Demand**: the number of units a lane may start now.
  - It is the lane's free WIP, minus any expedite hold or pause on the lane.
  - It is also limited by runner and account capacity, leases, order holds and `admit` gates.
  - Demand is computed, never stored. Each unit it grants is recorded as `demandGranted`.

"Run" is not used.

## Supply, buffer, demand (the lens core)

1. **Suppliers.** A supplier emits events into a `SupplySink`. `emit` resolves only after the routed `unitCreated` or `signalDelivered` event is on the ledger. That is the supplier's acknowledgement: a webhook answers 2xx and a poll advances its cursor only then. No event is lost between "received" and "recorded".
2. **The buffer.** The pending queue is the buffer between suppliers and lanes. Pushing never blocks. Back-pressure acts where it is honest: at the start of work, not at intake, because intake loss is worse than queueing. Units still at a pending position remain visible on the board and in SLA ordering.
3. **Demand per lane, each tick.** The scheduler computes:
   - **WIP.** `wip(lane | lanes, max)` counts running attempts only. A blocked attempt does not count.
   - **Pause.** A paused lane has demand 0. `pause` and `resume` are trigger consequences or the `lanesPause` operation, and both are ledger events carrying their reason.
   - **Expedite.** `expedite(lane, { holds })` sets demand 0 on the held lanes while any unit of the expedited lane is open. The expedited lane itself ignores WIP. This is the scheduler's only preemption form.
   - **Capacity and gates.** Runner slots, account eligibility (folded from the quota partition at read time), lease availability, `after` order and `admit` gates.
4. **Order within granted demand.**
   - `fixedDate(lane, due)` lanes go first, soonest due first.
   - Then `standard(...lanes)` in the listed lane order, first in first out within a lane.
   - `aging` raises a starved unit to the head of the standard order.
   - **One encoding per requirement.** "X first" is written as `standard(X, …)` order. `expedite` is written only when holds or WIP bypass are meant. The parent's scenario 1 and scenario 7 used two encodings for one requirement; the battery will use one.

## Lifecycle (principle 12)

- **States.** `H.state(name, 'pending' | 'waiting')` declares a non-terminal state. `H.terminal(name, verdict)` declares a terminal state, with no default verdict.
- **No active states.** A kind declares no active states. Where an active unit stands is its attempt's current step.
- **What a kind declares:** attributes, states, `key` and `initial`. Nothing about failure, suppliers, stores or handlers.
- **`UnitView.state` is the state entity.** It is no longer its name, so `unit.state === AwaitingCustomer` compares identities with full typing. `Metrics.outcomes(...).count(Inconclusive)` replaces `byState.Inconclusive`. Backends store names (`StoredUnit`); the runtime resolves them to entities.
- **How an attempt leaves the unit:**
  - **Exit.** The lane's `exits` map sends the exit to a state of the kind.
  - **Failure.** The unit returns to pending under the lane's `retry`. When retry is exhausted, the unit moves to `retry.exhausted`. A lane without `retry` is a startup error.
  - **Cancellation.** It happens only through a reaction's `enter`, which cancels the open attempt and moves the unit.

## Events delivered to an open attempt (re-entry)

`Lane.on(signal, { update, rewind, enter, at })` declares how the lane reacts to a signal.

- **`update`** always applies to the unit's attributes, and is recorded.
- **`rewind: step`** keeps the **same attempt** and moves its cursor back to an earlier step.
  - It applies when the attempt is blocked, or when the running step finishes.
  - Outputs at and after the target are superseded for this pass; they stay on the ledger.
  - Loop iteration counts and loop carries are **not** reset.
  - Recorded as `attemptRewound`.
  - This replaces the parent's `restart`, which cancelled the attempt and so reset every per-attempt bound. That was the hole the adversary's grant scenario named.
- **`enter: state`** cancels the open attempt, with outcome `cancelled` (never a failure), and moves the unit to the state. Scenario 2's "customer replied while awaiting approval" is `enter: New`.
- **`at: [steps]`** gates `rewind` and `enter` to typed step names. Outside those steps, only `update` applies, recorded with `gatedAtStep`.
- **Signals with no open unit.** A signal to a key with no open unit is recorded as `signalSkipped`.

## Loops with a carry (scenario 1's deficit feed; the grant scenario)

A loop may declare a **carry**: a typed value handed from one round to the next.

```
.loop('rounds', { carry: z.object({ deficits: z.array(z.string()) }), initial: { deficits: [] } },
  round => round.step('build', builder, ctx => ({ task: `… fix: ${ctx.steps.rounds.deficits.join('; ')}` }))
                .step('audit', auditor, …),
  { max: ctx => ctx.params.rounds, until: …, next: ctx => ({ deficits: ctx.steps.audit.deficits }) })
```

- **Inside the body,** `ctx.steps.<loop>` is the carry at the start of the round. `next` computes the next carry from the round's outputs.
- **Recording.** Each iteration records `loopIteration` with its carry, so replay and resumption are free.
- **The builder sees the deficits** through typed step state. This closes the parent's lie (an instruction promising deficits the types withheld) without driver session state (principle 1) and without abusing memory (principle 14).
- **`span: 'unit'`** makes the iteration count and the carry persist across the unit's attempts. A new attempt reaching the loop resumes at the recorded count with the recorded carry.
- **The grant scenario** becomes declarable:
  - A loop over `assess`, halt `panel`, with `max: 3` (two returns allowed) and `span: 'unit'`.
  - Its carry accumulates every panel note verbatim, and `assess` prints them.
  - A revision during `panel` reacts with `rewind: 'assess', at: ['panel']`. That is the same attempt, so the count does not reset.
  - A retry after failure is a new attempt, but under `span: 'unit'` the count still does not reset.
  - The flow reads nothing from the ledger and nothing goes into memory.
- **Scenario 11** uses the same construction: counsel returns are bounded with `span: 'unit'`, and a redline at `counsel` rewinds to `draft`.

## Time

- **Timer triggers.** `H.when.timer(lane, { at })` evaluates `at(unit)` when the unit is created and after every `attributesUpdated`.
  - It re-arms **only when the computed deadline changes**. It records `timerSet { reason: 'moved', previousFireAt }`, and the old deadline is cleared and never fires.
  - The timer therefore depends on the value it computes, not on any update touching the unit. This repairs the parent's hidden coupling.
  - A redline that does not change the expiry date re-arms nothing.
  - Scenario 9's SLA extension moves the timer because it changes the deadline the timer reads.
- **`H.when.tick(clock, lane, { in: states })`** fires once per unit in the listed states on each clock tick. The event carries a typed `UnitView` with an entity state.
  - It replaces `sqlite.scan`, whose `StoredUnit.state` was a string.
  - Uses: scenario 3's weekly re-open of recurring topics (`create`, since the old unit is terminal) and scenario 8's monthly tenancy review (`signal`).
- **Halt clocks.** `timeout` and `escalate` run from the recorded `attemptBlocked`, never from unit data.

## Halts

- **Entity and address.**
  - `H.halt(name).decision(schema)` is the entity: the question.
  - `flow.halt(step, halt, options)` is an address where the question is asked. One halt may be asked at several addresses (known weakness 3: two things, two nouns).
- **Resolvers** (recorded in `decisionRecorded.resolvedBy`):
  - `human`, through a client granted `H.ops.resolve(halt)`;
  - `policy`, through `skip: H.policy.halt(...)`, a registered policy whose recorded decision carries every metric read and its sample count;
  - `timeout`, which resolves without cancelling the attempt.
- **`when`** is a flow condition, not a resolver. When it is false, the kernel records `haltNotAsked` and the step output is `D | undefined`.
- **Facets at the address.** `facets` computes typed facet values at the address. The kernel records them and hands them to the skip policy, decision triggers and metrics.
- **Seat-raised halts** move off the seat and onto the step: `SeatStepOptions.halts`.

## Seats, pools, batch (critique 3; known weaknesses 1, 2, 5)

- **The seat keeps only what principle 8 gives it.** `H.seat(name).role(r).model(m | policy).pool(p).output(schema)` is role × model choice × pool, plus its output type.
  - Workspace, guard and raisable halts are properties of a **call**, so they move to `SeatStepOptions` on the step.
  - Batch moves off the seat.
  - A seat with a fixed model is the principle's agent; one noun serves both.
- **Pool and model compatibility is typed** (weakness 5).
  - `Model<D>`, `Account<D>` and `Pool<D>` carry the driver brand that the adapter assigns (`'claude-code'`, `'anthropic'`).
  - `seat.model(m)` narrows the seat to `D`, and `seat.pool(p)` then requires `Pool<D>`.
  - Pairing an anthropic model with a pool of Claude Code subscriptions is now a compile error, not only startup rule 9.
  - A pool belongs to the seat: it is the capacity the seat draws on. It is not a relationship on the model or the account.
- **Batch is a job built from a seat** (weakness 2). `H.batch(name, seat)` returns a `Job<AgentTask[], O[]>` and runs through `flow.job` like any external job.
  - It accepts only a seat whose fixed model is a `BatchModel` (`Seat<O, D, true>`). Adapters mark batch-capable models by returning `BatchModel`.
  - There is one step shape for every submit-and-collect effect: a GPU run, a cloud batch, a long service call. It holds no capacity while it runs.
- **Distinct model policies** (the A/B collapse in scenario 6).
  - `H.policy.model(name, candidates, choose, { distinct: true })` may be shared by several seats.
  - The kernel evaluates them in registration order. `ctx.current` is the seat's last assigned model and `ctx.peers` lists the assignments already made this attempt.
  - An assignment that duplicates a peer's model is refused (`policyRefused`) and the seat keeps its current model. Two reviewers can never collapse onto one model.
  - Because `ctx.current` is the model actually in the seat, the policy measures the **current** series rather than a fixed "incumbent". After a swap, the policy compares the new model and can swap back.
  - The peers come from the context, so the forward-reference thunk the parent needed is gone.

## Entities replacing strings (critique 1; principle 8)

| Before | Now |
|---|---|
| `unit.state === 'X'` | `unit.state === X`, an entity comparison |
| `byState.Name` | `outcomes(...).count(State)` |
| `assignment.seat.name === drafter.name` | `event.modelOf(drafter)` on `StepEvent` and `DecisionEvent`, which looks up by entity |
| Resource lookup by name (`sectionsOf`, `resourcesFor`) | `H.resources('section', ['sports', 'opinion'])`, a `ResourceSet<V>` whose `.of(v)` is typed over `V` |

- **Resource sets.** The external string is parsed once at the supplier boundary into a `z.enum` attribute. From then on, every use is `set.of(attrs.section)`.
- **Facets.** `H.facet('category', values)` is a `Facet<V>`, and `of(v)` is typed over `V`.
  - `PatternEvent.group` and a crossing with `per: facet` carry `FacetValue<V>`.
  - The crossing source has an overload: with `per`, the event always carries `group`. Scenario 9's `value === undefined` guards disappear.
- **`AttemptView.halt`** is a `HaltRef`.

## Metrics

- **Dimensions.** A dimension is a typed column (kind, lane, state, seat, model, resource, halt) or a facet value. A facet named like a column is a startup error.
- **Job hours.** `Metrics.jobs({ job, window })` returns hours in flight clipped to the window, jobs in flight now, and samples. It is computed from `jobSubmitted` and `jobCollected` intervals, so a job running across midnight is split across both days and running jobs are visible. This replaces the step-end `durationMs` approximation.
- **Unchanged:** `decisions` (median per resolver, with samples), `leases` (wait per resource), `paused` (total time and count), and `attempts` and `outcomes` with sample counts.

## Accounts and quota (principle 15)

These are unchanged from the parent.

- **The account names its quota partition.** The `QuotaPartition` is an instance with its own backend, holding append-only events folded at read time, with no cross-harness lock.
- **Harness identity.** The `H.harness` name joins the partition. A second live process under the same name is refused.
- **Share caps** are per harness. `shareUsed` folds only this harness's events, while `utilization` and `cooldownUntil` fold everyone's.
- **Supervisor across harnesses.** `claudeCode.session` names one supervisor session over several harness endpoints.

## Restart

The mechanism is unchanged.

- **Writer claim.** There is a single writer claim with a TTL.
- **Completed steps** replay at zero cost.
- **The running step** follows its `afterCrash`: `rerun`, `park` (unless `alreadyDone` reports true), or `askDriver`.
- **Moved state.** Halts resolved, jobs collected and children finished while the harness was down are read from the ledger.
- **Changed definitions.** A `flowVersion` mismatch parks the attempt as `definitionChanged`.
- **Metrics.** `attemptInterrupted` is excluded from every rate.
- **Loops.** Loop iterations and carries are recorded, so a backfill resumes at its next batch.
- **Rewinds** are recorded, so a rewound attempt replays to its new cursor.

## Entities

- **Kinds** (vocabulary, no backend): work kind, state, signal, role, memory kind, halt, resource, resource set, facet, command, job, flow, operation.
- **Instances** (carry a backend): account, quota partition, model, embedder, runner, workspace, supplier, store, memory store, ledger, client, observer.
- **Kernel suppliers:** `H.clock` and `H.operator`.

**Pivots:**

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store map × flow (exits, params) × retry × lease × order × ceiling × reactions | a consumer of pending units |
| Seat | role × model or model policy × pool | a model-call executable |
| Pool | accounts × shares × drain × fallback | quota-eligible capacity |
| Journal | memory kind × store × recall × reader and recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples or amounts with typed dimensions | a figure with sample counts |
| Scheduler | classes × WIP × aging × admission | demand per lane |
| Harness | all of the above | a running harness, identified by name |

The lane still has many concerns (weakness 6). Each is one setting on one noun, and the alternatives either split the lane into unnamed pivots or move relationships onto the kind, which principle 10 forbids.

## Startup validation (known weakness 9)

`start()` fails, before any supplier starts, on any of:

1. Two descriptors with one name, within an entity sort.
2. A lane with no `retry`, or a `retry.exhausted` state outside the kind.
3. An exit-map state outside the kind, or a flow path that reaches no exit.
4. A missing `initial` state.
5. A lane in no class of service, or in two.
6. An unregistered lane, journal or metric that a trigger, scheduler entry, spawn or WIP group references.
7. A signal routed or triggered into a lane without a reaction. This includes `H.cancel` and the `workCancel` grant.
8. A reaction `at` or `rewind` naming a step the flow lacks, or a `rewind` to a step that does not precede every `at` step.
9. A seat without a pool, or a model whose driver serves no account of its pool. This backs up the compile-time brand.
10. `H.batch` on a driver without `submitBatch`, or `askDriver` on a driver without `session`.
11. A guard the driver cannot `enforce`, or seat-step options on a non-seat step.
12. A grant naming a halt that no flow, step or ceiling uses.
13. A halt policy whose halt or kind differs from its address.
14. A halt timeout not later than its escalation.
15. A crossing over a total metric.
16. A facet or resource set whose name is a column name.
17. `Lane.after` on a kind without a key.
18. One account name bound to two quota partitions.
19. A quota partition refusing this harness name.
20. A trigger `create` into a lane whose store reports `creates: false`, or whose store map lacks the kind's initial state. This covers heartbeat-filed Bugs going into the tracker, which the parent left unchecked.
21. A `distinct` model policy with fewer candidates than seats using it.
22. A loop with `span: 'unit'` inside another loop.

## What changed and why

### Lens changes (GenStage and Broadway)

- **Demand is the scheduler's output,** and it is named and recorded (`demandGranted`). Pause, expedite holds, WIP, capacity and admission are all inputs to one number per lane, rather than separate gates.
- **Supplier acknowledgement is durable.** `emit` resolves after the ledger append.
- **Events are delivered to the open attempt.** `rewind` keeps the attempt, its bounds and its carries. `Reaction.restart`, which cancelled and replaced the attempt, is deleted.
- **Batching is one job shape** (`H.batch`), not a seat method.

### Repairs to the adversary's critiques

1. **Scenario 1 deficits.** Loop carry gives the builder the auditor's deficits, typed and recorded. The parent's "Open" item about loop rounds is closed.
2. **The grant scenario and scenario 11's bound reset.**
   - `rewind` keeps the attempt, so re-entry does not reset a loop count.
   - `span: 'unit'` bounds returns over the unit's life, across retries.
   - The carry holds every panel note verbatim.
3. **Strings for entities.**
   - Entity state in `UnitView`, `outcomes.count(state)` and `modelOf(seat)`.
   - Typed `ResourceSet<V>` and `Facet<V>`.
   - Typed crossing groups and pattern groups.
   - `sqlite.scan` deleted in favour of `H.when.tick`.
4. **Timer re-arm coupling.** Timers re-arm only when their computed deadline changes, and record the old and new times.
5. **The overloaded seat and the A/B collapse.**
   - The seat is cut to role, model, pool and output.
   - Batch moves to `H.batch`, gated by the `BatchModel` type.
   - The pool brand is typed.
   - `distinct` model policies with `current` and `peers` remove both the collapse and the forward thunk.
6. **GPU hours.** `Metrics.jobs` computes interval overlap with the window.
7. **Economy.** The battery will drop `admit` lambdas that no scenario asked for (s8's inconclusive gate, s9's paused gate, s12's GPU cap). `admit` stays for scenario 3's budget. One encoding for "lane first". Scenario 1's shares will be stated deliberately.

### Deletions

- `Seat.batch`, `Seat.workspace`, `Seat.guard`, `Seat.halts`.
- `Reaction.restart`.
- `sqlite.scan` and `StoredUnit` in the sqlite adapter.
- `OutcomeCounts.byState`.
- `StepEvent.seats` and `DecisionEvent.seats`, replaced by `modelOf` and `assignments`.
- `Band.per` as optional, replaced by an overload.
- `CrossingEvent.value?: string` and `PatternEvent.group: string`.

### Additions

- `H.batch`, `H.resources` / `ResourceSet`, `H.when.tick`.
- `Flow.loop` with carry and `span`.
- `Reaction.rewind`, `SeatStepOptions`.
- `Model<D>`, `BatchModel`, `Account<D>`, `Pool<D>`, `claudeCode.apiKey`.
- The `distinct` option and `ModelPolicyCtx.current` / `peers`.
- `Metrics.jobs`, `Store.creates`.
- Ledger events: `demandGranted`, `attemptRewound`, `loopIteration`, `jobCollected`, `policyRefused`, and the `timerSet` reason.

### Open

- **Cross-unit batching** (Broadway's batcher over many units' messages) is not offered; no scenario needs it. A future `lane.batch` would group pending units of one lane into one attempt, which collides with "one attempt is one unit's".
- **Memory capture** still needs an author-written trigger (weakness 10).
- **Resource to glob mapping** for file leases stays in the driver's `leaseFiles` guard (weakness 4).

## Principles broken

None knowingly.

- **Principle 12 and `rewind`.** `rewind` keeps one attempt across an external re-entry. The attempt's outcome is still exactly one of three. A rewind is not an outcome, and it is not counted in any rate.
- **Principle 8 (seats and agents).** A seat with one fixed model is the principle's agent, and no second builder exists.
