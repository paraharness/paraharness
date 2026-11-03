# harness-dsl, durable lens, generation 5 (surface cut)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

This child applies the **surface-cut** operator to its parent (g01-durable-0-2-0-1--2-0-1-0):
- every method the battery never calls is removed;
- every option with a single caller is either removed or argued for below;
- the adversary's three sharpest critiques are each answered.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind. It has a stable id and a `key` from `Kind.key`. At most one non-terminal unit per lane holds a given key.
- **Attempt**: one pass of the lane's flow over a unit.
  - It ends with exactly one outcome: succeeded, failed or cancelled.
  - While open, it is either *running* (holding a slot) or *blocked* (holding nothing). A blocked attempt records what it is blocked on: `decision`, `timer`, `children`, `job` or `recovery`.
- **Step**: a named node of a flow; its name is its address.
  - `step` is the running form. Only a running step holds capacity: slots, WIP, account reservations and leases.
  - `halt`, `wait`, `job` and `spawn` are the blocking forms. They hold nothing.
  - `loop` and `exit` are structure, not steps.
- **Job**: work submitted now and collected later by id.
  - `H.job(name, { submit, collect, pollEveryMinutes })` builds one from two executables.
  - `seat.batch()` is a job whose submit and collect are the model driver's.
  - There is one blocking form for both: `flow.job(name, job, input)`.
- **Invocation**: one call of an executable within a step. A retry, a poll, or a seat's resume after a mid-call halt is a new invocation.

"Run" is not used.

## Entities

**Kinds** (vocabulary, no backend):
- work kind, state, signal, role, memory kind;
- halt, resource, facet;
- command, job, flow, operation.

**Instances** (carry a backend):
- account (names its quota partition), model, embedder, runner, workspace;
- supplier, store, memory store, ledger, quota partition;
- client, supervisor, observer.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store × flow (exit map, params) × retry × reactions × order × ceiling | managed units |
| Seat | role × model or model policy × pool × workspace × guards × raisable halts | a model-call executable, and a metric key that survives a model swap |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader/recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source × facets → samples or amounts | a windowed figure with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

## Lifecycle (principle 12)

**States**
- `H.state(name, 'pending' | 'active' | 'waiting')` declares a non-terminal state.
- `H.terminal(name, verdict)` declares a terminal state. There is no default verdict.
- `Kind.states(initial, ...rest)`: the first argument is the initial state. `Kind.initial` is removed.

**Failure and retry belong to the lane, not the kind**
- The kind declares nothing about failure.
- `Lane.retry({ maxAttempts, backoff, initialDelayMs, exhausted })` is required on every lane.
- A failed attempt leaves the unit at pending until `notBefore`.
- After `maxAttempts` failures, `retryExhausted` moves the unit to `exhausted`, which must be one of the kind's states.
- `retryExhausted` is a ledger fact, so the board shows it and metrics can count it even when `exhausted` names a non-terminal state.

**Positions**
- Only `pending` units are schedulable.
- `waiting` units and blocked attempts hold no capacity.

**Mapping steps and exits to states**
- `during` maps running steps to `active` states and blocking steps to `waiting` states.
- `exits` maps every flow exit to a state. The map must be total.

## Rules

1. **Flows know no states.** One flow serves several lanes with different params, retry policies and maps.
2. **Attempt outcome**
   - **Failure**: a step fails after its step retries, a job polls `failed`, or the exit maps to a `failure` terminal.
   - **Cancellation**: `H.cancel`, a `restart` reaction, or any `enter` reaction while an attempt is open. `cancelledBy` records the signal.
   - **Success**: any other exit.
   - A crash is never an outcome.
3. **Signals**
   - `Lane.on(signal, { update, restart, enter })` declares the lane's reaction.
   - `enter` moves the unit. If an attempt is open, it is first cancelled. This is the parent's Negotiation defect, repaired below.
   - `restart: { to, at }` uses step names typed from the flow. `update` applies at once; the restart happens only when the attempt is blocked at an `at` step.
   - A signal routed to a key with no open unit is recorded as `signalSkipped`.
4. **Routing to units**
   - A router targets either one unit by key, or every open unit in a list of **state entities**: `{ states: [Customer, Upsold] }`.
   - No predicate over a raw state string exists.
5. **Creation deduplicates by key**, recorded as `createSkipped`.
6. **Timers re-arm** after every `attributesUpdated`. An old deadline never fires.
7. **Trigger sources**: `transition`, `pattern`, `timer`, `step`, `decision`, `invocation`, `crossing`. **Consequences**: `create`, `signal`, `record`, `pause`, `resume`. A consequence lambda that returns `undefined` skips that firing; this is the only filter.
8. **Two retry counters.** Step retry makes new invocations; lane retry makes new attempts. They share no counter.
9. **Determinism.** Exit predicates, loop bounds, halt policies, timeouts, and model, account and scheduler choices are each recorded once and replayed.
10. **Leases are step options.**
    - `step(..., { lease: input => ({ resource, mode }) })` takes an exclusive or shared lease on a resource entity while that step runs.
    - Leases are capacity, and only running steps hold capacity.
11. **Order**
    - `Lane.after({ key, held })` keeps a unit unschedulable until the unit with the predecessor key in the same lane reaches a success terminal.
    - If the predecessor reaches any other verdict, the unit moves to `held` (a waiting state) with `orderHeld`, which carries the predecessor's state.
    - If the predecessor later reaches success (for example after recovery and a new attempt), `orderReleased` returns the held unit to its initial state.
12. **Restart**
    - There is one writer claim, with a TTL.
    - Completed steps replay at zero cost.
    - The running step follows its `afterCrash`: `rerun`, `park` (with `alreadyDone`), or `askDriver`.
    - A job with a recorded `jobSubmitted` is collected by id, never resubmitted. A crash before the id is recorded parks the attempt as `submitUnrecorded`.
    - Children are read from the ledger.
    - A `flowVersion` mismatch parks the attempt as `definitionChanged`.
    - Interrupted attempts are excluded from every rate.
    - Loops resume at the first unrecorded iteration.
13. **Memory**
    - Scope takes kinds, roles and resources as entities.
    - Recall matches the attempt's leased resources and its task's `resources`.
    - Ranking is by specificity or similarity, with ties broken by track record.

## Halts (principles 8, 17)

There is one form: `flow.halt(address, haltEntity, { ask, skip?, timeout?, escalate? })`. The address is the step name and the entity is the question, so one question may be asked at several addresses.

**Resolvers**
- **Policy** (`skip`): a registered `H.policy.halt(name, halt, inputSchema, decide)`. It returns a decision, or `undefined` to ask a human. Its input, the metric figures it read and their sample counts are recorded, with `resolvedBy: 'policy'`.
- **Clock** (`timeout`): `{ afterMinutes, decide }` resolves the halt with `resolvedBy: 'timeout'`. The attempt continues.
- **Human**: a client granted `H.ops.resolve(halt)`.
- `askIf` is removed. "Ask only when validation failed" (scenario 5) is a halt policy that resolves `proceed` when validation passed. A deterministic function deciding is exactly what a policy resolver is, and the decision is recorded rather than silently skipped. `haltSkipped` is removed with it.

**Timing**
- All clocks run from the recorded `attemptBlocked`.
- `escalate` runs an executable once, at `afterMinutes`.
- Whoever is paged must also hold a client granted `resolve(halt)` (scenario 11: a deputy client on the same supervisor transport). Startup checks that an escalated halt is granted to at least one client.

**Ceilings and bounds**
- The cost ceiling (`Lane.ceiling`) takes either `'fail'` or a halt whose decision is a `CeilingDecision`.
- Return bounds are `loop({ max })`. The kernel counts iterations; the flow counts nothing.

## Seats and model choice

- `.model(model)` fixes one model.
- `.model(H.policy.model(name, candidates, choose))` picks a model per attempt and records the choice with every figure read.
- Invocations record `seat` and `model` as columns, so a model swap continues the seat's series.
- The policy context carries `seat` and **`peers`**: the other seats in this harness that hold the same role.
  - An A/B comparison is therefore written once and serves any number of seats.
  - It reads `metrics.rate(m, { by: { seat } })` against each peer. It never names a seat by string and never refers forward to one.
  - Per-seat incumbents come from a small factory in the scenario (`reviewerPolicy(opus)`), not from identity tests inside the policy.

## Metrics, columns, facets (principle 18)

- `Dims` holds the typed columns as entities, plus `facets`.
- A facet named after a column is rejected at compile time and at startup.
- Built-in queries are `outcomes`, `attempts`, `paused`, `decisions` and `leases`. Every figure carries `samples`.
- Median time to decision per resolver lives in `decisions().byResolver`, so `DecisionEvent` no longer repeats `waitedMs` and `resolver`.

## Accounts and shared quota (principle 15)

- Every account names its `QuotaPartition`. The ledger has no quota option.
- Harnesses that import the same account write to the same partition. Each appends its own events, stamped with the harness name, and folds the window at read time. No lock is taken.
- `register(harness, ledgerId)` refuses a second ledger under the same harness name.
- `claudeCode.supervisor(name).client(...)` gives one operator session one client per harness.

## Control API grants

Grants are operations, and the per-entity grants name the entity:
- `resolve(halt)` and `signal(signal)` name the halt or signal they cover.
- `workUpdate`, `workCancel`, `workSignal` and `lanesPause` are removed.
- Every outside change to a unit goes through a declared lane reaction, granted per signal. Cancel is `H.ops.signal(H.cancel)`, and an SLA extension is `H.ops.signal(slaExtended)`.

The remaining fixed grants are:
- `workRead`, `workCreate`, `attemptsRecover`;
- `memoryRead`, `memoryWrite`, `memoryCurate`;
- `telemetryRead`, `accountsRead`, `accountsShare`.

## Startup validation

`start()` fails, naming the offending descriptor, on any of the following.

**Names**
- Two descriptors of one sort share a name.
- A facet is named after a column.

**Lanes and flows**
- A lane has no `retry`.
- A lane's `exits` map is not total.
- A flow has a path without an exit.
- `after` is declared on a lane whose kind has no key.
- A `spawn` targets a lane the harness does not register.

**Signals**
- A signal is routed, triggered or granted toward a lane without a reaction for it. This includes `H.cancel`.
- `ops.signal(s)` is granted for a signal no registered lane reacts to.

**Seats and models**
- A seat lacks a role, model or pool.
- A model's driver serves no account in the seat's pool.
- A guard is declared that the driver cannot `enforce`.
- `seat.batch()` is used on a driver without `submitBatch`.
- `askDriver` is declared on a driver without `session`.

**Halts**
- A used halt has no resolver.
- `resolve(halt)` is granted for a halt that is never used.
- A halt policy is attached to a halt other than its own.
- An escalation is not earlier than its timeout.
- An escalated halt has no granted client.

**Metrics and triggers**
- A crossing is declared over a total metric.
- A trigger, metric, scheduler or observer references a lane, journal or metric that is not registered.

**Quota**
- A quota partition refuses `register`.

## What changed and why

### Surface cut (operator)

Removed because the battery never calls them, or because one call site expresses the same thing without them:

| Removed | Replaced by |
|---|---|
| `Kind.initial` | First argument of `states` |
| `Runner.preflight` (one caller, scenario 4) | An ordinary `step('preflight', diskSpace)` before `backup`. A preflight is a step; a second mechanism was a synonym. |
| `H.nextTime` (one caller) | Scenario 5 computes 09:00 from `unit.createdAt`, since the unit is created by the 02:00 clock |
| `H.jobPoll` | A collect command's output schema is any object matching `JobPoll`; `H.job` infers the result type from it |
| Batch overload of `Flow.step`, `Batch` type, `batchSubmitted`, `'batch'` block reason | `flow.job` + `seat.batch(): Job` |
| `askIf`, the second `halt` overload, `haltSkipped` | Halt policy |
| `Lane.lease` | Step option `lease` |
| Transition and step source `if` filters | Consequences return `undefined` to skip. The `transition` filter object becomes the required `to` argument. |
| `H.when.invocation({ lanes })` | Variadic `invocation(...lanes)` |
| `timer(lane, { at })` | `timer(lane, at)` |
| `FlowCtx.metrics`, `FlowCtx.now` | Removed: flows read no ledger state, as scenario 10 requires |
| `UnitView.costUsd`, `.attempts`, `.failedAttempts` | Kept only on the kernel `UnitRecord` |
| `AttemptView.number`, `.startedAt` | Removed |
| `DecisionEvent.resolver`, `.waitedMs` | `Metrics.decisions().byResolver` |
| `InvocationEvent.seat` | Removed |
| `ops.workUpdate`, `workCancel`, `workSignal`, `lanesPause` | `ops.signal(signal)` |
| `linear.issues` optional `labels` | Required: every caller passes it |

Kept, though each has a single caller, because a scenario requires it and no other surface expresses it:

| Kept | Scenario |
|---|---|
| `wait` | 8, Experiment hourly |
| `timeout`, `escalate` | 11 |
| `after` | 12 |
| `pattern` | 4 |
| `crossing`, `pause`, `resume` | 9 |

### Critique 1: the lane is overloaded, and order is keyed by string

- **Lane load.** The lane loses `lease`, which moves to the step that holds capacity. What remains is what principles 8, 12 and 13 put there:
  - principle 8 (lane = kind × suppliers × store × handler): `supply`, `store`, `handler`;
  - principle 12 (retry and exhaustion live on the lane): `retry`;
  - principle 13 (triggers act on lanes): `on`;
  - unit-scoped: `ceiling` and `after`.
  - Each is one concept; none duplicates another.
- **`after` keys are not strings standing in for entities.**
  - Principle 8 forbids strings standing in for *kinds* (resources, halts and the like). A unit is not a kind. Its key is its identity value, the same value `Kind.key` declares and creation dedups on.
  - The predecessor is looked up in the same lane only.
- **Cross-database coupling** was a scenario bug. Scenario 12 now derives `previous` from the file numbering within one database.
- **Release path.** The new `orderReleased` rule returns a held migration to its initial state when its predecessor later succeeds.

### Critique 2: model policy by seat-name string, with a forward reference

`PolicyCtx.peers` gives the policy the other seats of the same role, so:
- scenario 6 builds one policy per incumbent with a factory;
- the policy compares the seat's series against its peers' series;
- it swaps to the challenger after 50 samples;
- a third reviewer is one more seat line;
- no string compare or forward reference remains.

### Critique 3: two meanings, two spellings

- **Batch versus job**: unified (see above).
- **`askIf` versus `skip`**: unified into the policy resolver.
- **The paged deputy could not act**: there is now an explicit rule and a startup check. Scenario 11 adds a deputy client on the Claude Code transport, granted `resolve(signoff)`.
- **Strings in kernel types.**
  - The DSL-side `UnitView` moves to `h.d.ts` and carries entities: `kind`, `lane` and `state` are `WorkRef`, `WorkRef` and `State`.
  - The kernel's `UnitRecord`, `MemoryItem.when` (`StoredScope`) and `LedgerEvent` carry names, because they cross the backend boundary and are serialized. Principle 5 keeps the kernel's storage indifferent to the DSL's object graph.
  - The rule is: entities above the boundary, names below.
- **"Exit" means two things.** We disagree that it does.
  - An exit is always flow-side: "this attempt ends here". The map says where the unit then stands, and the state's position says whether the unit is done.
  - Attempt success for `offered → AwaitingVendor` is intended: principle 12 keeps the attempt's track record separate from the kind's outcome rate. "Agreed" is answered by `outcomes(Negotiation).byState`.

### Scenario 8 (worst scenario)

- **Negotiation.**
  - `enter` now cancels an open attempt, so a counter mid-draft can no longer leave a schedulable unit holding a slot.
  - Exhaustion goes to a `Stalled` waiting state, which the operator leaves by `ops.signal(resume)` (a declared reaction) rather than dead-ending.
- **Tenancy.**
  - The upsell decision maps to a distinct waiting state (`Upsold`); hold maps to `Customer`.
  - Exhaustion maps to `ReviewFailed` (waiting), and `retryExhausted` is a ledger fact.
  - The monthly signal routes to `{ states: [Customer, Upsold, ReviewFailed] }` by entity.

### Scenario 1

The dead `decomposeEpic` flow and its unregistered placeholder lane are deleted. Startup now rejects a `spawn` toward an unregistered lane.

### Open

- **Reopened work** (the adversary's scenario 13: a terminal state that is not final, with a retroactive verdict) is not expressible. No battery scenario requires it, so this surface-cut child adds no surface for it.
- **Skills remain strings** in memory scope.

## Principles broken

None knowingly.
