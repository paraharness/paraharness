# harness-dsl, durable lens, generation 2 (surface cut, extended for scenarios 11 and 12)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

This child is a surface cut of `g01-durable-able-0-2`. It repairs the adversary's three sharpest critiques. It then grows by exactly what scenarios 11 and 12 require.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind.
  - It has a stable id and a `key` (from `Kind.key`).
  - At most one non-terminal unit per lane holds a given key. Signals route to that unit, and creation deduplicates on it.
- **Attempt**: one pass of the lane's flow over a unit, from a start step to an exit.
  - It ends with exactly one outcome: **succeeded**, **failed** or **cancelled**. Rule 2 says which.
  - While open, an attempt is either *running* (executing a step, holding a slot) or *blocked* (holding nothing).
  - A blocked attempt records what it is blocked on:
    - `decision`: a halt;
    - `timer`: a `wait`;
    - `children`: a `spawn`;
    - `batch`: a submitted batch;
    - `job`: a submitted external job;
    - `recovery`: parked after a crash.
- **Step**: a named node of a flow.
  - Step types: `step`, `halt`, `wait`, `spawn`, `loop` and `exit`.
  - Step outputs are recorded and form replay state.
- **Invocation**: one call of an executable within a step. The executable is a command, a model call, or one submit or poll of a job.
  - A retry is a new invocation.
  - Cost, tokens, model, account and runner are recorded per invocation.

"Run" is not used.

## Lifecycle (principle 12)

- **States.**
  - `H.state(name, 'pending' | 'active' | 'waiting')` declares a non-terminal state.
  - `H.terminal(name, verdict)` declares a terminal state. Its verdict is `'success'`, `'failure'` or `'neutral'`, with no default.
- **Kinds** declare:
  - `.initial(state)`;
  - `.onCancelled(state)`.
- **Lanes** declare:
  - an exit map (total, compile-checked);
  - optional `during` (step name to an `active` state);
  - `.retry({ maxAttempts, backoff, initialDelayMs, exhausted })`.
    - `exhausted` is required by the type and must be one of the kind's states. An exhausted policy therefore always has a declared end.
    - A failed attempt below the bound leaves the unit at pending after the backoff.
- **Position is honest.**
  - A unit's position is its state's position, with one exception: while its open attempt is blocked, the unit is at **`waiting`**.
  - So forty contracts awaiting counsel are at `waiting`, hold no WIP, and the board shows them there.
  - The kind declares no "awaiting" state; the halt is recorded once, as the attempt's block.
- **Scheduling.**
  - Only `pending` units are schedulable.
  - `AdmitCtx.active(lane)` counts units at position `active`, which means running attempts.

## Entities

**Kinds** (vocabulary, no backend):
- work kind, state, signal, role, memory kind and command;
- **halt** (`H.halt(name, decisionSchema)`);
- **resource** (`H.resource(name)`);
- flow and operation.

**Instances** (carry a backend, built in subpaths):
- account, model, runner, workspace, supplier, store, memory store, ledger, client and observer;
- `H.clock` and `H.operator` are kernel suppliers.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store × flow (exit map, params) × retry × leases × order | managed units |
| Agent | role × model (or model policy) × pool | a model-call executable |
| Job | submit executable × collect executable × poll interval | a submit-and-collect executable |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × memory store × recall × reader/recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples (rate) or amounts (total) | a windowed figure with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | ledger, lanes, journals, triggers, metrics, scheduler, clients, observers | a running harness |

## Rules

1. **Flows know no states.**
   - A flow states its minimum input shape and its params, and ends at named exits.
   - One flow serves several lanes. For example, scenario 11 uses one Contract flow under two retry policies.
2. **Attempt outcome is defined by the kind's verdicts.**
   - An attempt **fails** when a step fails after its retries, or when its exit maps to a `failure` terminal.
   - It **succeeds** when its exit maps to any other state.
   - It is **cancelled** by `H.cancel`, by `restart`, or by `enter` into a terminal state.
   - A crash is never an outcome.
3. **Signals.**
   - A supplier route may `create` a unit or `signal` one.
   - `Lane.on(signal, { update, restart, enter, resolve })`:
     - `update` merges the payload into attributes. A running attempt is not disturbed, and its next step reads the new attributes.
     - `restart` cancels the open attempt and starts a new one at a typed step.
     - `enter` moves the unit to a state.
     - `resolve` maps halt step names to a decision built from the payload. If the attempt is blocked at that halt, the signal resolves it, recorded with `resolvedBy: 'signal'`. Otherwise `resolve` does nothing and `update` still applies.
   - A signal with no reaction is a startup error.
4. **Creation deduplicates by key**, recorded as `createSkipped`.
5. **Timers re-arm** on `attributesUpdated`. An old deadline never fires.
6. **Trigger sources** fire only from recorded ledger events, and every firing is recorded. The sources are:
   - `transition`;
   - `pattern`;
   - `timer`;
   - `step`;
   - `invocation`;
   - `crossing`;
   - `halted`: a halt of a kind still open N minutes after its recorded `attemptBlocked`;
   - `decided`: a recorded `decisionRecorded` for a halt;
   - `leased`: a lease taken, with its wait.
7. **Trigger consequences:**
   - `create`;
   - `signal`;
   - `record`;
   - `pause` and `resume`;
   - `run`, which runs an executable outside any unit's attempt. Its invocation is recorded with the firing.
8. **Steps.**
   - Step retry is `{ maxAttempts, backoff, initialDelayMs }`. Each retry is a new invocation.
   - Commands fail on exit codes outside `acceptExitCodes`.
   - Runner preflights run before each command placed there.
   - `FlowCtx.iteration` is the 0-based index of the innermost enclosing loop iteration.
9. **Halts are entities.**
   - `H.halt(name, schema)` names a question and its decision shape.
   - A flow step `halt(stepName, halt, { ask, skip, clock })` asks that question at a place in the flow. Grants, metrics, timers and policies reference the halt entity, never a string. The step name is the halt's address in the flow.
   - **Resolvers.** A decision is recorded with `resolvedBy`, which is one of:
     - `human` (with the client name);
     - `policy`;
     - `clock`;
     - `signal`.
   - **Policy resolution.** `skip` is a registered `HaltPolicy` (`H.policy.halt`) or an inline function. Inline is kept only for the scenarios written before this change.
     - A policy decision is recorded as `policyDecision` with `reads`: every metric figure the policy read, with its value and samples.
   - **Clock resolution.** `clock: { afterMinutes, decide }` arms a timer from the recorded `attemptBlocked`, never from unit data.
     - On expiry the halt resolves with `decide(ctx)`, and the **same attempt continues**.
     - Any human decision recorded first clears the timer.
   - **Bounded returns.** `loop(..., { max, counts, until })` bounds a loop by the iterations for which `counts` holds. "After the second counsel return, decline" is `max: 2, counts: returned`. The kernel counts; the flow holds no counter and reads no ledger.
10. **External jobs.**
    - `H.job(name, { submit, collect, every })` is an executable.
    - **Submit.** The kernel invokes `submit` once and records `jobSubmitted` with its output as the handle. The attempt then blocks on `job` and holds no WIP and no runner slot.
    - **Collect.** Every `every.minutes`, the kernel invokes `collect(handle)`, which returns a `JobPoll`:
      - `running`: keep waiting;
      - `succeeded`: the step output;
      - `failed`: a step failure, and so an attempt failure.
    - **Restart.** On restart, an attempt with `jobSubmitted` and no `stepEnded` resumes polling. It never resubmits.
    - A batch of model calls is the model-driver specialisation of the same rule. The two are kept apart only because the batch discount is priced per invocation.
11. **Leases and order (lane).**
    - **Leases.** `Lane.lease(unit => ({ resource, mode }))` takes the lease before the attempt runs and holds it while the attempt runs.
      - `exclusive` excludes every other lease on that resource; `shared` excludes only `exclusive`.
      - Lease state is ledger state: `leaseWaiting`, then `leaseTaken` with `waitedMs`, then `leaseReleased`.
      - A unit whose lease is unavailable stays pending.
    - **Order.** `Lane.order(unit => sequenceKey, { onEarlierFailed })` makes a unit schedulable only when every unit of the lane with a smaller key is terminal with verdict `success`.
      - If an earlier unit is terminal with any other verdict, the later unit moves to `onEarlierFailed`. That state must be a `waiting` state, which the type checks. The transition records the earlier unit as its `reason`.
      - Order is independent of supply order.
12. **Determinism.**
    - The following choices are recorded once as `policyDecision` and replayed:
      - exit predicates;
      - loop bounds;
      - halt policies;
      - clock decisions;
      - model, account and scheduler choices.
    - Policies read a `Metrics` snapshot.
13. **Capacity.**
    - Only running attempts hold runner slots, lane WIP, account reservations and leases.
    - `rank` is ascending.
14. **Cost ceiling.**
    - With `Lane.ceiling` and `onExceed: 'halt'`, the attempt blocks on `CeilingDecision`.
15. **Metrics.**
    - Rate metrics (`samples`) and total metrics (`amounts`) each carry `samples` beside every figure.
    - Built-in queries:
      - `outcomes`;
      - `attempts`, which includes `retries`, the attempts started under the lane's retry policy;
      - `paused`;
      - `decisions`: the median time to decision per halt, by resolver and by client, with sample counts.
16. **Accounts and quota.**
    - Quota is an append-only `QuotaEvent` partition of the ledger, folded at read time.
    - `ModelDriver.serves(account)` is checked at startup.
17. **Memory.**
    - The kernel owns the envelope.
    - Recall is deterministic: it filters by scope, ranks by specificity or similarity, and breaks ties by track record.
18. **Restart.** The author writes no resumption code.
    - **Single writer.** A writer claim with a TTL; a stale writer's appends are rejected.
    - **Completed steps** are never re-run.
    - **The running step** is handled by `afterCrash`: `rerun`, `park` (unless `alreadyDone`), or `askDriver`.
    - **Halts.** A decision recorded while the harness was down is found on restart. Halt clocks and `halted` triggers re-arm from the recorded block time.
    - **Batches and jobs** are collected by handle, never resubmitted.
    - **Loops resume** at the first iteration with no `stepEnded`. A backfill restarts at its next batch.
    - **Definitions.** A `flowVersion` mismatch parks the attempt.
19. **Control API.**
    - A client is granted operations.
    - `H.ops.resolve(halt)` is the grant to resolve one halt and nothing else. `blockersResolve` grants every halt and the ceiling.
    - Plain HTTP and the Claude Code supervisor are two `Client` backends.
20. **Startup validation.** `start()` fails on any of the following.
    - All of the parent's checks still apply.
    - A lane with neither `.retry` nor the deprecated `Kind.onAttemptFailed`.
    - A halt step whose `skip` policy targets a different halt.
    - A `clock` whose decision fails the halt's schema on a sample unit.
    - A grant naming a halt that no registered flow asks.
    - `Lane.order` on a lane whose units can be created with duplicate sequence keys.
    - A job whose `collect` executable cannot run on any registered runner.

## What changed and why

### Surface cut (operator, earlier in this generation)

These were removed because no scenario called them:

- `Flow.await`, `Agent.budgetTokens`, `Command.env` and `H.retry`;
- `H.recall`, the journal generics, `Metric.from` and `Operation.input`;
- the daily, weekly and monthly clock methods;
- `Harness.pools`, `AccountLedger`, `RunningHarness` and `stop`;
- `meanCostUsd` and `renewWriter`;
- unused options, context fields, event fields and adapter fields.

Three repairs were made:

- **Model-to-pool routing.** The agent names its pool, and `ModelDriver.serves` is checked at startup.
- **One definition of success.** Attempt outcome derives from the kind's verdicts.
- **`during` narrowed.** It accepts only `active` states.

Quota became a ledger partition (principle 15).

### Scenarios 11 and 12

**Halts as entities** (`H.halt`, `Halt<N, D>`):
- Scenario 11 needs a grant, a metric, a timer and a policy that all reference "signoff" by identity.
- Each flow step gets a separate step name, which partly addresses known weakness 3.
- The inline `halt({ ask, decision, skip })` form remains as an overload for the scenarios written earlier.

**Halt resolution:**
- **`HaltPolicy`** (`H.policy.halt(name, kind, halt, decide)`): a registered skip whose decision records the metric figures it read. A predicate inline in the handler could not record what it read.
- **Halt `clock`:** a third resolver, measured from the recorded block. It resolves the halt; it does not cancel the attempt.
- **`DecisionSource`** (`human | policy | clock | signal`) on `decisionRecorded` replaces the boolean `auto`, which could not tell a clock from a policy.
- **`H.ops.resolve(halt)`:** a grant names the halt. The counsel dashboard and the finance supervisor get disjoint rights over the same unit.

**Lane additions:**
- **`Lane.retry` with a required `exhausted` state:** retry differs per lane for one kind. Omission is a startup error, never an infinite loop. `Kind.onAttemptFailed` is deprecated; see Principles broken.
- **`Lane.lease` and `H.resource`:** named shared things with exclusive and shared modes. The lease is ledger state. Wait time is visible through `H.when.leased`.
- **`Lane.order`:** ordering between units of one kind, with a declared waiting state for a unit whose predecessor failed.

**Flow additions:**
- **`Reaction.resolve`:** a redline arriving while the unit waits on counsel resolves the counsel halt as `redlined`. The loop then re-enters at `draft`, in the same attempt. A redline arriving mid-draft only updates attributes, so it is not lost and is applied in the next round.
- **`loop` `counts`:** bounded returns without arithmetic in the flow. Redlines re-enter without counting against the bound.
- **`H.job`:** submit and collect as one executable that holds no capacity while it runs.
- **`FlowCtx.iteration`**, which had been removed in the cut, is back. Scenario 12's backfill addresses its batch by iteration, so it resumes at the next batch with no checkpoint.

**Trigger and metric additions:**
- **`H.when.halted`, `H.when.decided`, `H.when.leased` and `Trigger.run`:** deputy paging 20 minutes after the recorded block; metrics over decisions; lock wait per database.
- **`StepEvent.durationMs`**, also removed in the cut, is back for GPU hours in flight.
- **`Metrics.decisions` and `AttemptCounts.retries`:** median time to decision per halt and resolver, and retries per lane, with sample counts.

**Position honesty:** a unit whose attempt is blocked is at `waiting`. Without this, scenario 11's forty contracts awaiting counsel would read as active.

The lane now carries more concerns: retry, lease and order beside the exit map, WIP and ceiling. That is known weakness 6 made heavier, accepted because each concern is per-lane in the battery (scenario 11 retry, scenario 12 lease and order).

## Principles broken

- **12, partly.** `Kind.onAttemptFailed` is retained (deprecated), and it is a kind declaring a failure move. It exists only so the scenarios written before `Lane.retry` still compile. New scenarios use `Lane.retry` and never call it. It is removed when scenarios 1–10 migrate.
- **22, partly.** The inline `halt({ ask, decision })` overload is a second way to write a halt. It is retained for the same migration reason.
