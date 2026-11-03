# harness-dsl, durable lens, generation 3 (inference)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

This child of `g02-durable-le-0-2-0` does two things:

- It removes every place a scenario needed a type annotation, an imported DSL type or a `satisfies` to type-check. That is the operator's task.
- It repairs the adversary's three sharpest critiques: the missing retry policy, the stringly store state maps, and positions that lie.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind.
  - It has a stable id and a `key` (from `Kind.key`).
  - At most one non-terminal unit per lane holds a given key.
- **Attempt**: one pass of the lane's flow over a unit, from a start step to an exit.
  - It ends with exactly one outcome: succeeded, failed or cancelled.
  - While open it is *running* (executing a step, holding a slot) or *blocked* (holding nothing).
  - A blocked attempt records what it is blocked on: `decision`, `timer`, `children`, `batch` or `recovery`.
- **Step**: a named node of a flow.
  - *Running steps* are command and agent steps.
  - *Blocking steps* are `halt`, `wait`, `spawn`, and a step whose executable is a batch.
  - `loop` and `exit` are structure, not steps.
- **Invocation**: one call of an executable within a step. A retry of a step is a new invocation.

"Run" is not used.

## Lifecycle (principle 12)

- **States.**
  - `H.state(name, 'pending' | 'active' | 'waiting')` declares a non-terminal state.
  - `H.terminal(name, verdict)` declares a terminal state, with no default verdict.
- **Kinds** declare `.initial`, an optional `.onAttemptFailed(state)` and an optional `.onCancelled(state)`.
- **Lanes** map flow exits to states. The map is total and compile-checked.
- **`during`** maps step names to states. The type depends on the step:
  - a **running** step maps only to an `active` state;
  - a **blocking** step maps to an `active` or a `waiting` state.

  So `approval: AwaitingApproval` with `AwaitingApproval` declared `waiting` tells the truth: the unit holds nothing and is not schedulable while the attempt is blocked.

  An unmapped step leaves the state unchanged.
- **Failure default.**
  - A failed attempt leaves the unit at pending under the lane's retry policy (`Lane.retry`), unless the kind declares `onAttemptFailed`.
  - `Lane.retry({ maxAttempts, initialDelayMs, backoffFactor?, exhausted })` works as follows:
    - between failures the unit is pending with `notBefore` set, recorded as `retryScheduled`;
    - after `maxAttempts` failed attempts the unit moves to `exhausted`, recorded as `retriesExhausted`;
    - `exhausted` must be a `waiting` or `terminal` state of the kind (type `RestingState<S>`).
  - A lane whose kind has neither `onAttemptFailed` nor a lane retry is a **startup error**, because a deterministic failure would otherwise loop forever.
- **Positions drive the scheduler and the board.**
  - Only `pending` units with `notBefore` in the past are schedulable.
  - `waiting` units hold no capacity.
  - A blocked attempt holds no capacity, whatever its unit's position.

## Entities

**Kinds** (vocabulary, no backend):
- work kind, state, signal, role (driver-neutral intents), memory kind, command, flow, operation;
- **metric**: `H.metric.rate(name)` or `H.metric.total(name)`. It is now pure vocabulary, the name of a figure.

**Instances** (carry a backend, built in subpaths):
- account, model, embedder, runner, workspace, supplier, store, memory store, ledger, client, observer;
- `H.clock` and `H.operator` are kernel suppliers.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store (+ state map) × flow (exit map, params) × retry | managed units |
| Agent | role × model (or model policy) × pool | a model-call executable |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader/recorder roles | recalled memory |
| Measurement | metric × source × extraction | samples or amounts of the metric |
| Crossing | metric × window × two thresholds | `entered` and `exited` sources |
| Trigger | source → consequences | recorded firings |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | ledger, lanes, journals, triggers, measurements, scheduler, clients, observers | a running harness |

## Rules

1. **Flows know no states.** A flow states its input, its params and its exits. One flow serves Bug (`rounds: 3`) and Feature (`rounds: 5`).
2. **Attempt outcome follows the kind's verdicts.**
   - An attempt fails when:
     - a step fails after its retries; or
     - its exit maps to a `failure` terminal.
   - It is cancelled by `H.cancel`, by `restart`, or by `enter` into a terminal state.
   - Otherwise it succeeded.
   - A crash is never an outcome.
3. **Signals.**
   - A supplier route may `create` or `signal`.
   - `Lane.on(signal, { update, restart, enter })` defines the reaction.
   - A signal with no reaction is a startup error.
4. **Creation deduplicates by key.** A duplicate is recorded as `createSkipped`.
5. **Timers re-arm** after every `attributesUpdated`. An old deadline never fires.
6. **Trigger sources:**
   - `transition`, `pattern`, `timer`, `step` and `invocation` sources;
   - the two edges of a **crossing**.
7. **Crossings.**
   - `H.crossing(name, metric, { window, minSamples, enter, exit })` watches a rate or a total metric, per group, with hysteresis.
   - It exposes two sources: `.entered` and `.exited`.
   - A group that has entered cannot enter again until it exits.
   - Each edge is a `crossing` ledger event, and a trigger on it fires from that event.
   - Calendar windows are re-evaluated at their boundary. A daily spend total therefore *exits* at midnight with no lane timer.
8. **Trigger consequences:**
   - `create`, `signal`, `record`, `pause` and `resume`;
   - pause and resume are recorded with their reason;
   - returning `undefined` from a consequence skips it for that event.
9. **Steps.**
   - `Retry = { maxAttempts, initialDelayMs, backoffFactor? }` is one shape. It is used on steps (invocation retry) and, with `exhausted`, on lanes (attempt retry).
   - `backoffFactor` defaults to 2; a factor of 1 gives a fixed delay.
   - Preflight failures and exit codes outside `acceptExitCodes` fail an invocation.
10. **Determinism.** Exit predicates, loop bounds, `halt.skip`, model, account and scheduler choices are recorded once as `policyDecision` and replayed.
11. **Capacity.**
    - Only running attempts hold slots, WIP and account reservations.
    - `AdmitCtx.count(lane, ...positions)` counts units at those positions. With no positions it counts all non-terminal units.
    - `rank` is ascending.
12. **Cost ceiling.**
    - `Lane.ceiling` checks projected *unit* spend before every invocation.
    - With `halt`, the attempt blocks on a `CeilingDecision`.
    - With `fail`, the attempt fails **and the lane's retries are skipped**: the unit goes straight to `exhausted` (`retriesExhausted { cause: 'ceiling' }`). Retrying cannot lower spend already made, so a spent unit cannot loop.
13. **Metrics.**
    - A metric is declared as vocabulary. It gets data from one or more `H.measure(metric, source, extract)` measurements registered on the harness.
    - The extractor returns `Sample[]` for a rate and `Amount[]` for a total. The type comes from the metric's measure.
    - Every figure carries `samples`.
    - Transition events carry the attempt's `durationMs` and `costUsd`, so "mean cost of succeeded attempts" is measurable exactly.
    - `UnitView.attempts { started, failed }` makes retry counts measurable, for example in a measurement on transitions to a give-up state.
    - Built-in queries: `outcomes`, `attempts` and `paused`.
    - Reading a metric that has no measurement is a startup error when a crossing does it, and a query error otherwise.
14. **Accounts and quota.**
    - An agent names its pool. `ModelDriver.serves(account)` is checked at startup.
    - Quota is an append-only `QuotaEvent` partition of the ledger, folded at read time (principle 15). `sqlite.ledger({ quotaPath })` shares the partition across harnesses.
15. **Memory.**
    - The kernel owns the envelope. Recall is deterministic: it filters by scope, ranks by specificity or by backend similarity, and breaks ties by track record.
    - Similarity needs an embedder, which is an instance (`voyage.embedder`), not a string.
16. **Restart.** Unchanged from the parent:
    - writer claim with expiry;
    - completed steps replayed at zero cost;
    - `afterCrash` with `rerun`, `park` (with `alreadyDone`) or `askDriver`;
    - decisions found on restart;
    - batches collected by id;
    - children read from the ledger;
    - `flowVersion` mismatch parks the attempt with `definitionChanged`.
17. **Control API.**
    - A client is granted operations.
    - A client's endpoint is its harness's name. Two harnesses give two endpoints, and a duplicate is a startup error.
18. **Names are unique per harness.**
    - Two harnesses in one process may each register a journal derived from one shared base under the same name.
    - Within one harness, two descriptors with one name is a startup error.
19. **Startup validation.** `start()` fails on any of:
    - duplicate names;
    - a flow that can fall off its end;
    - an unregistered lane, journal or measurement referenced anywhere;
    - an agent with no pool;
    - a model with no served account;
    - `H.cancel` on a kind with neither `onCancelled` nor a reaction;
    - an unhandled signal;
    - a lane with no failure destination;
    - a batch step on a driver without `submitBatch`;
    - an `askDriver` step on a driver without `session`.

## What changed and why

### Inference (operator)

Every annotation in the parent's scenarios was traced to its cause.

**Circular inference through metrics.**
- **Problem.** `const approvals: MetricRef<'rate'> = H.metric(..., H.when.step(conversations, ...))` needed its annotation because the chain is circular:
  - the metric's type depends on the lane;
  - the lane depends on the flow;
  - the flow (through `halt.skip` or a model policy) reads the metric.
- **Fix.** Splitting the metric into vocabulary (`H.metric.rate(name)`, a non-generic call with a fixed type) and a **measurement** pivot (`H.measure(metric, source, extract)`) breaks the cycle at the root. Flows and policies reference the vocabulary entity; the measurement is declared after the lane.
- **Payoff.** All `MetricRef<'rate'>` annotations and the `MetricRef` imports disappear.

**Model policies returning `(ctx): Model`.**
- **Problem.** The annotation broke a cycle created when the policy read `Metrics.paused({ lane: conversations })`.
- **Fix.** `PolicyCtx.lane` is restored, so a policy asks about its own lane without referencing the lane constant.

**Shared route functions.**
- **Problem.** `routeHelpdesk(event: ZendeskEvent, to: Router<ConversationAttrs, string>): Route` and `type ConversationAttrs = z.infer<...>` existed only because two suppliers shared one route.
- **Fix.** `Lane.supply` now takes `Supplier<E> | readonly Supplier<E>[]`, so one inline route is inferred for both webhook and poll.

**`satisfies` on retry.**
- **Problem.** `backoff: 'exponential'` widened to `string` in a hoisted constant.
- **Fix.** Retry is now `{ maxAttempts, initialDelayMs, backoffFactor? }`, all numbers. A plain constant type-checks.

**`(...readers: Role[])` helper for the shared taste journal.**
- **Fix.** Names are unique per harness (rule 18). The shared module declares a base journal, and each harness derives `.readBy(...)` from it inline.

**Type imports that remain legitimate.**
- **`Window` and `Sample`.** Plain literals and `flatMap` infer without them.
- **Primitive parameters on helper functions.** These are unchanged. No DSL type needs importing for them.

### Repair: the retry policy principle 12 cites (critique 1)

- `Lane.retry` exists. Its `exhausted` destination is required and typed to waiting or terminal states of the kind.
- A lane that leaves failure nowhere to go is a startup error.
- A ceiling failure skips retries.
- `UnitView.attempts` is back as two counters.
- The battery's Bug, Feature, Topic, Experiment and DocPage lanes declare a retry with an honest exhausted state; the scenario files will add them.
- Scenario 11 then expresses:
  - give-up after three failures, with delays of 10 and 40 minutes (`initialDelayMs: 600000, backoffFactor: 4`);
  - "gave up after exactly two retries", as a measurement over transitions to `GaveUp` grouped by `unit.attempts.failed`;
  - the spend pause, as a crossing over a calendar-day total, whose `exited` edge resumes the lane at midnight. Raising the budget is `lanesPause` through the control API.

### Repair: stringly store state maps (critique 2)

- Stores that speak their own state vocabulary implement `MappedStore<V>`.
- The lane supplies the map: `.store(linearStore, { Queued: 'Todo', ... })`. It is typed `{ [K in S['name']]: V }`, so it is total and compile-checked against the lane's kind.
- Renaming `Exhausted` is now a compile error in every lane that maps it.
- One tracker store serves three kinds, each with its own map on its own lane. The relationship sits on the pivot, not on the store instance (principle 10).

**The other strings named.**
- **Supervisor `endpoint`.** Removed. The endpoint is the harness name.
- **Embedding model.** Now an `Embedder` instance.
- **Memory-scope `skills` and `resources`: argued, kept as strings.**
  - They are open runtime values: a category returned by the classifier, the files a builder changed, a CMS section.
  - The set cannot be declared ahead of time. Entities would force a declared catalogue the battery cannot provide.
  - They are data in the `when` envelope, like attribute values, not vocabulary.

### Repair: positions that lie (critique 3)

**Blocking steps may map to waiting states.**
- Step names are now tracked in two type parameters: running (`R`) and blocking (`B`). An executable's phantom `StepKind` decides which one a step joins, so a batch step is blocking.
- `during` lets blocking steps map to `waiting` states. The author declares `AwaitingApproval`, Experiment's between-measurement state and Smoke-waiting as `waiting`, which is what they are.

**Admission counts by explicit position.**
- `AdmitCtx.active` and `pending` are replaced by `count(lane, ...positions)`.
- Scenario 4 gates Backups on `count(incidents) === 0`, that is, any non-terminal Incident, including one still `Open`.
- Scenario 8 counts `'active'` experiments and no longer counts experiments idling between hourly measurements.

**Crossings are one entity with two sources.**
- The edge filter written into every consequence lambda is gone.
- `H.crossing` is the entity that holds the hysteresis state, and `.entered` and `.exited` feed separate triggers.

### Also from the adversary report

- **`deliveredCost` measured the wrong thing.** It is fixed by `TransitionEvent.attempt.costUsd`.
- **Findings forced into `experience`: argued.**
  - A forward-phrased finding ("when researching X, start from Y, because report Z established it") is fallible, can go stale and can be deduplicated. That is the definition of experience in principle 14.
  - A third trust value would be a second word for it.

### Removed

- `H.when.crossing` (replaced by `H.crossing`).
- `CrossingEvent.edge`.
- `Retry.backoff`.
- The `states` option of `linear.store`.
- The supervisor's `endpoint` option.
- `Harness.metrics` (replaced by `measurements`).
- `MetricDraft`.
- `AdmitCtx.active` and `AdmitCtx.pending`.

## Principles broken

None.

- **Principle 12** is now satisfied in its failure-default clause: the lane's retry policy exists and bounds attempts.
- **Principle 15** is followed as in the parent: quota is an append-only ledger partition.
