# harness-dsl, durable lens, generation 2 (merge: Halt into Await)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind, with a stable id and a `key` (from `Kind.key`). At most one non-terminal unit per lane holds a given key. Signals route by key, and creation deduplicates by key.
- **Attempt**: one pass of the lane's flow over a unit, from a start step to an exit. It ends with exactly one outcome:
  - **succeeded**: it reached an exit whose mapped state does not carry the `failure` verdict;
  - **failed**: a step failed after its retries, or the exit maps to a `failure` state;
  - **cancelled**.

  While open, an attempt has one of two statuses:
  - *running*: it holds a slot;
  - *blocked*: it holds nothing. `blockedOn` gives the reason: `decision`, `signal`, `timer`, `children`, `batch`, `budget` or `recovery`.

  `blockedOn: 'decision'` is principle 12's "waiting on a human".
- **Step**: a named node of a flow. Work steps are `step`. Wait steps are `await`, `wait`, `spawn` and `batch`. Flow control is `loop` and `exit`; a loop's name is a ledger label, not a step. Step outputs are recorded and form replay state.
- **Invocation**: one call of an executable within a step. A retry is a new invocation. Cost, tokens, model, account and runner are recorded per invocation.

"Run", "halt" (as a separate construct) and "suspended" are not used.

## Lifecycle (principle 12)

- **States and positions.** A state declares its position with `H.state(name, 'pending' | 'active' | 'waiting')`. A terminal state declares its verdict with `H.terminal(name, 'success' | 'failure' | 'neutral')`. There is no default verdict.
- **A kind** declares:
  - `.initial(state)`;
  - `.onAttemptFailed(state)`, optional;
  - `.onCancelled(state)`.
- **Default on failure.** A failed attempt returns the unit to the pending state it was scheduled from. The lane's `.retry(Retry)` governs when it runs again; the default is uncapped exponential backoff.
  - A finite `maxAttempts` requires the kind to declare `onAttemptFailed`, which is where the unit goes after the last attempt (startup check).
  - If the kind declares `onAttemptFailed` and the lane declares no retry, the first failure moves the unit.
- **The lane's handler map** has two parts, and the compiler checks both:
  - `exits`: total over the flow's exits.
  - `during`: total over the flow's steps. Every work step maps to a state at position `active`. Every wait step maps to a state at position `waiting`. This is enforced by `ActiveOf<S>` and `WaitingOf<S>`.

  Position therefore always agrees with capacity: a running attempt means the unit is active, and a blocked attempt means it is waiting.
- **Two kernel-originated exceptions.** A `budget` block and a `recovery` park can happen at any step. The unit keeps its current state, and the board shows the attempt's `blockedOn`. Capacity is still released.
- **Scheduler and board are defined on positions.** Only `pending` units are schedulable.
- **Two families of rate, which agree:**
  - `outcomes({ of })` counts unit verdicts: `success`, `failure`, `neutral`, `successRate = success/(success+failure)`, `samples`, and `byState` keyed by state name.
  - `attempts({...})` counts attempt outcomes. Because attempt success is now defined by the verdict of the exit's state, an attempt that ends `exhausted → Exhausted(failure)` counts as failed. `interrupted` is reported apart and is never in a denominator.

## Entities

**Kinds** (vocabulary, no backend): work kind, state, signal, role (driver-neutral intents), memory kind, command, flow, operation.

**Instances** (carry a backend, built in subpaths): account, model, runner, workspace, supplier, store, memory store, ledger, quota partition, client, observer. Instances carry no relationships. Models and accounts no longer carry `family` strings.

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store × flow (exit/during map, params, retry, ceiling) | managed units |
| Agent | role × model or model policy | a model-call executable |
| Pool | accounts × served models × shares × drain policy | quota-eligible access to those models |
| Journal | memory kind × memory store × recall × reader/recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples (rate) or amounts (total) | a windowed figure with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | the above, plus ledger and its partitions, pools, clients, observers | a running harness |

## Rules

1. **Flows know no states.** A flow states its minimum input and params, and ends at named exits. One flow serves Bug (`rounds: 3`) and Feature (`rounds: 5`) through two lanes.

2. **Signals and await (the merge).** There is one mechanism for "the flow waits for something from outside": a **signal**, which is a typed payload addressed to a unit.
   - `flow.await(name, signal, { ask?, skip? })` blocks the attempt until that signal is delivered to the unit. The payload becomes the step's output.
     - With `ask`, the block is `blockedOn: 'decision'` and the ask text is shown to clients.
     - Without `ask`, it is `blockedOn: 'signal'` (a vendor reply, a webhook).
     - `skip` resolves the await deterministically. The decision is recorded with `auto: true`.
   - **Who may send.** A signal can come from a supplier route, a trigger, or a client holding `H.ops.send(signal, { lanes })`.
     - Grants are per signal and optionally per lane. Two halts resolved by two different clients use two signals and two grants, and neither client can resolve the other's halt.
     - A client-sent signal is accepted only when one of two things holds: an attempt of that unit is blocked on it at an `await` with `ask`, or the lane has a reaction to it. Otherwise it is recorded as `signalRejected`. An early approval therefore cannot pre-approve a draft nobody has seen.
   - **Order of handling** when a signal arrives:
     1. An open attempt blocked on it at an await consumes it.
     2. Otherwise a `Lane.on(signal, { update, restart, enter })` reaction runs. `enter` into a terminal state cancels the open attempt.
     3. Otherwise the signal is buffered for a later await. This applies only to non-client senders.
   - **Built-in signals:**
     - `H.cancel` (`{ reason? }`);
     - `H.answer` (`{ text }`), which resolves an agent's own `halt` intent and resumes its session;
     - `H.overBudget` (`{ proceed, raiseMaxUsd? }`), which resolves a ceiling block.
   - `StepEvent.by` names the client, trigger or supplier that sent the signal. `StepEvent.auto` marks skips. `durationMs` of an await step is time-to-decision.

3. **Creation deduplicates by key.** Creating a unit whose key has an open unit in the lane is recorded as `createSkipped`.

4. **Timers re-arm.** `H.when.timer` is evaluated on unit creation and after every `attributesUpdated`.
   - A changed deadline records `timerCleared('rearmed')` followed by a new `timerSet`.
   - `undefined` disarms the timer.
   - Terminal units clear their timers.
   - An old deadline never fires.

5. **Trigger sources** fire only from recorded ledger events, and each firing is recorded. The sources are:
   - `transition`. Every transition carries a `cause`: `created`, `step`, `exit`, `attemptFailed`, or `signal` with the signal and the sender. An Escalation therefore knows whether `slaBreached` or a failure put the unit in `Escalated`.
   - `pattern` (N consecutive per group).
   - `timer`.
   - `step`.
   - `invocation`.
   - `crossing`. This is a rate metric with hysteresis: enter and exit thresholds, a window and `minSamples`. It yields one firing per crossing.

6. **Trigger consequences** are `create`, `signal`, `record` (optionally as a candidate), and `pause` / `resume` a lane.
   - Pause and resume are recorded as `lanePaused` / `laneResumed` with a reason, and are queryable through `metrics.paused`.
   - A paused lane starts nothing new; its running attempts finish.

7. **Steps.**
   - Retry and timeout are step declarations.
   - A command step fails on an exit code not in `acceptExitCodes` (default `[0]`). Accepted codes are output, so a flow can branch on them.
   - A preflight runs on the runner it guards and counts against the step's retry.
   - `flow.batch(name, agent, tasks)` submits one cloud batch. It is a wait step (`blockedOn: 'batch'`) priced at the batch rate.

8. **Determinism.** Exit predicates, loop bounds, `skip`, and the model, account and scheduler choices are each recorded once as a `policyDecision` and read back on replay. Policies read a `Metrics` snapshot taken at decision time.

9. **Capacity.**
   - Only running attempts hold runner slots, lane WIP and account access.
   - `AdmitCtx.count(lane, ...positions)` counts units by position. "No new Backup while an Incident is open" is `count(incidents, 'active', 'waiting') === 0`.
   - `rank` is ascending.

10. **Cost.**
    - `Lane.ceiling({ maxUsd, onExceed })` checks projected unit cost before each invocation. `fail` fails the attempt.
    - `halt` blocks the attempt on `H.overBudget` (`blockedOn: 'budget'`) with a kernel-written ask stating the spent, projected and maximum amounts. It resumes at the same invocation if `proceed`, and fails the attempt otherwise.
    - Spend across units is a total metric.

11. **Metrics.**
    - `H.metric(name).from(source)` followed by `.samples(...)` gives a rate (`rate`, `hits`, `samples`).
    - `H.metric(name).from(source)` followed by `.amounts(...)` gives a total (`total`, `samples`).
    - Windows are rolling (`lastDays`, `lastHours`) or calendar.

12. **Pools serve models.** `Pool.serves(...models)` names which models a pool provides.
    - An agent's model, or every candidate of its model policy, must be served by exactly one registered pool (startup check).
    - Registration order means nothing.

13. **Shared quota is a ledger partition** (principle 15 as ruled).
    - `harness.ledger(ledger, { quota: QuotaPartition })`. The partition is append-only `QuotaEvent`s: `consumed`, `limited` (cooldown observed), `windowObserved`.
    - Each harness appends its own consumption. The kernel folds the window for each account at read time, at every account decision, into `AccountState`. Share caps are folded against the harness's own `consumed` events.
    - No harness takes a lock, and the partition never touches the ledger's writer claim.
    - The cost: two harnesses may both see headroom in the same second and both start. The overshoot is bounded by one reservation each, and the next fold sees it. The design admits this rather than inventing a lock.

14. **Memory.**
    - The kernel owns the envelope.
    - Recall is deterministic: filter by scope, rank by specificity or by backend similarity score, then break ties by track record.
    - Reads take the union of all journals visible to the role. Each write names one journal.
    - A write comes from an agent whose role is in `recordedBy`, from a trigger, or from a client holding `memoryWrite`. Curation (accept, merge, drop) requires `memoryCurate`.

15. **Restart.** The author writes no resumption code.
    - **Single writer.** The harness calls `claimWriter` with a TTL and renews it while running. A second process refuses to start while the claim is live, and takes over only after it expires. Appends from a stale writer are rejected.
    - **Completed steps** are replayed from their recorded outputs at zero cost.
    - **The step that was running.** The engine appends `attemptInterrupted`, which is excluded from every rate, then applies the step's `afterCrash`:
      - `rerun`;
      - `park`, unless `alreadyDone` returns true;
      - `askDriver`, which calls `session(idempotencyKey)`.
    - **Client signals while the harness is down.** `Ledger.deliver(signal)` is the one write allowed without the writer claim. An approval given while the harness was down is therefore found on restart.
    - **Batches** are collected by id, never resubmitted.
    - **Children** are read from their recorded positions. Children still running are other attempts and recover themselves under the same rules.
    - **Changed definitions.** `flowVersion` is a hash of the step graph up to the cursor. On a mismatch the attempt parks with `definitionChanged`, and `attemptsRecover` chooses `restartFromTop` or `abandon`.
    - The attempt keeps one id throughout.

16. **Control API.** Clients are granted operations, including per-signal `send` grants. The Claude Code supervisor and plain HTTP are two `Client` backends.

17. **Startup validation.** `start()` fails on any of:
    - duplicate descriptor names;
    - a flow that can fall off its end;
    - an unregistered lane, journal, metric or pool referenced anywhere;
    - a kind receiving `H.cancel` with neither `onCancelled` nor a reaction;
    - a finite lane retry on a kind without `onAttemptFailed`;
    - a crossing over a non-rate metric;
    - a batch step on a driver without `submitBatch`;
    - a model served by zero pools, or by more than one;
    - an `askDriver` step on a driver without `session`;
    - an await of a signal that no supplier, trigger, reaction or client grant can produce.

## What changed and why

**The merge: Halt into Await.**
- `halt(name, { ask, decision, skip })` and `await(name, signal)` both did the same thing: block the attempt, hold nothing, record an outside input, resume with a typed payload. They differed only in who sends the input and whether a question is shown.
- The child has one construct, `await` of a signal, with `ask` marking a human decision.
- This removes:
  - `Flow.halt`;
  - the `decision` schema slot (the schema now lives on the signal);
  - `decisionRecorded` (now `signalDelivered`);
  - `H.ops.blockersResolve`, `workSignal` and `workCancel`, which are replaced by `H.ops.send(signal, scope)`;
  - the attempt status `suspended`.
- The merge pays for itself on the adversary's two-signatures scenario:
  - per-signal grants scope who may resolve which halt;
  - `StepEvent.by` plus `durationMs` give per-client time-to-decision;
  - a read-only auditor holds `workRead` and `telemetryRead` and no `send`.

**What the merge costs in honesty.**
- "A human is being asked" is now marked only by the presence of `ask`. A signal granted to a client can also be produced by a trigger or a supplier. In that case "blocked on a decision" is the author's claim, not a kernel fact. The kernel can say who *did* send it (`by`), but not that only a human *could*.
- A decision schema shared by two awaits must now be one signal. Two halts that ask different questions with the same shape either share a signal, and so share a grant, or the author declares two signals with identical payloads.
- Buffering had to be split. Non-client signals buffer for a later await, as before. Client signals are rejected unless something is waiting for them. Without that, an approval sent early would silently satisfy a later halt. That exception is a rule a reader must learn.
- A median time-to-decision is not expressible. The available measures are a total of `durationMs` and its sample count, which give a mean. Median is a measure the kernel does not have.

**Repairs to the adversary's sharpest critiques.**

1. **Model-to-pool routing.**
   - `Account.family` and `Model.families` are gone. `Pool.serves(...models)` is the relationship, held by the pivot whose noun ("access to these models") it produces.
   - A model must be served by exactly one registered pool, so order is meaningless.
   - In scenario 10, `subscriptionPool.serves(reviewModel)` and `apiPool.serves(summaryModel)` say outright what positional registration used to imply.
2. **Two definitions of success.** Attempt success is redefined against the kind's verdicts (vocabulary, above). Scenario 1's `attempts()` query and scenario 7's `outcomes()` query therefore no longer disagree on the same requirement: an attempt ending in `Exhausted(failure)` is a failed attempt in both. Scenarios will use `outcomes` for the builder policy, since the requirement is "success rate on this kind of work".
3. **Step-to-state map.**
   - `during` is now total and position-checked. Wait steps must map to `waiting` states and work steps to `active` states.
   - `AwaitingApproval` is declared `waiting` and the board stops showing idle work as active. The three axes collapse to position (unit) plus one blocked reason (attempt), and they cannot contradict except in the two named kernel exceptions.
   - "Several steps, one state" remains legal. It is an author's choice of granularity, and totality means a renamed step fails to compile rather than going stale silently.
   - "Halt" and "blocked" no longer name one thing twice: there is no halt construct, and blocked is the attempt status. "Suspended" is gone.

**Other critiques.**
- **Rejection loop (scenario 2).** Scenarios will loop draft and approval inside the flow and exit to a terminal state with a failure verdict once rounds run out. They will not map rejection to the pending state `New`.
- **Ceiling halt shape.** The ceiling now blocks on `H.overBudget`, which has a typed payload, a kernel-written ask and a defined resume point.
- **Escalation cause.** `TransitionEvent.cause` records it.
- **"Human-only" enforcement.** This is not added. A lane flag would be an entity with one use. A human-only flow is one whose steps are awaits and commands, and the board shows each step's model. This is argued, not fixed.

**Principle 12 failure default (ruled after generation 1).**
- The parent's behaviour was "a failed attempt leaves the unit where it was". It is now "the unit returns to the pending state it was scheduled from, under `Lane.retry`".

**Principle 15 shared quota (ruled after generation 1).**
- The parent's `AccountLedger` had `reserve` and `settle` with atomic backend reservation: a lock by another name, and a second store under the ledger's name.
- It is replaced by an append-only `QuotaPartition` of the ledger, folded at read time. `Pool.ledger` is removed.

**Surface.** Removed:
- `Flow.halt`, `Agent.batch` (moved to `Flow.batch`, which is a wait step);
- `Pool.ledger`, `AccountLedger`;
- `blockersResolve`, `workSignal`, `workCancel`;
- `AdmitCtx.active` and `AdmitCtx.pending` (now `count`);
- `Account.family`, `Model.families`.

Added:
- `Pool.serves`, `Lane.retry`, `H.ops.send`;
- `H.answer`, `H.overBudget`;
- `TransitionCause`, `StepEvent.by` and `StepEvent.auto`;
- `QuotaPartition`, `Ledger.deliver`.

## Principles broken

None.

- **Principle 12.** "Blocked" now covers every wait that holds nothing. Its human case is `blockedOn: 'decision'`, which keeps the principle's meaning, and the unit position for a blocked attempt is always `waiting` except in the two named kernel blocks.
- **Principle 15.** The quota partition is a ledger partition of append-only events, folded at read time. It takes no lock and has no writer claim.
