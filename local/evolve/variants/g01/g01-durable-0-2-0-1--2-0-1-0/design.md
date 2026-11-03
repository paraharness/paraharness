# harness-dsl, durable lens, generation 4 (delete: Agent)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

This child deletes the **Agent** entity (`H.agent`, `Agent<O>`, `AgentTask`). The **Seat** replaces it as the only model-call pivot: role × models × choice policy. A seat with one model is what principle 8 calls an agent. "Agent" survives as a description, not as a noun in the DSL.

The child also answers the parent's three named defects and its scenario-7 failure (see "What changed and why").

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind. It has a stable id and a `key` (from `Kind.key`). At most one non-terminal unit per lane holds a given key.
- **Attempt**: one pass of the lane's flow over a unit.
  - It ends with exactly one outcome: succeeded, failed or cancelled.
  - While open, it is either *running* (holding a slot) or *blocked* (holding nothing).
  - A blocked attempt records what it is blocked on: `decision`, `timer`, `children`, `batch`, `job` or `recovery`.
- **Step**: a named node of a flow, which is its address.
  - *Running* steps (`step`) hold capacity.
  - *Blocking* steps (`halt`, `wait`, `spawn`, `job`, and a `step` whose executable is a `seat.batch()`) hold none.
  - `loop` and `exit` are structure, not steps.
- **Invocation**: one call of an executable within a step. A retry, a poll, or a seat's mid-call halt resume is a new invocation.

"Run" is not used.

## Entities

**Kinds** (vocabulary, no backend):
- work kind, state, signal, role, memory kind;
- **halt** (`H.halt(name).decision(schema)`);
- **resource** (`H.resource(name)`);
- **facet** (`H.facet(name)`, a declared metric dimension);
- command, flow, operation.

**Instances** (carry a backend, built in subpaths):
- account, which names its **quota partition**;
- model, embedder, runner, workspace, supplier, store, memory store, ledger, client, observer;
- **quota partition** (`sqlite.quota(...)`);
- **supervisor**: one operator session that yields one client per harness (`claudeCode.supervisor(name).client(...)`).
- `H.clock` and `H.operator` are kernel suppliers.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store × flow (exit map, params) × retry × lease × order × reactions | managed units |
| Seat | role × model or model policy × pool × workspace × guards × halts it may raise | a model-call executable, and a metric key that survives a model swap |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader/recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source × facets → samples (rate) or amounts (total) | a windowed figure with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

## Lifecycle (principle 12)

- **States.**
  - `H.state(name, 'pending' | 'active' | 'waiting')` declares a non-terminal state.
  - `H.terminal(name, verdict)` declares a terminal state. The verdict has no default.
- **The kind declares only** its attributes, states, key and `initial`. It declares nothing about failure and nothing about cancellation (`onAttemptFailed` and `onCancelled` are removed).
- **Retry and exhaustion belong to the lane.**
  - `Lane.retry({ maxAttempts, backoff, initialDelayMs, exhausted })` is required on every lane; its absence is a startup error.
  - A failed attempt leaves the unit at pending. `retryScheduled` records `notBefore`, and the scheduler waits for it.
  - After `maxAttempts` failed attempts, `retryExhausted` moves the unit to `exhausted`, a state of the kind named by the lane.
  - A probe that should never retry declares `maxAttempts: 1`.
- **Cancellation is a reaction.**
  - `H.cancel` is a signal like any other.
  - A lane that can be cancelled (operator `workCancel`, or a trigger signalling `H.cancel`) declares `.on(H.cancel, { enter })`; a missing reaction is a startup error.
- **Mapping steps to states.**
  - Lanes map flow exits to states, and the map is total.
  - `during` maps running steps to `active` states and blocking steps to `waiting` states.
- **Positions.** Only `pending` units are schedulable. `waiting` units and blocked attempts hold no capacity.

## Seats (principle 8; replaces Agent)

```ts
H.seat('builder').role(builderRole).model(builderPolicy).pool(subscriptions)
  .workspace(git.worktree(...)).guard({ leaseFiles: true, beforeStop: checks }).halts(ownerDecision)
```

- **One model or a policy.** `.model(model)` fixes the model. `.model(H.policy.model(name, candidates, choose))` picks one per attempt.
- **Recorded choice.** The choice is recorded as a `policyDecision` with every metric figure it read, and its context includes the seat.
- **The seat is the metric key.**
  - Invocations record `seat` and `model` as columns.
  - `Metrics.attempts({ of, seat, model })` and `Dims.seat` key on the seat.
  - A model swap therefore continues the same series. Filtering by `model` as well splits it on purpose.
- **Mid-call halts.** `.halts(...halts)` names the questions a seat may raise mid-call. The driver receives their decision schemas, and a raised halt blocks the attempt at the running step. The Intent `'halt'` is gone: the capability is the named halt.
- **Two seats, one role.** Two seats may share a role and differ in model (scenario 6).

## Halts (principles 8, 17)

One form only: `flow.halt(address, haltEntity, options)`.
- **Address versus entity.** The step name is the address; the entity is the question. One question may be asked at several addresses.
- **Options:**
  - `ask` is the text put to the resolver.
  - `askIf` asks only when a predicate holds. Otherwise the step records `haltSkipped` and its output is `undefined`, typed as `D | undefined`. This is not a resolution: nobody decided anything.
  - `skip: { by: H.policy.halt(name, halt, inputSchema, decide), input: ctx => ... }` makes the policy a resolver. The policy is registered, its typed input comes from the flow, and its decision is recorded with that input, the metric figures it read and their sample counts. `resolvedBy: 'policy'`.
  - `timeout: { afterMinutes, decide }` makes the clock a resolver. The attempt continues and nothing is cancelled. `resolvedBy: 'timeout'`.
  - `escalate: { afterMinutes, run }` invokes an executable once.
- **Clocks.** All clocks run from the recorded `attemptBlocked` event.
- **Human resolution.** Only a client holding `H.ops.resolve(halt)` can resolve that halt. The capability-wide `blockersResolve` grant is removed.
- **Cost ceiling.** `Lane.ceiling({ maxUsd, onExceed })` takes either `'fail'` or a halt whose decision is a `CeilingDecision`. The ceiling halt is an entity like any other.
- **Bounded returns.** A return bound is `loop({ max })`. The kernel counts the iterations; the flow counts nothing.

## Metrics, columns and facets (principle 18)

- **Samples and dimensions.**
  - A sample is `{ hit, by?: Dims }` and an amount is `{ amount, by?: Dims }`.
  - `Dims` holds the typed columns (`kind`, `lane`, `state`, `model`, `seat`, `resource`, `halt`) as entities, plus `facets: FacetValue[]`.
  - Queries take the same `Dims`.
- **Facets.**
  - `H.facet('category')` declares a facet; `category.of(value)` builds a value and `category.read(dims)` reads it back.
  - A metric lists its facets with `.facets(...)`. A sample carrying an undeclared facet is refused at runtime.
  - A facet named after a column is a compile error (the `name` parameter type rejects it) and a startup error.
  - No metric dimension is a free string.
- **Sources.**
  - `H.when.decision(lanes, halt)` carries the decision, the resolver sort, the wait, the prior step outputs and each step's `{ seat, model }`.
  - `H.when.step` carries the same outputs and `{ seat, model }` per step.
- **Crossings** are evaluated per distinct `Dims` and carry `by`.
- **Built-in queries:** `outcomes`, `attempts` (with `retried`), `paused`, `decisions`, `leases`. Every figure carries `samples`.

## Accounts and shared quota (principle 15, scenario 7)

- **The account names its partition.**
  - `claudeCode.subscription(name, { token, quota })` and `anthropic.account(name, { apiKey, quota })` both require a `QuotaPartition`.
  - The ledger has no quota option and no quota methods. `QuotaPartition` is its own kernel interface (`register`, `append`, `read`).
- **Sharing.**
  - Two harnesses that import the same account from a shared module write to the same partition by construction. They cannot disagree about where an account's quota lives.
  - Each harness appends its own events and folds the window at read time. There is no lock.
- **Harness identity.**
  - The harness's identity is `H.harness(name)`. It is stamped on every `QuotaEvent`.
  - At start the harness calls `register(name, ledger.id)`. A second ledger claiming the same harness name on a partition is refused, so share accounting cannot merge two tenants.
- **Share caps** are the pool's shares in the declaring harness. `shareUsed` folds only this harness's events. Pool names play no part.
- **One operator, two endpoints.** `claudeCode.supervisor('owner')` is one supervisor session. `.client(name, { grants, port })` gives one client per harness, two endpoints in one session. Account state read through either client is the same partition.

## Rules

1. **Flows know no states.** One flow serves several lanes with different params, retry policies and maps.
2. **Attempt outcome.**
   - Failure: a step fails after its step retries, a job polls `failed`, or the exit maps to a `failure` terminal.
   - Cancellation: `H.cancel`, a `restart` reaction, or an `enter` reaction into a terminal state.
   - Success: any other exit.
   - A crash is never an outcome.
3. **Signals.**
   - Routes and triggers `create` units or `signal` them.
   - `Lane.on(signal, { update, restart, enter })` declares the lane's reaction.
   - `restart: { to, at }` uses step names typed from the flow. If the attempt is elsewhere, the `update` applies now and the restart waits until the attempt blocks at an `at` step.
   - Supplier routes and triggers see `unit.attempt.step` typed as the lane's step names. The compiler catches a renamed step.
   - A signal routed to a key with no open unit is recorded as `signalSkipped`.
4. **Creation deduplicates by key**, recorded as `createSkipped`.
5. **Timers re-arm** after every `attributesUpdated`. An old deadline never fires.
6. **Trigger sources:** `transition`, `pattern`, `timer`, `step`, `decision`, `invocation`, `crossing`.
7. **Trigger consequences:** `create`, `signal`, `record`, `pause`, `resume`. A lambda returning `undefined` skips that firing.
8. **Two retry counters.** Step retry makes new invocations; lane retry makes new attempts. They share no counter.
9. **Determinism.** Exit predicates, loop bounds, halt policies, timeouts, model, account and scheduler choices are each recorded once and replayed.
10. **Capacity.** Only running attempts hold slots, WIP, leases and account reservations.
11. **Memory.**
    - Scope references kinds, roles and resources as entities; skills are strings.
    - Recall matches an attempt's leased resources and its task's `resources`.
    - Ranking is by specificity or similarity, with ties broken by track record.
12. **Restart.**
    - There is one writer claim with a TTL.
    - Completed steps replay at zero cost.
    - The running step follows its `afterCrash`: `rerun`, `park` (with `alreadyDone`), or `askDriver`.
    - Batches and jobs are collected by id, never resubmitted.
    - Children are read from the ledger.
    - A `flowVersion` mismatch parks the attempt as `definitionChanged`.
    - Interrupted attempts are excluded from every rate.
    - Loop iterations resume at the first unrecorded iteration.
13. **Leases and order.**
    - `Lane.lease` takes an exclusive or shared lease on a resource entity while the attempt runs.
    - `Lane.after` keeps a unit unschedulable until its predecessor key reaches a success terminal. Any other verdict for the predecessor moves the unit to the named waiting state with `orderHeld`.

## Startup validation (closes known weakness 9)

`start()` fails, naming the offending descriptor, on any of the following.

**Names**
- Two descriptors of one sort share a name.
- A facet is named after a column.

**Lanes and flows**
- A lane has no `retry`.
- A lane's exits map is not total.
- A flow has a path without an exit.
- `Lane.after` is declared on a lane whose kind has no key.

**Signals**
- A signal is routed to, or triggered on, a lane without a reaction for it.
- `workCancel` is granted, or `H.cancel` is signalled, toward a lane with no `on(H.cancel)`.

**Seats and models**
- A seat lacks a role, model or pool.
- A model's driver serves no account in the seat's pool.
- A guard is declared that the driver cannot `enforce` (the driver returns `false`).
- A batch step runs on a driver without `submitBatch`.
- `askDriver` is declared on a driver without `session`.

**Halts**
- A used halt has no resolver: no grant, no policy and no timeout.
- `resolve(halt)` is granted for a halt no flow or seat uses.
- A halt policy is attached to a halt other than its own.
- A timeout's `afterMinutes` is not greater than its escalation's.

**Metrics and triggers**
- A crossing is declared over a total metric.
- A trigger, metric, scheduler or observer references a lane, journal or metric the harness does not register.

**Quota**
- `register` is refused by a quota partition.

## What changed and why

### Delete: Agent

- **Removed:** `H.agent`, `Agent<O>` and `AgentTask`. The seat carries every setting the agent had.
- **Why:**
  - Known weakness 1: two nouns for one pivot.
  - Adversary critique 3: no seat, so the scenario-6 series broke on a model swap.
  - Principle 8 already defines the agent as a seat with one model, so the seat is the noun that survives.
- **What the deletion costs:** nothing in the battery needs an agent that is not a seat.
- **Renames:** `AgentTask` → `Task`, whose `resources` are `Resource` entities.

### Critique 1: strings standing in for entities

- **Memory scope.** `Scope.resources` and `Task.resources` take `Resource` entities. Scenario 4's journal scope uses the same resource entities as its database runners' concurrency names.
- **Metric dimensions.** Free `group` strings are replaced by typed `Dims` and `Facet` entities. Scenario 9's `` `${category}@${model}` `` becomes `{ model, facets: [category.of(c)] }`.
- **Step addresses.** These are compile-checked literals from the flow type. `UnitView.attempt.step` is now typed by the lane's steps.
  - Scenario 2 drops the supplier-side step test and uses one signal with `restart: { to: 'classify', at: ['approval'] }`. The update always applies; the restart happens only at the halt.
  - We argue that a typed literal union produced by the flow is an address, not a string standing in for an entity. Steps are not shared entities.

### Critique 2: the kind declared failure

- **Removed:** `Kind.onAttemptFailed`, together with the startup rule that policed two failure mechanisms.
- **Lane exhaustion.** Every lane names its own exhaustion state.
- **Migrations retry by lane.** A Migration lane declares `maxAttempts: 1`, because its step is `afterCrash: 'park'` and its effect is not retried by policy. Another lane handling the same kind may choose differently.
- **Cancellation.** `Kind.onCancelled` is removed as a duplicate of `on(H.cancel, { enter })`.

### Critique 3: halt and seat vocabulary

- **Halts.**
  - The inline halt overload is removed (the parent's standard-22 debt).
  - `H.ops.blockersResolve` is removed; resolution is granted only per halt.
  - Every scenario halt becomes an entity.
- **Policies, not predicates.**
  - Scenario 2's safe-category skip becomes a registered `H.policy.halt` with a typed input (`{ category }`) taken from the classify output.
  - Scenario 5's "only ask when validation failed" is `askIf`. Nobody is deciding anything, so it is not a resolver.
- **Mid-call halts.** The builder's owner decision is `seat.halts(ownerDecision)`, granted by `resolve(ownerDecision)`.
- **Naming drift.** Scenario 12's `Training = H.state('OnGpu')` is renamed `OnGpu`.

### Scenario 7: account names its quota partition

See "Accounts and shared quota". `sqlite.ledger` loses `quotaPath`, and `Ledger` loses `appendQuota` and `readQuota`. Share caps are per harness identity. Known weakness 8 is closed by the `Supervisor` instance, which holds one session with one client per harness.

### Smaller

- `ModelDriver.enforce` returns a `boolean`, so the unsupported-guard check is implementable.
- `LedgerEvent` gains `retryExhausted` and `haltSkipped`, and `parked` gains a `predecessorFailed` reason.
- `invocation.seat` is recorded.
- `decisionRecorded` and `policyDecision` record the policy input.

### Open

- **Batch and job are still two blocking forms** (known weakness 2). A `seat.batch()` is a job whose submit and collect are the driver's; unifying them is the next candidate deletion.
- **Skills remain strings** in memory scope, because principle 8 does not name a skill entity.

## Principles broken

None knowingly.
