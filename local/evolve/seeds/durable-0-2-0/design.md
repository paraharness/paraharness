# harness-dsl, durable lens, generation 2 (surface cut)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

This child is a surface cut of `g01-durable-able-0-2`. It also repairs the adversary's three sharpest critiques.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind.
  - It has a stable id and a `key` (from `Kind.key`).
  - At most one non-terminal unit per lane holds a given key. That is what signals route to and what deduplicates creation.
- **Attempt**: one pass of the lane's flow over a unit, from a start step to an exit.
  - It ends with exactly one outcome: **succeeded**, **failed** or **cancelled** (rule 2 says which).
  - While open it is either *running* (executing a step, holding a slot) or *blocked* (holding nothing).
  - A blocked attempt records what it is blocked on: `decision` (a halt), `timer` (a `wait`), `children` (a `spawn`), `batch` (a submitted batch) or `recovery` (parked after a crash).
  - "Blocked" is the one word for a non-running open attempt. "Halt" is the name of the step that blocks on a decision.
- **Step**: a named node of a flow: `step`, `halt`, `wait`, `spawn`, `loop` or `exit`. Step outputs are recorded and form replay state.
- **Invocation**: one call of an executable (a command or a model call) within a step.
  - A retry is a new invocation.
  - Cost, tokens, model, account and runner are recorded per invocation.

"Run" is not used.

## Lifecycle (principle 12)

- **States.**
  - `H.state(name, 'pending' | 'active' | 'waiting')` declares a non-terminal state and its position.
  - `H.terminal(name, verdict)` declares a terminal state. The verdict is `'success'`, `'failure'` or `'neutral'`, with no default.
- **Kinds** declare:
  - `.initial(state)`;
  - optionally `.onAttemptFailed(state)`. Without it, a failed attempt leaves the unit at pending under the lane's retry policy;
  - `.onCancelled(state)`, where `H.cancel` takes the unit.
- **Lanes** map flow exits to states, total and compile-checked. They may also map step names to states with `during`.
  - `during` accepts **only states whose position is `active`**. This is checked by the type `ActiveState<S>`.
  - An unmapped step leaves the state unchanged.
- **Scheduler and board are defined on positions.**
  - Only `pending` units are schedulable.
  - `waiting` units hold no capacity.
  - A blocked attempt holds no capacity, whatever its unit's position.

## Entities

**Kinds** (vocabulary, no backend): work kind, state, signal, role (driver-neutral intents), memory kind (`H.memory(name, trust)`), command, flow, operation.

**Instances** (carry a backend, built in subpaths): account, model, runner, workspace, supplier, store, memory store, ledger, client, observer.
- `H.clock` and `H.operator` are kernel suppliers.
- Instances carry no relationships.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store × flow (exit map, params) | managed units |
| Agent | role × model (or model policy) × pool | a model-call executable |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader/recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples (rate) or amounts (total) | a windowed figure with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

Pools are reached through the agents that name them, so the harness no longer registers pools.

## Rules

1. **Flows know no states.**
   - A flow states its minimum input shape and its params, and ends at named exits.
   - One flow serves Bug (`rounds: 3`) and Feature (`rounds: 5`) through two lanes.
2. **Attempt outcome is defined by the kind's verdicts, not by "the flow finished".**
   - An attempt **fails** when:
     - a step fails after its retries; or
     - its exit maps to a terminal state with verdict `failure`.
   - An attempt **succeeds** when its exit maps to any other state.
   - An attempt is **cancelled** by `H.cancel`, by `restart`, or by `enter` into a terminal state.
   - So `exhausted → Exhausted (failure)` is a failed attempt, and a model's attempt success rate means what the kind says success is.
   - Interrupted-by-crash attempts are the same attempt; the crash is never an outcome.
3. **Signals.**
   - A supplier route may `create` a unit or `signal` one, by key or by a predicate over a `UnitView` typed with the kind's state names.
   - `Lane.on(signal, { update, restart, enter })`:
     - `update` merges the payload into attributes;
     - `restart` cancels the open attempt and starts a new one at a typed step name;
     - `enter` moves the unit to a state. Entering a terminal state cancels the open attempt.
   - A signal with no reaction on the lane is a startup error. `H.cancel` is the built-in signal.
4. **Creation deduplicates by key.** Creating a unit whose key already has an open unit in that lane is a no-op, recorded as `createSkipped`.
5. **Timers re-arm.** `H.when.timer` is evaluated on unit creation and after every `attributesUpdated`.
   - A changed deadline records `timerCleared('rearmed')` and a new `timerSet`.
   - `undefined` disarms the timer.
   - Terminal units clear their timers.
   - An old deadline never fires.
6. **Trigger sources** (each fires only from recorded ledger events, and each firing is recorded):
   - `transition`;
   - `pattern` (N consecutive per group key);
   - `timer`;
   - `step` (typed output, with `outputs` and `models` keyed by the flow's step names);
   - `invocation`;
   - `crossing`.

   A **crossing** watches a rate metric per group with hysteresis:
   - it has an `enter` and an `exit` threshold, a window and `minSamples`;
   - when a group crosses a threshold, the engine appends a `crossing` event;
   - a group that has entered cannot enter again until it has exited.
7. **Trigger consequences:**
   - `create` in a lane;
   - `signal` a unit by key;
   - `record` a memory draft into a journal (optionally as a candidate);
   - `pause` or `resume` a lane, recorded as `lanePaused` and `laneResumed` with the reason.

   A paused lane starts nothing new; its running attempts finish.
8. **Steps.**
   - Retry (`{ maxAttempts, backoff, initialDelayMs }`) is a step declaration. Each retry is a new invocation.
   - A command fails on an exit code outside `acceptExitCodes` (default `[0]`). Accepted codes are output, so a flow branches on them.
   - A runner's preflight runs on that runner before each command placed there. A failed preflight is a failed invocation.
9. **Determinism.**
   - These choices are each recorded once as a `policyDecision` and read back on replay:
     - exit predicates;
     - loop bounds;
     - `halt.skip`;
     - model choices;
     - account choices;
     - scheduler choices.
   - Policies read a `Metrics` snapshot taken at decision time.
10. **Capacity.**
    - Only running attempts hold runner slots, lane WIP and account reservations.
    - `AdmitCtx.active(lane)` counts units at position `active`.
    - `rank` is ascending: the smallest key starts first.
11. **Cost ceiling.**
    - `Lane.ceiling` checks projected unit cost before every invocation.
    - With `onExceed: 'halt'`, the attempt blocks on a decision whose schema is the kernel's `CeilingDecision`: `raise` to a new `maxUsd`, or `fail`.
    - The ask names the unit, its spend and the next step. The flow resumes at that same step.
12. **Metrics.**
    - `H.metric(name, source)` followed by `.samples(...)` gives a rate metric, read with `rate()`. `.amounts(...)` gives a total metric, read with `total()`.
    - Every figure carries `samples`.
    - Windows are rolling or calendar.
    - A mean is `total / samples` of an amounts metric. Scenario 3's projected topic cost is an amounts metric over transitions to `Delivered` with `unit.costUsd`.
    - Built-in queries:
      - `outcomes` gives unit verdicts with `byState`;
      - `attempts` gives attempt outcomes by kind and model;
      - `paused` gives total paused time per lane.
13. **Accounts and quota.**
    - An agent names its pool. The engine serves the agent's chosen model from that pool's eligible accounts.
    - `ModelDriver.serves(account)` is checked at startup for every candidate model × account. Nothing is routed by string matching or by registration order.
    - Quota is a **partition of the ledger**: append-only `QuotaEvent`s (`consumed`, `cooldown`, `windowObserved`).
      - Each harness appends its own consumption without the writer claim.
      - The kernel folds the window into `AccountState` at read time.
      - `sqlite.ledger({ path, quotaPath })` puts that partition in a shared file.
      - Two harnesses with one `quotaPath` see each other's cooldowns on their next read. Neither locks the other.
    - Share caps are per pool, so per harness.
14. **Memory.**
    - The kernel owns the envelope: id, created, status, `when`, `mergedInto`, track record.
    - Item bodies are forward-phrased text.
    - Recall (`.recall({ by, limit })`) is deterministic:
      - it filters by scope;
      - it ranks by specificity or by the backend's similarity score;
      - it breaks ties by track record.
    - Reads take the union of the journals visible to the role.
    - Each write names one journal. The writer is one of:
      - an agent whose role is in `recordedBy`;
      - a trigger;
      - a client holding `memoryWrite`.
15. **Restart.** The author writes no resumption code.
    - **Single writer.**
      - `start()` calls `Ledger.claimWriter(holder, ttl)` and re-claims it periodically; a claim by the same holder renews it.
      - A second process refuses to start while the claim is live, and takes over only after it expires.
      - Appends from a stale writer are rejected.
    - **Completed steps.** A step with a `stepEnded` is never re-run. Its recorded output is replayed at zero cost.
    - **The step that was running.** The engine appends `attemptInterrupted`, which is excluded from every rate, then applies the step's `afterCrash`:
      - `rerun`;
      - `park`, unless `alreadyDone` returns true, in which case the step continues;
      - `askDriver`, which calls `session(idempotencyKey)` and gets `finished`, `running` or `lost`.

      The default is `askDriver` for agents and `park` for commands.
    - **Halts.** A `decisionRecorded` event is the one append allowed without the writer claim. A decision made while the harness was down is found on restart.
    - **Batches.** A submitted batch is collected by id, never resubmitted.
    - **Children.** Spawned children are read from their recorded positions.
    - **Changed definitions.** A `flowVersion` mismatch parks the attempt with `definitionChanged`. `attemptsRecover` chooses `restartFromTop` or `abandon`.
16. **Control API.** A client is granted operations. The Claude Code supervisor and plain HTTP are two `Client` backends. Custom operations are `H.operation(name, executable)`.
17. **Startup validation.** `start()` fails on any of:
    - duplicate descriptor names;
    - a flow that can fall off its end without an exit;
    - an unregistered lane, journal or metric referenced anywhere;
    - an agent with no pool;
    - a candidate model whose driver serves no account of the agent's pool;
    - a kind receiving `H.cancel` with neither `onCancelled` nor a reaction;
    - a signal without a reaction;
    - a crossing over a non-rate metric;
    - a batch step on a driver without `submitBatch`;
    - an `askDriver` step on a driver without `session`.

## What changed and why

### Surface cut (operator)

Removed because no scenario calls them, or their only caller is better served elsewhere.

**Methods and builders:**
- **`Flow.await`.** No scenario uses it. The "buffered signal" rule went with it: an unhandled signal is now a startup error.
- **`Agent.budgetTokens`.** No caller.
- **`Command.env`.** One caller, which did not need it: the helpdesk CLI reads its own credential.
- **`H.retry`.** An identity function; a typed literal does the same job.
- **`H.recall` and the `Recall` entity.** They are now journal options. An entity whose only use was being passed to a journal was suspect.
- **`MemoryKind.body` and the journal and draft generics.** Every battery item is text.
- **`MemoryKind.trust`.** It became the second argument of `H.memory`.
- **`Metric.from`.** The source became an argument of `H.metric`, so the draft is typed by its source.
- **`Operation.input` and `Operation.run`.** They became `H.operation(name, exec)`.
- **`Clock.daily`, `weekly` and `monthly`.** They became `Clock.at(time, { on })`.
- **`Harness.pools`.** Pools are reached through agents.
- **`Pool.ledger`, the `AccountLedger` interface and `sqlite.accountLedger`.** Quota is now a ledger partition (see "Principle 15" below).
- **`RunningHarness` and `stop`.** No caller. `start()` returns `Promise<void>`.
- **`Metrics.meanCostUsd`.** It is a total metric divided by its samples.
- **`Ledger.renewWriter`.** A claim by the same holder renews.

**Options:**
- **`Retry.maxDelayMs`, `StepOptions.timeoutMs`, `Recall.minScore` and the `Wait.until` form.** Each had one caller or none.
- **Filters `from` and `verdict` on `when.transition`.** Never used.
- **`Metrics.outcomes` `model`.** Never used.
- **`Metrics.attempts` `agent`, `runner` and `account`.** Never used.

**Context fields:**
- **`PolicyCtx.unit`, `lane` and `now`.** Never used.
- **`AdmitCtx.paused` and `now`.** Never used.
- **`FlowCtx.iteration`.** Never used.

**Event and view fields** that no scenario reads:
- `StepEvent.step`, `costUsd` and `durationMs`;
- `InvocationEvent` down to `model`, `ok` and `costUsd`;
- `CrossingEvent.metric`, `hits` and `at`;
- `TransitionEvent.from`, `position` and `verdict`, and its attempt summary down to `durationMs`;
- `ChildResult.position`. Its `verdict` is now required, because spawn waits for terminal children;
- `UnitView.parentId`, `enteredStateAt` and `attempts`;
- `AttemptCounts.interrupted`. Rule 15 excludes interrupted attempts from every count; reporting the count apart was never read.

**Adapter fields:**
- `LinearIssue.url` and `parentId`;
- `FolderFile.frontmatter`;
- `ContentfulEntry.updatedAt`.

**Kept despite a single scenario**, because a must-express line needs them:
- `Runner.preflight` (scenario 4);
- `acceptExitCodes` (scenario 5);
- `alreadyDone` (scenario 10);
- `Pool.fallback` (scenarios 1 and 7);
- `Metrics.paused` (scenario 9). Total paused time is a duration between paired events, which no amounts metric can express.

### Repair: model-to-pool routing (critique 1)

- `Account.family` and `Model.families` are gone, and with them the "first registered pool" rule.
- The agent pivot now names its pool: agent = role × model × pool, producing a model-call executable. The relationship lives on the pivot, not on a kind (principle 10), and has a noun (principle 9).
- Compatibility between model and account is a backend fact, `ModelDriver.serves(account)`, checked at startup.

### Repair: success defined two ways (critique 2)

- Attempt outcomes now derive from the kind's verdicts (rule 2). An exit into a failure terminal fails the attempt.
- `attempts({ of, model })` therefore answers "how often does this model succeed on this kind" in the kind's terms.
- Scenarios 1 and 7 will both use it. It cannot count `exhausted` as success.
- `outcomes` remains for unit verdicts and `byState` (scenario 8). It is a different question, about units rather than models, so it is not a second word for one thing.

### Repair: step-to-state map (critique 3), partly argued

- **Narrowed.**
  - `during` now accepts only `active` states. A step can no longer move a unit to pending, waiting or terminal; exits do that.
  - Many steps to one state is kept: it is ordinary coarsening, and the keys are compile-checked step names, so renaming a step is a compile error, not staleness.
- **Argued.** "AwaitingApproval is active while the attempt holds nothing" is principle 12 as ruled: blocked is an attempt state, not a unit state. The board shows position and attempt status side by side.
- **Repaired: three axes.**
  - Attempt status collapses to `running | blocked`, with `blockedOn` as a reason, not a third status.
  - "Suspended" is gone. "Blocked" is the single word, and "halt" names only the step that blocks on a decision.
  - The unit position `waiting` and attempt `blocked` no longer share vocabulary.

### Principle 15 (current text)

- The parent's `AccountLedger` had `reserve`, an atomic cross-harness operation, and a second store under the ledger's name.
- Quota is now append-only `QuotaEvent`s in a ledger partition, folded at read time, with no lock taken over another harness's state.
- Reservation is local: a harness checks its fold, then appends `consumed` when the invocation settles.
- Two harnesses may briefly overshoot a share by one in-flight invocation each. The principle accepts this in exchange for no cross-harness lock.

### Also addressed from the adversary report

- **The ceiling halt has a shape:** `CeilingDecision`, resuming at the step that would have exceeded the ceiling.
- **Scenario-level fixes for scenario 2** will appear in the scenario files:
  - rejection redrafts with notes inside the attempt instead of exiting to pending;
  - SLA escalation enters a distinct terminal state, so the cause is not guessed.
- **Not addressed:** the two-signatures scenario (halt-scoped grants and per-client decision timing). It is not in the battery, and a surface cut does not add scope.

## Principles broken

None.

- Principle 15 is now followed as amended. The parent's account ledger was a second store with an atomic cross-harness reservation; quota is now an append-only partition of the ledger.
