# harness-dsl, durable lens, generation 3 (delete: Guard; extend: halts, jobs, leases)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

This child is a deletion from `g02-durable-le-0-2-0`. The deleted entity is **Guard** (`H.guard`, the `Guard` type, `Agent.guards`). The child also:
- repairs the adversary's three sharpest critiques and the scenario-3 defects;
- extends the surface so that scenarios 11 and 12 compile without escape hatches.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind.
  - It has a stable id and a `key` (from `Kind.key`).
  - At most one non-terminal unit per lane holds a given key.
  - `UnitView.attempts` and `UnitView.failedAttempts` count its attempts.
- **Attempt**: one pass of the lane's flow over a unit.
  - It ends with exactly one outcome: **succeeded**, **failed** or **cancelled**.
  - While open, it is either *running* (holding a slot) or *blocked* (holding nothing).
  - A blocked attempt records what it is blocked on: `decision`, `timer`, `children`, `batch`, `job` or `recovery`.
- **Step**: a named node of a flow. There are two sorts:
  - *Running steps* (`step`) execute and hold capacity.
  - *Blocking steps* (`halt`, `wait`, `spawn`, `job`) block the attempt.
  - `loop` and `exit` are structure. They are not steps a unit can sit at.
- **Invocation**: one call of an executable within a step. A retry is a new invocation, and so is each poll of a job.

"Run" is not used.

## Lifecycle (principle 12)

- **States.**
  - `H.state(name, 'pending' | 'active' | 'waiting')` declares a non-terminal state.
  - `H.terminal(name, verdict)` declares a terminal state. The verdict has no default.
- **Kinds** declare:
  - `initial(state)`;
  - optionally `onAttemptFailed(state)`: the declared move for a failure, applied at the first failed attempt;
  - optionally `onCancelled(state)`.
- **Lanes** map flow exits to states. The map is total and compile-checked. `during` maps step names to states:
  - a running step accepts only `active` states;
  - a blocking step accepts only `waiting` states;
  - an unmapped step leaves the state unchanged.
- **Failure default.**
  - If the kind declares no failure move, a failed attempt leaves the unit at pending under the lane's retry policy, `Lane.retry({ maxAttempts, backoff, initialDelayMs, exhausted })`.
  - Before each re-attempt the engine appends `retryScheduled` with `notBefore`. The scheduler does not start the unit before that time.
  - When `maxAttempts` attempts have failed, the unit moves to `exhausted`, a state of the kind named by the lane.
  - Startup validation rejects either of:
    - a lane whose kind has no failure move and that has no `retry`;
    - a lane that declares `retry` for a kind that already has a failure move.
- **Scheduler and board.**
  - Only `pending` units are schedulable.
  - `waiting` units and blocked attempts hold no capacity.

## Entities

**Kinds** (vocabulary, no backend):
- work kind;
- state;
- signal;
- role;
- memory kind;
- **halt** (`H.halt(name).decision(schema)`);
- **resource** (`H.resource(name)`);
- command;
- flow;
- operation.

**Instances** (carry a backend, built in subpaths): account, model, embedder, runner, workspace, supplier, store, memory store, ledger, client, observer.
- `H.clock` and `H.operator` are kernel suppliers.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store (state map) × flow (exit map, params) × retry × lease × order | managed units |
| Agent | role × model (or model policy) × pool × workspace × guard settings | a model-call executable |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader/recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples (rate) or amounts (total) | a windowed figure with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

## Rules

1. **Flows know no states.** One flow serves several lanes with different params, retry policies and maps.
2. **Attempt outcome follows the kind's verdicts.**
   - An attempt fails when either:
     - a step fails after its step retries;
     - a job reports `failed`;
     - its exit maps to a `failure` terminal.
   - It succeeds on any other exit.
   - It is cancelled by `H.cancel`, by a `restart` reaction, or by an `enter` reaction into a terminal state.
   - A crash is never an outcome.
3. **Signals.**
   - A supplier route may `create` a unit or `signal` one.
   - `Lane.on(signal, { update, restart, enter })` declares the lane's reaction.
   - A signal routed to a key with no open unit in that lane is recorded as `signalSkipped`.
   - **Conditional restart.** `restart: { to, at: [steps] }` restarts only when the attempt is at one of the `at` steps.
     - A signal that arrives while the attempt runs another step applies its `update` at once.
     - The restart is deferred until the attempt next blocks at an `at` step.
     - The event is therefore neither dropped nor fatal.
4. **Creation deduplicates by key**, recorded as `createSkipped`.
5. **Timers re-arm** on creation and after every `attributesUpdated`. An old deadline never fires.
6. **Trigger sources**:
   - `transition`;
   - `pattern`;
   - `timer`;
   - `step`;
   - `invocation`;
   - `decision`;
   - `crossing(metric, band, edge)`.
7. **Trigger consequences**:
   - `create`;
   - `signal`;
   - `record`;
   - `pause` and `resume`.

   A lambda returning `undefined` skips that firing.
8. **Step retry** makes new invocations within one attempt. **Lane retry** makes new attempts. The two never share a counter.
9. **Determinism.**
   - Exit predicates, loop bounds, halt policies, halt timeouts, model, account and scheduler choices are each recorded once and read back on replay.
   - A policy's recorded decision carries every metric figure it read: metric, group, value and samples.
10. **Capacity and admission.**
    - Only running attempts hold slots, WIP, leases and account reservations.
    - `AdmitCtx.count(lane, ...positions)` counts units at the given positions.
11. **Cost ceiling.**
    - `Lane.ceiling` checks projected unit cost before every invocation.
    - With `halt` the attempt blocks; with `fail` the lane's retry bound applies.
12. **Metrics.**
    - Rate metrics are read with `rate()`, total metrics with `total()`. Every figure carries `samples`.
    - The built-in queries are:
      - `outcomes`;
      - `attempts` (with `retried`);
      - `paused`;
      - `decisions` (per halt and per resolver);
      - `leases` (wait time per resource).
13. **Accounts and quota.**
    - Quota is an append-only ledger partition (`QuotaEvent`), folded at read time, with no cross-harness lock.
14. **Memory.**
    - Recall is deterministic: it filters by scope, ranks by specificity or by similarity score, and breaks ties by track record.
15. **Restart.**
    - There is one writer claim with a TTL.
    - Completed steps replay at zero cost.
    - The running step follows its `afterCrash`.
    - Batches and jobs are collected by id and never resubmitted.
    - Children are read from the ledger.
    - A `flowVersion` mismatch parks the attempt as `definitionChanged`.
    - `attemptInterrupted` is excluded from every rate.
    - Loop iterations are recorded, so a resumed loop continues at the first unrecorded iteration.
16. **Control API.**
    - A client is granted operations.
    - `H.ops.resolve(halt)` is the grant to resolve one halt and no other.
    - `H.ops.blockersResolve` resolves any halt.
17. **Startup validation** fails on any of:
    - duplicate names;
    - a flow without an exit on some path;
    - an unregistered reference;
    - an agent without a pool;
    - a model whose driver serves no pool account;
    - `H.cancel` with neither `onCancelled` nor a reaction;
    - a signal without a reaction;
    - a crossing over a total metric;
    - a batch step on a driver without `submitBatch`;
    - `askDriver` on a driver without `session`;
    - a lane with no failure bound, or with two;
    - an agent guard the driver cannot `enforce`;
    - a halt grant for a halt no registered flow uses;
    - a halt policy over a halt or kind other than the one its flow step uses;
    - a halt timeout whose `afterMinutes` is not greater than the halt's `escalate.afterMinutes`;
    - `Lane.after` on a lane whose kind has no key.

## Halts (scenario 11)

A halt is a kind: `H.halt('signoff').decision(schema)`. A flow halts at it with `flow.halt(stepName, halt, options)`.

- **Address versus entity.** The step name is the halt's address in the flow. The entity is the question. One question may be asked at two addresses, which closes known weakness 3.
- **Resolvers.** A halt has three resolver sorts, recorded in `decisionRecorded.resolvedBy`:
  - `human` (through a client holding `H.ops.resolve(halt)`);
  - `policy` (`skip: H.policy.halt(...)`, a registered policy whose decision records the metrics it read);
  - `timeout` (`timeout: { afterMinutes, decide }`). This resolves the halt; it does not cancel the attempt, and the same attempt continues.
- **Clocks.**
  - Clocks run from the recorded `attemptBlocked` event, never from unit data.
  - `escalate: { afterMinutes, run }` invokes an executable once, for example to page a deputy. Both people may then resolve the halt.
- **Metrics and triggers.** `H.when.decision(kind, halt)` is a trigger and metric source carrying the decision, the resolver sort, the resolver and the wait.
- **Bounded returns.** A return loop is a `loop` with `max`. Its exit tests the last decision. The kernel enforces the bound; the flow counts nothing.

## Jobs (scenario 12)

`flow.job(name, { submit, input, collect, pollEveryMinutes })` is a blocking step.

- **Submit.** `submit` returns a `JobHandle`, recorded as `jobSubmitted`.
- **Collect.** `collect` is invoked every poll and returns a `JobPoll<O>`, built by `H.jobPoll(resultSchema)`.
- **Capacity.** While polling, the attempt is blocked on `job`. It holds no WIP and no runner slot.
- **Restart.** On restart a recorded job id is polled, never resubmitted.
- **Failure.** A `failed` poll fails the attempt.
- **Metrics.** The step's `durationMs` makes in-flight hours a metric.

## Leases and order (scenario 12)

- **Leases.**
  - `Lane.lease(unit => ({ resource, mode }))` takes an exclusive or shared lease on a resource entity whenever the attempt runs, and releases it when the attempt blocks or ends.
  - The scheduler does not start a unit whose lease is unavailable.
  - The lease is ledger state (`leaseTaken` with mode and `waitedMs`).
- **Order.**
  - `Lane.after({ key, onPredecessorFailed })` keeps a unit unschedulable until the unit with that key in the same lane reaches a `success` terminal.
  - A predecessor ending in any other verdict moves the unit to the named waiting state and records `orderHeld` with the reason.

## Store state maps

- `Store<M>` carries a phantom `M`.
- `Lane.store` has two overloads: native stores need no map; mapped stores require a total map over the lane's kind.

## What changed and why

### Delete: Guard

Guards are a setting on the agent pivot (`Agent.guard({ leaseFiles, beforeStop })`), enforced through `ModelDriver.enforce`. This removes one entity, two builders and one type.

### Repairs to the adversary's critiques

- **Retry.** `Lane.retry` with a required `exhausted` state.
- **Store maps.** Typed `Store<M>` maps on the lane.
- **Position honesty.** `during` split by step sort, `AdmitCtx.count`, and crossings split by edge.

### Scenario 11 (halts with a clock, bounded retry)

- **Added:**
  - the `Halt` entity and `H.halt`;
  - `flow.halt(name, halt, { ask, skip, timeout, escalate })`;
  - `H.policy.halt` (`HaltPolicy`);
  - `H.when.decision` (`DecisionEvent`);
  - `H.ops.resolve(halt)`;
  - `Metrics.decisions`;
  - `AttemptCounts.retried`;
  - `ResolvedBy`;
  - `decisionRecorded.{halt, resolvedBy, reads}` (replacing `auto`);
  - `policyDecision.reads`;
  - the `haltEscalated` event;
  - the `signalSkipped` event;
  - conditional restart `{ to, at }`.
- **Why:**
  - Principles 8 and 17 require halts referenced by identity and three resolver sorts.
  - The surface had only an inline halt with an unrecorded predicate and capability-wide grants.
- **Debt:** the inline `halt(name, { ask, decision, skip })` overload is kept so that scenarios 1–10 compile unchanged. It should be removed when those scenarios migrate to halt entities. Two forms for one concept is a known breach of standard 22, carried temporarily.

### Scenario 12 (external jobs, locks, order)

- **Added:**
  - `flow.job`, `H.jobPoll`, `JobHandle` and `JobPoll`;
  - `BlockReason 'job'` and the `jobSubmitted` event;
  - the `Resource` entity and `H.resource`;
  - `Lane.lease` and `Lane.after`;
  - the `orderHeld` event;
  - `leaseTaken.{mode, waitedMs}`;
  - `Ledger.takeLease(..., mode)`;
  - `Metrics.leases`;
  - `FlowCtx.iteration`;
  - `StepEvent.durationMs`.
- **Why:** principle 3 rules external jobs a step that holds no capacity, and principle 8 rules resources as entities that leases reference by identity.
- **Batch-shaped resumption.** This needed only the loop iteration in context: recorded iterations already replay.
- **Open:** batch and job remain two blocking steps (known weakness 2). Unifying them is a candidate deletion.

### Adapter added

`harness-dsl/ironclad` (a document-system store) for scenario 11.

## Principles broken

None knowingly.

- Standard 22 carries the temporary two-form halt noted above. It is listed as debt, not as a broken principle, because the entity form is the one principle 8 requires and the inline form references nothing by name.
