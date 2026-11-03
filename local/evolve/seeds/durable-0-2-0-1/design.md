# harness-dsl, durable lens, generation 3 (delete: Guard)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

This child is a deletion from `g02-durable-le-0-2-0`. The deleted entity is **Guard** (`H.guard`, the `Guard` type, `Agent.guards`). The child also repairs the adversary's three sharpest critiques and the scenario-3 defects.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind.
  - It has a stable id and a `key` (from `Kind.key`).
  - At most one non-terminal unit per lane holds a given key.
  - `UnitView.attempts` and `UnitView.failedAttempts` count its attempts.
- **Attempt**: one pass of the lane's flow over a unit.
  - It ends with exactly one outcome: **succeeded**, **failed** or **cancelled**.
  - While open, it is either *running* (holding a slot) or *blocked* (holding nothing).
  - A blocked attempt records what it is blocked on: `decision`, `timer`, `children`, `batch` or `recovery`.
- **Step**: a named node of a flow. There are two sorts:
  - *Running steps* (`step`) execute and hold capacity.
  - *Blocking steps* (`halt`, `wait`, `spawn`) block the attempt.
  - `loop` and `exit` are structure. They are not steps a unit can sit at.
- **Invocation**: one call of an executable within a step. A retry is a new invocation.

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
  - a running step accepts only `active` states (`ActiveState<S>`);
  - a blocking step accepts only `waiting` states (`WaitingState<S>`);
  - an unmapped step leaves the state unchanged.
- **Failure default** (repair, critique 1).
  - If the kind declares no failure move, a failed attempt leaves the unit at pending under the lane's retry policy, `Lane.retry({ maxAttempts, backoff, initialDelayMs, exhausted })`.
  - Before each re-attempt the engine appends `retryScheduled` with `notBefore`. The scheduler does not start the unit before that time.
  - When `maxAttempts` attempts have failed, the unit moves to `exhausted`, a state of the kind named by the lane.
  - Startup validation rejects either of:
    - a lane whose kind has no failure move and that has no `retry`;
    - a lane that declares `retry` for a kind that already has a failure move.

  Every lane is therefore bounded. The bound and its destination live on the pivot. Flows stay blind to states.
- **Scheduler and board.**
  - Only `pending` units are schedulable.
  - `waiting` units and blocked attempts hold no capacity.
  - A unit's position now agrees with its attempt status wherever the author maps blocking steps. That is the purpose of the `during` split.

## Entities

**Kinds** (vocabulary, no backend): work kind, state, signal, role (driver-neutral intents), memory kind (`H.memory(name, trust)`), command, flow, operation.

**Instances** (carry a backend, built in subpaths): account, model, embedder, runner, workspace, supplier, store, memory store, ledger, client, observer.
- `H.clock` and `H.operator` are kernel suppliers.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store (state map) × flow (exit map, params) × retry | managed units |
| Agent | role × model (or model policy) × pool × workspace × guard settings | a model-call executable |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader/recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples (rate) or amounts (total) | a windowed figure with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

## Rules

1. **Flows know no states.** One flow serves Bug (`rounds: 3`) and Feature (`rounds: 5`) through two lanes.
2. **Attempt outcome follows the kind's verdicts.**
   - An attempt fails when either:
     - a step fails after its step retries;
     - its exit maps to a `failure` terminal.
   - It succeeds on any other exit.
   - It is cancelled by `H.cancel`, by a `restart` reaction, or by an `enter` reaction into a terminal state.
   - An attempt interrupted by a crash is the same attempt. The crash is never an outcome.
3. **Signals.**
   - A supplier route may `create` a unit or `signal` one.
   - `Lane.on(signal, { update, restart, enter })` declares the lane's reaction.
   - `restart` takes any typed step name, running or blocking.
   - A signal with no reaction is a startup error.
4. **Creation deduplicates by key.** A skipped creation is recorded as `createSkipped`.
5. **Timers re-arm** on creation and after every `attributesUpdated`.
   - The old deadline records `timerCleared('rearmed')`.
   - An old deadline never fires.
6. **Trigger sources**:
   - `transition`;
   - `pattern` (N consecutive per group);
   - `timer`;
   - `step`;
   - `invocation`;
   - `crossing(metric, band, edge)`.

   Crossing (repair, critique 3b):
   - A `Band` is `{ window, minSamples, enter, exit }`.
   - Hysteresis state is per (metric, band, group). Two triggers that pass equal bands to one metric share one watch: one for `'entered'`, one for `'exited'`.
   - The engine appends one `crossing` event per edge.
   - Each trigger fires only on its edge, so consequence lambdas no longer filter on the edge.
7. **Trigger consequences**:
   - `create`;
   - `signal`;
   - `record` (optionally as a candidate);
   - `pause` and `resume`, recorded as `lanePaused` and `laneResumed` with the reason.

   A consequence lambda may return `undefined` to skip that firing. This is for data-dependent skips, such as a cancel only while a unit awaits approval.
8. **Steps.**
   - Step retry, `{ maxAttempts, backoff, initialDelayMs }`, makes new invocations within one attempt.
   - Lane retry makes new attempts. The two never share a counter.
9. **Determinism.** Exit predicates, loop bounds, `halt.skip`, model, account and scheduler choices are each recorded once as a `policyDecision` and read back on replay.
10. **Capacity and admission.**
    - Only running attempts hold slots, WIP and account reservations.
    - `AdmitCtx.count(lane, ...positions)` counts units at the given positions.
    - Scenario 4 writes `count(incidents, 'pending', 'active', 'waiting') === 0`: an Incident blocks Backups from creation to resolution.
    - `rank` is ascending.
11. **Cost ceiling.**
    - `Lane.ceiling` checks projected unit cost before every invocation.
    - With `halt`, the attempt blocks on a `CeilingDecision`.
    - With `fail`, the attempt fails and the lane's retry bound applies. A unit that has spent its ceiling reaches `exhausted` after `maxAttempts`; it does not loop.
12. **Metrics.**
    - Rate metrics are read with `rate()`, total metrics with `total()`. Every figure carries `samples`.
    - `TransitionEvent.attempt.costUsd` is the ending attempt's own cost. Scenario 3's projected cost is an amounts metric over transitions to `Delivered` using `attempt.costUsd`, which is the mean cost of succeeded attempts as specified, not the unit's lifetime spend.
    - Built-in queries are `outcomes` (with `byState`), `attempts` (by kind and model) and `paused`.
13. **Accounts and quota.**
    - The agent names its pool. `ModelDriver.serves(account)` is checked at startup.
    - Quota is an append-only ledger partition (`QuotaEvent`), folded at read time.
    - `sqlite.ledger({ path, quotaPath })` puts the partition in a file shared by harnesses. There is no cross-harness lock.
14. **Memory.**
    - The kernel owns the envelope.
    - Recall is deterministic: it filters by scope, ranks by specificity or by the backend's similarity score, and breaks ties by track record.
    - Similarity uses an `Embedder` instance passed to the vector memory store. The embedder's model is an instance with a backend, not a string.
    - Each write names one journal. Reads union the journals visible to the role.
15. **Restart** (unchanged).
    - **Writer claim.** There is one writer claim with a TTL. Appends from a stale writer are rejected. `decisionRecorded` is the one append allowed without the claim.
    - **Completed steps** replay at zero cost.
    - **The running step** follows its `afterCrash`, with the default `askDriver` for agents and `park` for commands. `alreadyDone` lets a parked step continue.
    - **Batches** are collected by id and never resubmitted.
    - **Children** are read from the ledger.
    - **Changed definitions.** A `flowVersion` mismatch parks the attempt as `definitionChanged`. The supervisor then chooses `restartFromTop` or `abandon` through `attemptsRecover`.
    - `attemptInterrupted` is excluded from every rate.
16. **Control API.** A client is granted operations. A Claude Code supervisor (with an optional `port`) and plain HTTP are two `Client` backends.
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
    - an agent guard the driver cannot `enforce`.

## Store state maps (repair, critique 2)

- `Store<M>` carries a phantom `M`: the type of the backend's own state names.
  - Stores that keep state natively are `Store` (`M = never`): sqlite, folder frontmatter, helpdesk, CMS.
  - `linear.store({ workflow: ['Todo', 'In Progress', ...] })` is `Store<'Todo' | 'In Progress' | ...>`.
- `Lane.store` has two overloads:
  - a `Store<never>` needs no map;
  - a `Store<M>` requires `states: { [K in S['name']]: M }`.
- The map is therefore **total over the lane's kind** and **checked against the tracker's declared workflow**. Renaming `Exhausted` breaks compilation. A typo in `'Canceled'` breaks compilation.
- The map lives on the lane (the pivot), not on the store instance and not on the kind. The store instance stays shared across Bug, Feature and Epic.

## Raw strings (critique 2, second half), argued

- **Supervisor endpoint.** The `endpoint: 'coding'` string is gone. A supervisor optionally takes a `PortRef`. Two harnesses use two ports.
- **Scope strings stay.**
  - `skills: [category]` and `resources: [path]` are data: a category the classifier emitted, a file the builder changed, a section of a CMS entry.
  - Declaring each as an entity would require enumerating runtime values at definition time, which principle 11 forbids.
  - Kinds and roles in scope remain entities, so the vocabulary half of scope is typed.

## Findings memory (scenario 3), argued

- Prior report findings are forward-phrased: "when researching X, start from Y, because a report with resolving citations established it".
- Such an item can be wrong, can go stale and can be deduplicated. That is the definition of experience in principle 14.
- A third trust value would add a word for nothing. The kind is `H.memory('finding', 'experience')` in its own journal with a vector backend.

## Scenario 3 outcome

- A topic whose citations never resolve fails attempts.
- The `topics` lane declares `retry({ maxAttempts: 2, ..., exhausted: Unresolvable })`, where `Unresolvable` is a `failure` terminal.
- The brief lists delivered, parked and cancelled as the outcomes the owner wants. A citation that never resolves is honestly a failure, and the parent's livelock was the lie.

## What changed and why

### Delete: Guard

- **Removed:** `H.guard.lease()`, `H.guard.beforeStop(exec)`, the `Guard` interface and `Agent.guards(...)`.
- **Why:**
  - Guard was an entity with one use: the builder agent in scenarios 1 and 7.
  - It had no name, no identity and no backend.
  - It was a tagged option object dressed as vocabulary. Nothing else consumed it, and no kernel interface took a `Guard`.
- **Repair:**
  - Guards become a setting on the agent pivot: `Agent.guard({ leaseFiles: true, beforeStop: projectChecks })`.
  - `ModelDriver.enforce('leaseFiles' | 'beforeStop', hook)` is the backend fact. Startup fails if the driver cannot enforce a requested guard.
  - The surface loses one entity, two builders and one type. It gains one method.

### Repairs to the adversary's critiques

1. **Retry policy that the principle cites but the surface lacked.**
   - Added `Lane.retry` with a required `exhausted` state.
   - Added `retryScheduled` events and `UnitView.attempts` / `failedAttempts`.
   - Added the rule that every lane has exactly one failure bound.
   - The ceiling livelock and the cumulative-spend loop end at `exhausted`.
2. **Stringly store maps.** Replaced by `Store<M>` with a total, compile-checked map on the lane. The supervisor endpoint string is replaced by a port ref. Scope strings are argued above.
3. **`during` made position lie.**
   - Blocking steps can map only to `waiting` states, running steps only to `active` states.
   - `AdmitCtx.active` and `pending` are replaced by `count(lane, ...positions)`, so admission says exactly which positions it means.
   - Crossing is split by edge, with a shared `Band`, so one trigger is one consequence set.

### Scenario-3 defects

- `deliveredCost` now reads `attempt.costUsd`.
- `pgvector` takes an `Embedder` instance (`harness-dsl/voyage`).
- `Unresolvable` gives cite-check failure an honest destination.

### Smaller

- Removed `CrossingEvent.edge`, which is implied by the source, and the crossing `groups` filter, which nothing called.
- `pause`/`resume` reasons are no longer optional-returning, since each trigger fires on one edge.
- Loop names no longer enter the `during` key space. A loop is structure, not a place a unit sits.

### Known, not in battery

The adversary's scenario 11 is partly covered:
- give-up after N attempts is now `Lane.retry`;
- retry counts are queryable through `failedAttempts` on `TransitionEvent.unit`.

Still out of reach:
- a dollar-threshold crossing over a total metric;
- a lane-scoped midnight timer;
- non-geometric delays (10 then 40 minutes).

## Principles broken

None.

- Principle 12's failure default is now implemented as written: pending under the lane's retry policy, with the policy's exhaustion target named on the lane.
- Principle 15 is followed as amended: quota is an append-only ledger partition with no cross-harness lock.
