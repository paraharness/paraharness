# harness-dsl, durable lens, generation 1 (merge: Budget into Metric)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind. It has a stable id and a `key` (from `Kind.key`). At most one *non-terminal* unit per lane holds a given key; that is what signals route to and what deduplicates creation.
- **Attempt**: one pass of the lane's flow over a unit, from a start step to an exit. It has exactly one of three outcomes: **succeeded** (reached an exit), **failed** (a step failed after its retries), **cancelled**. While open it has a status:
  - *running*: executing a step, holds a slot;
  - *blocked*: halted on a decision, holds nothing;
  - *suspended*: at an `await`, `wait`, `spawn` or a submitted batch, holds nothing.
  An attempt interrupted by a crash is the *same* attempt after restart (rule 14).
- **Step**: a named node of a flow (`step`, `halt`, `await`, `wait`, `spawn`, `loop`, `exit`). Step outputs are recorded and form replay state.
- **Invocation**: one call of an executable (a command or a model call) within a step. A retry is a new invocation. Cost, tokens, model, account and runner are recorded per invocation.

"Run" is not used.

## Lifecycle (principle 12 as it stands)

- A **state** declares a **position**: `H.state(name, 'pending' | 'active' | 'waiting')`, or `H.terminal(name, 'success' | 'failure' | 'neutral')`. The verdict has no default.
- A **kind** lists its states and says, in its own vocabulary, where the unit goes when things happen to an attempt:
  - `.initial(state)`: entry state (may be `waiting`: an onboarding tenancy is not schedulable).
  - `.onAttemptFailed(state)`: optional. Without it a failed attempt leaves the unit where it was; the failure still counts in attempt metrics.
  - `.onCancelled(state)`: where `H.cancel` takes the unit. Required if the kind can receive `H.cancel` without a lane reaction (startup check).
- The lane maps a flow's **exits** to states (total, compile-checked) and optionally its step names to `during` states. An unmapped step leaves the state unchanged.
- **Scheduler and board are defined on positions.** Only `pending` units are schedulable. `waiting` units hold no capacity.
- **Two families of rate, never mixed:**
  - Unit verdicts: `outcomes({ of })` returns `success`, `failure`, `neutral`, `successRate = success / (success + failure)`, `samples = success + failure`, and `byState` keyed by the kind's own state names (a misspelling does not compile).
  - Attempt outcomes: `attempts({ of, model, agent, runner, account })` returns succeeded, failed and cancelled, plus `interrupted` reported apart and never in the denominator.

## Entities

**Kinds** (vocabulary, no backend): work kind, state, signal, role (driver-neutral intents), memory kind (`.trust('experience' | 'taste')`), command, flow, operation.

**Instances** (carry a backend, built in subpaths): account, model, runner, workspace, supplier, store, memory store, ledger, account ledger, client, observer. `H.clock` and `H.operator` are kernel suppliers. Instances carry no relationships:
- a model no longer names a pool;
- an account no longer names a ledger.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store × flow (exit map, params) | managed units |
| Agent | role × model or model policy | a model-call executable |
| Pool | accounts × share caps × drain policy × account ledger | quota-eligible access |
| Journal | memory kind × memory store × recall × reader/recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples (rate) or amounts (total) | a windowed figure with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | the above, plus ledger, pools, clients, observers | a running harness |

## Rules

1. **Flows know no states.** A flow states its minimum input shape and params, and ends at named exits. One flow serves Bug (`rounds: 3`) and Feature (`rounds: 5`) through two lanes.

2. **Signals.** A supplier route may `create` a unit or `signal` one, by key or by a predicate over a `UnitView` typed with the kind's state names. `Lane.on(signal, { update, restart, enter })`:
   - `update` merges the payload into attributes;
   - `restart` cancels the open attempt and starts a new one at a typed step name;
   - `enter` moves the unit to a state. Entering a terminal state cancels any open attempt.
   An unhandled signal is buffered for `await`. `H.cancel` is the built-in signal.

3. **Creation deduplicates by key.** Creating a unit whose key has an open (non-terminal) unit in that lane is a no-op, recorded as `createSkipped`. "One Audit per category while open" is `Audit.key(a => a.category)`. No separate dedup concept.

4. **Timers re-arm.** `H.when.timer(lane, { at })` is evaluated on unit creation and after every `attributesUpdated`.
   - A changed deadline records `timerCleared('rearmed')` and a new `timerSet`.
   - `undefined` disarms the timer.
   - Terminal units clear their timers.
   - An old deadline never fires. Extending an SLA through `H.ops.workUpdate` moves the breach.

5. **Trigger sources** (all fire only from recorded ledger events, and each firing is recorded):
   - `transition` (filter by state, position or verdict);
   - `pattern` (N consecutive per group key);
   - `timer`;
   - `step` (typed output, plus `models` and `outputs` keyed by the flow's own step names);
   - `invocation`;
   - `crossing`.

   A **crossing** watches a rate metric per group with hysteresis: `enter` and `exit` thresholds, a window and `minSamples`.
   - After each recorded event that feeds the metric, the engine recomputes the rate.
   - When a group's rate crosses a threshold, the engine appends a `crossing` event with edge, value, hits and samples.
   - A group that has entered cannot enter again until it has exited, so one crossing yields one firing.

6. **Trigger consequences**:
   - `create` in a lane;
   - `signal` a unit by key in a named lane;
   - `record` into a journal, optionally as a `candidate`;
   - `pause` or `resume` a lane, with a reason string carrying the metric value.

   Pause and resume are `lanePaused` and `laneResumed` ledger events. The board shows them. `metrics.paused({ lane })` returns total paused ms and the count. A paused lane starts nothing new; its running attempts finish.

7. **Steps.**
   - Retry and timeout are step declarations. Each retry is a new invocation.
   - A command step fails when the exit code is not one the command accepts. `acceptExitCodes` defaults to `[0]`. Accepted non-zero codes are recorded in the step's output, so a flow branches on them through an exit predicate or a `halt.skip`.
   - A runner's preflight check runs on the runner it guards, before each command placed there. A failed preflight is a failed invocation and counts against the step's retry.

8. **Determinism.** Exit predicates, loop bounds, `halt.skip`, model, account and scheduler choices are each recorded once as a `policyDecision` and read back on replay. Policies read a `Metrics` snapshot taken at decision time.

9. **Capacity.**
   - Only running attempts hold runner slots, lane WIP and account reservations.
   - `AdmitCtx.active(lane)` counts units at position `active` in that lane, whatever their attempt status. A blocked Incident is still active.
   - `Scheduler.rank` orders pending units of a lane ascending: the smallest key starts first.

10. **Cost.**
    - `Lane.ceiling` checks projected unit cost before every invocation.
    - Spend across units is a **total metric** (rule 11).
    - Batch invocations are priced by the driver at the batch rate and flagged `batch`.

11. **Metrics** (the merge).
    - `H.metric(name).from(source)` followed by either:
      - `.samples(e => [{ group, hit }])`, queried with `rate()`, which returns `rate`, `hits` and `samples`;
      - `.amounts(e => [{ group, amount }])`, queried with `total()`, which returns `total` and `samples`.
    - Windows are rolling (`lastDays`, `lastHours`) or calendar (`calendar: 'day'`, `tz`).
    - Scenario 3's daily budget is a total of invocation cost over `calendar: 'day'`, compared in an `admit` policy against the owner's constant of 40.
    - Owner metrics from operator actions read `step` events of halts, because halt decisions are recorded steps.

12. **Pools.**
    - A harness registers its pools. The engine serves a model from the first registered pool whose accounts' `family` the model's driver accepts. Agents therefore stay role × model.
    - `Pool.ledger(accountLedger)` names where its accounts' quota state lives. The default is the harness ledger.
    - Two harnesses whose pools name the same account ledger see each other's cooldowns at `reserve` time, atomically in the backend.
    - Share caps are per pool, so per harness.

13. **Memory.**
    - The kernel owns the envelope (id, created, status, `when`, `mergedInto`, track record).
    - Recall is deterministic: it filters by scope, ranks by specificity or by backend similarity score, and breaks ties by track record.
    - Reads take the union of all journals visible to the role.
    - Each write names one journal. The writer is one of:
      - an agent whose role is in `recordedBy`;
      - a trigger;
      - a client holding `H.ops.memoryWrite`.
    - Human reviewers and the owner are clients, never roles, so "who writes" is never a role check for humans.

14. **Restart.** The author writes no resumption code. The mechanisms:
    - **Single writer.** On `start()` the harness calls `Ledger.claimWriter(holder, ttl)` and renews it while running. A second process against the same ledger refuses to start while the claim is live, and takes over only after expiry. Every `append` carries the writer id and is rejected for a stale writer.
    - **Completed steps.** A step that has a `stepEnded` is never re-run. Its recorded output is replayed at zero cost.
    - **The step that was running.** The engine appends `attemptInterrupted`, which is excluded from every rate, then applies the step's `afterCrash` declaration:
      - `rerun`;
      - `park` (the attempt goes to waiting reason `recovery`), unless `alreadyDone` returns true, in which case the step continues;
      - `askDriver`: the driver's `session(idempotencyKey)` returns `finished` with the response, `running` (keep waiting), or `lost` (park).

      Defaults: `askDriver` for agents, `park` for commands. Idempotent commands say `rerun`.
    - **Halts.** A halt decision is a `decisionRecorded` event. A control client may append it while the harness is down: decision events are the one write allowed without the writer claim. On restart the decision is found and the flow continues.
    - **Batches.** A `batchSubmitted` batch is collected by id, never resubmitted.
    - **Children.** Spawned children are units with their own transitions. On restart the parent reads their recorded positions. Children still running are other attempts, which recover themselves under the same rules.
    - **Changed definitions.** Each attempt records `flowVersion`, a hash of the step graph up to and including the cursor. On mismatch the attempt is parked with `definitionChanged`. `H.ops.attemptsRecover` chooses `restartFromTop` or `abandon`.
    - The attempt keeps its id throughout.

15. **Control API.** A client is granted operations, not capability strings. The Claude Code supervisor and plain HTTP are two `Client` backends.

16. **Startup validation.** `start()` fails on any of:
    - duplicate descriptor names;
    - a flow that can fall off its end without an exit;
    - an unregistered lane, journal, metric or pool referenced anywhere;
    - a terminal state without a verdict (impossible to build through `H.terminal`, checked anyway);
    - a kind receiving `H.cancel` with neither `onCancelled` nor a reaction;
    - a crossing over a non-rate metric;
    - a batch step on a driver without `submitBatch`;
    - an agent whose model no registered pool can serve;
    - an `askDriver` step on a driver without `session`.

## What changed and why

**The merge: Budget into Metric.**
- Budget was "sum of invocation cost × window × lanes", read by the scheduler.
- Metric was "source × samples × window", read by policies.
- Both are windowed aggregates computed from ledger events and read at decision time. The only differences were the aggregate (sum or rate) and the presence of a cap.
- The child has one noun, Metric, with two measures. The budget's cap moves into the `admit` policy that reads the total.
- This removes `H.budget`, `Budget`, `Harness.budgets`, `AdmitCtx.budget` and `Ledger.spentUsd`.
- The same move gave scenario 9 its sources: `crossing` sits over a rate metric, and `when.invocation` feeds both spend totals and the model error rate.

**What the merge costs in honesty.**
- The $40 is no longer a declared fact. It is a constant inside a policy closure. The board and telemetry can show "spent today" (a metric) but not "remaining of 40" unless the policy author also exposes the cap. Telemetry loses a sentence it could previously say truthfully.
- Budget's lane list becomes a source filter, so "budget" is no longer findable by name in the descriptor graph.
- `Lane.ceiling` was **not** merged. It acts *before* each invocation inside an attempt, a different moment from a windowed aggregate. Merging it would have made it lie about when it fires.

**Repairs to principle 12 (amended after the parent).**
- The sixth outcome `ended` is gone. States now carry position and verdict.
- Experiment: `AWins` and `BWins` are success, `Inconclusive` is neutral.
- Tenancy: `Customer` and `Suspended` are distinct `waiting` states, so the monthly signal can target only `Customer`. `Onboarding` is a waiting `initial` state.
- `Rejected` and `Returned` must now declare a verdict, which fixes the parent's denominator dodge.
- Failure is never hidden: attempt failures are counted in `attempts()` even when the kind moves the unit nowhere.

**Repairs to the other critiques.**
- **String coupling.**
  - `models` on step events is keyed by the flow's step names.
  - `byState` is keyed by the kind's state names.
  - Router predicates see typed states.
  - `LaneRef` and `WorkRef` carry an `entity` discriminator, so an object literal `{ name }` no longer passes as a lane.
- **Instances with relationships.** Models drop `pool` and accounts drop `ledger`. Pools are registered per harness and name their account ledger.
- **Human roles.** `writtenBy` is replaced by `recordedBy`, which is for agent roles only. Humans write through client grants.
- **Scenario 9.** Crossing sources, key-based dedup, lane pause and resume, and re-arming timers.
- **Scenario 10.** The writer claim, `afterCrash`, `alreadyDone`, `session`, `flowVersion`, `attemptsRecover`, and decisions appendable without the writer claim.

**Scenario pass 01–05: gaps found and closed.**
- **`Command.acceptExitCodes(...codes)`** (scenario 5). Validation must halt with its report rather than fail, and verify must report tolerable drift as exit code 3. Previously a non-zero exit had no defined meaning. Now (rule 7) unaccepted codes fail the step, and accepted ones are output. This one method replaces any need for a "soft failure" concept.
- **`StepEvent.outputs`** (scenario 2). The approval-rate metric groups by the category the classify step produced, and the halt's own output does not carry it. Outputs are keyed by the flow's step names, mirroring `models`. Without this the decision schema would have had to echo the category, which is a lie about what the reviewer decided.
- **`sqlite.scan` supplier** (adapter only, scenario 3). "Re-open topics tagged recurring" needs a supplier that reads stored units on a schedule. A clock tick carries no data, and timers clear when a unit becomes terminal. It is a backend concern, so it lives in `harness-dsl/sqlite` and takes a kernel `Clock` as its schedule.
- **`ZendeskEvent.status`** (adapter only, scenario 2), so "closed by customer" can be routed as a signal.
- **Clarified, no new surface:**
  - preflight runs on the runner it guards (scenario 4: the disk check names no runner, which avoids two descriptors of one host);
  - `enter` into a terminal state cancels the open attempt (scenario 2: SLA breach);
  - `rank` is ascending (scenario 2);
  - `AdmitCtx.active` counts by position (scenario 4: a blocked Incident still blocks new Backups).

## Principles broken

None.

- Principle 12 was broken by the parent and is now followed as amended.
- Principle 15: account quota state lives in an `AccountLedger`. This is a ledger, the kernel's only kind of state, partitioned so it can be shared. It is not a work store.
