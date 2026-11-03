# harness-dsl, durable lens, generation 5 (scenario-fix: lifecycles that do not fit)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

This child targets scenario 8, which the parent handled worst. In the parent:
- Tenancy hid its failures.
- Tenancy collapsed two human decisions into one state.
- Negotiation moved a unit to pending under a running attempt.

The child also answers the adversary's three sharpest critiques:
- lane ordering by string key;
- the A/B model policy branching on seat names;
- "exit" meaning two things, plus two spellings each of submit-and-collect and halt bypass, and a deputy who could be paged but never act.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind, with a stable id and a `key` from `Kind.key`. At most one non-terminal unit per lane holds a given key.
- **Attempt**: one pass of the lane's flow over a unit.
  - It ends with exactly one outcome: succeeded, failed or cancelled.
  - The attempt records the **exit** it took, if any.
  - While open, an attempt is *running* (holding a slot) or *blocked* (holding nothing).
  - A blocked attempt records what it waits on: `decision`, `timer`, `children`, `job` or `recovery`.
- **Step**: a named node of a flow. The name is its address.
  - *Running* steps (`step`) hold capacity.
  - *Blocking* steps (`job`, `halt`, `wait`, `spawn`) hold none.
  - `loop` and `exit` are structure, not steps.
- **Exit**: the named end of one attempt's flow. It is never a unit state.
  - The lane maps each exit to the **rest state** the unit lands in, which is any state that is not `active`.
  - A rest state is terminal (the unit is done) or pending/waiting (the unit sleeps until a signal or the scheduler).
  - The exit says where the *attempt* ended. The state says where the *unit* is.
- **Invocation**: one call of an executable within a step. A step retry, a job poll, and a seat's resume after a mid-call halt are each a new invocation.
- **Job**: a submit-and-collect effect. It is the only blocking effect form. A seat's `batch()` is a job.

"Run" is not used.

## Entities

**Kinds** (vocabulary, no backend):
- work kind, state, signal, role, memory kind;
- halt, resource, facet;
- command, job, flow, operation.

**Instances** (carry a backend, built in subpaths):
- account (names its quota partition), quota partition;
- model, embedder, runner, workspace;
- supplier, store, memory store, ledger;
- client, supervisor, observer.

`H.clock` and `H.operator` are kernel suppliers.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store × flow (exit map, params) × retry; optional lease, order, reactions, ceiling | managed units |
| Seat | role × model or model policy × pool × workspace × guards × halts it may raise | a model-call executable, and a metric key that survives a model swap |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader/recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source × facets → samples (rate) or amounts (total) | a windowed figure with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

## Lifecycle (principle 12)

**States.**
- `H.state(name, 'pending' | 'active' | 'waiting')` declares a non-terminal state.
- `H.terminal(name, verdict)` declares a terminal state. The verdict has no default.
- A kind declares only its attributes, states, key and `initial`. It declares nothing about failure or cancellation.

**Exits.** `handler(flow, { exits, during })`.
- `exits` maps each flow exit to a rest state, and the map is total. The `RestState<S>` type rejects mapping an exit to an `active` state at compile time.
- `during` maps running steps to `active` states and blocking steps to `waiting` states.

**Retry.** `Lane.retry({ maxAttempts, backoff, initialDelayMs, exhausted })` is required on every lane.
- A failed attempt leaves the unit at pending with `retryScheduled.notBefore`.
- After `maxAttempts` failures, `retryExhausted` moves the unit to `exhausted`, a rest state of the kind.
- Exhaustion is always a recorded fact. It appears as `AttemptCounts.exhausted` and as a `transition` with `cause: 'retryExhausted'`, so the board and every metric can tell "landed here by exhaustion" from "landed here by exit". This holds even when `exhausted` is non-terminal.

**Outcomes.**
- Failure:
  - a step fails after its step retries;
  - a job polls `failed`;
  - an exit maps to a `failure` terminal.
- Cancellation:
  - an interrupting reaction;
  - a reaction entering a terminal state;
  - an operator `workCancel`.
- Success: any other exit.
- A crash is never an outcome.
- The **attempt** success rate answers "did the pass do its job". The **kind** success rate (`outcomes`) answers "how did units end", and it is defined only by terminal verdicts. `AttemptCounts.byExit` (typed by the lane's exit names) separates "offered" from "agreed" within succeeded attempts.

**Positions.** Only `pending` units are schedulable. `waiting` units and blocked attempts hold no capacity.

## Reactions (signals into units)

`Lane.on(signal, { update?, restart?, enter?, interrupt? })`.

- **`update`** applies to attributes at once. Timers re-arm.
- **`restart: { to, at }`** restarts the open attempt at step `to` once it blocks at one of the `at` steps. Step names are typed from the flow.
- **`enter: state`** moves the unit to a rest state. The type rejects `active` targets. How it applies depends on the unit:
  - **No open attempt:** applies now.
  - **Open attempt, terminal target:** cancels the attempt and enters.
  - **Open attempt, non-terminal target, `interrupt: true`:** cancels the attempt and enters.
  - **Open attempt, non-terminal target, otherwise:** **deferred** and recorded as `reactionDeferred`. When the attempt ends:
    - if the attempt's landing is non-terminal (a rest exit or a scheduled retry), the deferred state replaces it, and retry counters are kept;
    - if the landing is terminal, the deferred enter is dropped as `reactionDropped`.
  - No path leaves a unit pending while its attempt holds a slot. This closes the parent's Negotiation position lie.
- **Targets.** Routers and triggers target a unit by its `key` (the domain identity the supplier sees) or by `{ inState: State | State[] }`. They never use a raw state string.
- **Unrouted signals.** A signal to a key with no open unit is recorded as `signalSkipped`.
- **Cancel.** `H.cancel` is a signal. A lane that can be cancelled declares `on(H.cancel, { enter })`.

### Scenario 8, as the child expresses it

**Tenancy.**
- States:
  - `ReviewDue` (pending);
  - `Reviewing` (active);
  - `AwaitingUpsellDecision` (waiting);
  - `Upsold` and `Retained` (waiting; two rest states, one per human decision);
  - `ReviewStalled` (waiting; the retry-exhaustion state);
  - `Suspended` (waiting);
  - `Churned` (terminal neutral).
- The monthly clock signals `{ inState: [Upsold, Retained, ReviewStalled] }` with `enter: ReviewDue`.
- Suspend uses `interrupt: true`, so a review in flight is cancelled.
- "How often do we upsell" is `metrics.attempts({ of: tenancies }).byExit.upsell`, with `samples`.
- "How often did reviews break" is `exhausted`.
- A tenancy between evaluations is `waiting`, so it holds no capacity.

**Negotiation.**
- Each attempt is one round.
- `offered` lands in `AwaitingVendor` (waiting).
- The vendor counter reaction is `update` plus `enter: Countering` (pending):
  - while resting at `AwaitingVendor`, it applies now;
  - while a round runs, it is deferred and becomes the round's landing.
- Vendor acceptance and vendor walk-away are terminal enters, which cancel any round in flight.
- Expiry is a timer trigger signalling a terminal enter.
- Exhaustion lands in `NegotiationBroken`, a failure terminal. It is not a dead-end waiting state.

**Experiment.** `AWins`, `BWins` and `Inconclusive` are terminal. Inconclusive has a neutral verdict. `outcomes(...).byState.Inconclusive` answers "how often are experiments inconclusive?" with `samples`.

## Seats and model policies (principle 8)

```ts
H.seat('builder').role(builderRole).model(builderPolicy).pool(subscriptions)
  .workspace(git.worktree(...)).guard({ leaseFiles: true, beforeStop: checks }).halts(ownerDecision)
```

- A seat is role × model-or-policy. A seat with one model is what principle 8 calls an agent; there is no separate agent noun.
- **The seat is the metric key.** Invocations record `seat` and `model` as columns, so a model swap continues the series.
- **Policy context.** `H.policy.model(name, candidates, choose)` receives `PolicyCtx`:
  - `{ kind, seat, metrics }`, as before;
  - **`peers`**: every other registered seat with the same role;
  - **`current`**: the model this seat last ran, read from the ledger.
- **A/B as a policy factory.** An A/B comparison is a plain function returning a policy per incumbent, e.g. `swapWhenBehind(name, incumbent, challenger)`. Each policy compares `seat` against `peers` and never names another seat. A third reviewer is one more seat of the same role and needs no policy change.
- **Recorded choice.** Every choice is a `policyDecision` with each metric figure it read and its sample count.

## Jobs (one submit-and-collect form; known weakness 2)

- **Declaring a job.** `H.job(name, { submit, collect, pollEveryMinutes })` declares a job from two executables. `submit` returns a `JobHandle`; `collect` returns a `JobPoll<O>`.
- **Batches are jobs.** `seat.batch({ pollEveryMinutes })` returns `Job<Task[], O[]>`. Its submit and collect are the driver's `submitBatch` and `pollBatch`. Its invocations carry `batch: true`, so telemetry prices them at the batch rate.
- **In a flow.** `flow.job(name, job, input, options?)` is a blocking step.
  - `jobSubmitted` records the id. On restart, the kernel collects by that id and never resubmits.
  - A submit interrupted before its id was recorded follows `afterCrash`, which defaults to `park`.
  - A remote failure is an attempt failure. A crash is never an outcome.
- The parent's `step(seat.batch())` overload is deleted.

## Halts (principles 8, 17)

One form: `flow.halt(address, haltEntity, { ask, skip?, timeout?, escalate? })`.

- **Address versus entity.** The step name is the address; the halt entity is the question.
- **Policy resolver.** `skip: { by: H.policy.halt(name, halt, inputSchema, decide), input }` registers a policy that may resolve the halt. It returns a decision or `undefined` (ask the human). The decision is recorded as `resolvedBy: 'policy'`, with its input, the metrics it read and their sample counts.
- **One bypass.** The parent's `askIf` is deleted.
  - Scenario 5's "ask only when validation failed" becomes the policy `validation-passed-proceeds`. It returns `{ proceed: true }` when validation passed, so the decision is recorded and the halt's output type is `D`, never `D | undefined`.
  - Bypass now has one mechanism and one ledger event.
- **Clock resolver.** `timeout: { afterMinutes, decide }` resolves the halt as `resolvedBy: 'timeout'`. The attempt continues; nothing is cancelled.
- **Escalation.** `escalate: { afterMinutes, run }` runs once and records `haltEscalated`.
- **Clocks.** Every clock runs from the recorded `attemptBlocked`.
- **Human resolvers.** Only a client holding `H.ops.resolve(halt)` resolves that halt.
  - **The deputy** is a client holding `H.ops.resolve(signoff, { onceEscalated: true })`. That client may resolve only after `haltEscalated` is recorded for that halt instance.
  - In scenario 11, finance holds the plain grant and the deputy holds the escalated grant, so either may resolve after minute 20.
- **Bounded returns** are `loop({ max })`. The kernel counts iterations; the flow counts nothing.
- **Cost ceiling.** `Lane.ceiling({ maxUsd, onExceed })` takes `'fail'` or a halt whose decision is a `CeilingDecision`.

## Ordering and leases

**Order.** `Lane.order({ within?, sequence, from, held })` replaces the parent's `after({ key })`. No unit points at another by a string.
- Units are ordered by the numeric `sequence` of their attributes. When `within` is given, the order holds only inside the group its resource defines, so `users` migrations never wait on `orders` migrations.
- A unit whose sequence is above `from` is schedulable only when the unit with the next-lower sequence in its group has reached a success terminal.
- Until then the kernel holds it in `held`, a waiting state, and records `orderHeld` with a reason:
  - `predecessorOpen`;
  - `predecessorMissing` (not yet supplied, whatever the folder order);
  - `predecessorFailed`.
- When the predecessor succeeds, including after the supervisor recovers it, the kernel records `orderReleased` and moves the unit to the kind's `initial` state.

**Leases.** `Lane.lease(unit => ({ resource, mode }))` takes an exclusive or shared lease on a resource entity for the attempt's running time.

## Metrics, columns and facets (principle 18)

- **Samples and dimensions.** A sample is `{ hit, by? }` and an amount is `{ amount, by? }`. `Dims` holds the typed columns as entities, plus declared facets.
- **Facets.** A facet named after a column is a compile error and a startup error.
- **Built-in queries:**
  - `outcomes`: terminal verdicts, `byState`;
  - `attempts`: succeeded, failed, cancelled, retried, exhausted, `byExit`;
  - `paused`;
  - `decisions`: per halt, per resolver, with medians;
  - `leases`: lock wait times.
- Every figure carries `samples`.
- `UnitView.kind` and `UnitView.lane` are now entity refs, not strings.

## Memory scope at the backend boundary

- `Scope` in the DSL takes entities. Skills remain strings, because principle 14 lists skills in the envelope and principle 8 defines no skill entity.
- `MemoryItem.when` in `kernel.d.ts` is a `ScopeRecord` of names, because a memory store holds data and entities are code.
- At start, the kernel resolves every name to a registered entity. An item naming none is reported as `memoryOrphaned`. Such an item is never matched by an accidental same-named string.

## Accounts and shared quota (principle 15, scenario 7)

- **The account names its partition.** It names its `QuotaPartition` at construction. The ledger carries no quota option.
- **Sharing.** Harnesses importing the same account append their own events to that partition and fold the window at read time. There is no lock.
- **Harness identity.** `register(harness, ledgerId)` refuses a second ledger under one harness name.
- **One operator, two endpoints.** `claudeCode.supervisor(name).client(...)` gives one operator session one client per harness.

## Rules

1. **Flows know no states.** One flow serves several lanes with different params, retry policies and exit maps.
2. **Creation deduplicates by key**, recorded as `createSkipped`.
3. **Timers re-arm** after every `attributesUpdated`. An old deadline never fires.
4. **Trigger sources:** `transition`, `pattern`, `timer`, `step`, `decision`, `invocation`, `crossing`.
5. **Trigger consequences:** `create`, `signal`, `record`, `pause`, `resume`. A lambda returning `undefined` skips that firing, and every firing is recorded.
6. **Two retry counters.** Step retry makes invocations; lane retry makes attempts.
7. **Determinism.** Exit predicates, loop bounds, halt policies, timeouts, model, account and scheduler choices are each recorded once and replayed.
8. **Capacity.** Only running attempts hold slots, WIP, leases and account reservations.
9. **Restart.**
   - There is one writer claim with a TTL.
   - Completed steps replay at zero cost.
   - The running step follows its `afterCrash`: `rerun`, `park` (with `alreadyDone`), or `askDriver`.
   - Jobs are collected by recorded id.
   - Children are read from the ledger.
   - A `flowVersion` mismatch parks the attempt as `definitionChanged`.
   - Interrupted attempts are excluded from every rate.
   - Loops resume at the first unrecorded iteration.
   - A deferred enter is ledger state, so it survives a restart.

## Startup validation

`start()` fails, naming the offending descriptor, on any of the following.

**Names and facets**
- Two descriptors of one sort share a name.
- A facet is named after a column.

**Lanes and flows**
- A lane has no `retry`.
- A lane's exit map is not total.
- A flow path has no exit.
- A `spawn`, trigger, metric, scheduler or observer references a lane, journal or metric the harness does not register.

**Order**
- Two units of one order group claim one sequence; the second is held with `predecessorOpen` and reported.

**Signals**
- A signal is routed or triggered toward a lane without a reaction for it.
- `workCancel` is granted, or `H.cancel` is signalled, toward a lane without `on(H.cancel)`.

**Seats and models**
- A seat lacks a role, model or pool.
- A model's driver serves no account in the seat's pool.
- A guard is declared that the driver cannot `enforce`.
- `seat.batch()` is used on a driver without `submitBatch` or `pollBatch`.
- `askDriver` is used on a driver without `session`.

**Halts**
- A used halt has no resolver.
- `resolve(halt)` is granted for an unused halt.
- `resolve(halt, { onceEscalated })` is granted for a halt no flow escalates.
- A halt policy is attached to a halt other than its own.
- A timeout is not later than its escalation.

**Metrics and quota**
- A crossing is declared over a total metric.
- A quota partition refuses `register`.

## What changed and why

### Scenario 8, the operator's target

- **Exhaustion is a recorded fact, not a silent landing.**
  - `transition.cause` and `AttemptCounts.exhausted` make exhaustion visible.
  - Tenancy now exhausts into `ReviewStalled`, which the monthly review lifts.
  - Negotiation exhausts into a failure terminal.
- **One decision per state.** Tenancy's upsell and hold decisions land in distinct rest states. `byExit` is typed from the lane, so a policy reads `byExit.upsell` with no hand-written metric.
- **Signal targets are entities.** `Router.signal` takes `{ inState }` with state entities. The parent's `unit => unit.state === 'Customer'` is gone.
- **No pending unit under a running attempt.**
  - A non-terminal `enter` during an open attempt is deferred (or interrupts, if the lane says so).
  - `enter` and `exits` are typed `RestState`, so neither can target an `active` state.
- **Scenario 1's placeholder lane is gone.** `spawn` into an unregistered lane is now a startup error.

### Critique 1: the lane, and ordering by string key

- **Ordering.** `after({ key: a => a.previous })` is replaced by `order({ within, sequence, from, held })`. The predecessor is found by numeric sequence inside a resource group, so there is no string pointer and no cross-database coupling. `orderReleased` gives the held state its missing release path.
- **The lane's concerns.** We argue the lane is not overloaded, though it is the widest pivot.
  - Its required parts are the principle-8 pivot plus retry, which principle 12 puts on the lane.
  - Lease, order, ceiling and reactions are optional. Each is something *this lane* does with *its* units, and none is reachable from another pivot without inventing a noun with one use (principle 21).
  - Moving `order` to the scheduler was rejected. A held unit must be at `waiting` with a state of its kind, and the scheduler moves no unit states.

### Critique 2: seat-identity branching in the A/B policy

- `PolicyCtx` gains `peers` and `current`.
- Scenario 6 builds one policy per reviewer from a factory, each with its own incumbent and challenger. There is no `seat.name ===`, no forward reference, and adding a seat adds a peer.

### Critique 3: two meanings, two spellings, the stranded deputy

- **Exit.** An exit is the end of an attempt, and only that. The lane maps it to a rest state. `RestState` typing makes the "terminal or sleeping" split explicit, and `byExit` separates offered from agreed in the attempt record.
- **Batch and job.** One `Job` entity, one `flow.job` step, one `jobSubmitted` event with `via`. `BlockReason` loses `batch`.
- **`askIf` versus `skip`.** `askIf` and `haltSkipped` are deleted; the policy resolver is the only bypass.
- **Deputy.** `H.ops.resolve(halt, { onceEscalated: true })`. The deputy is a client whose right begins at the recorded escalation.
- **Strings for entities.** `UnitView.kind` and `UnitView.lane` are refs. Memory scope records keep names at the store boundary, and the kernel resolves them at startup with `memoryOrphaned` (see "Memory scope at the backend boundary").

### Not taken: reopened work (the adversary's proposed scenario 13)

The case is outside the battery, so adding a `reopen` reaction would be an unused method (principle 21). It is also ruled out by principle 12 as written, where terminal is terminal.

The path, if it is ruled in:
- a `reopen` reaction legal only on terminal units;
- a `verdictRevoked` ledger event;
- `outcomes` gaining a `revoked` count.

Until then, a reopened Bug is a new unit, and a trigger can record the relation.

### Smaller

- `ModelDriver.collectBatch` becomes `pollBatch`, returning a status, so driver jobs and command jobs poll alike.
- `GrantRecord` replaces capability strings at the client boundary.
- `UnitRecord.row` replaces `view`. The kernel builds the `UnitView` with entity refs.

## Principles broken

None knowingly.
