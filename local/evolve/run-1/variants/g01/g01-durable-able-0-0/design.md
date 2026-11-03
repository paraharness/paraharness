# harness-dsl, durable lens, generation 1 (rename: Journal → Playbook)

A unit of work is a durable execution. Its identity outlives processes. Attempts are its continuations, and the ledger is the event history that the engine replays. This child keeps the parent's shape and makes three changes:

1. It renames the weakest pivot noun.
2. It repairs the lifecycle break against amended principle 12.
3. It removes the relationships that the adversary found on instances.

## The rename

**Journal** was the weakest noun (known weakness 17). A journal is a dated record of what happened. That is the opposite of principle 14's "forward-phrased, never history". It also cannot carry curated items: once an item is merged or dropped, it is no longer a journal entry.

The pivot (memory kind × memory store × recall × readers × recorders) produces a set of forward-phrased rules that roles consult before acting. That thing is a **Playbook**.

- **Experience** is a playbook of plays learned in the field: "when touching payments, run the ledger fixture first".
- **Taste** is the owner's style playbook: "prefer early returns".
- **Prior findings** are plays for research: "when researching X, start from Y".
- **Ops notes** are a playbook the supervisor reads.
- **Curation** (accept, merge, drop) is editing a playbook. That is natural; editing a journal is not.

Everything that touched the old noun now uses the new one:

| Before | After |
|---|---|
| `H.journal` | `H.playbook` |
| `Harness.journals` | `Harness.playbooks` |
| `Trigger.record(journal, …)` | `Trigger.record(playbook, …)` |
| `MemoryItem.journal` | `MemoryItem.playbook` |
| `MemoryFilter.journal` | `MemoryFilter.playbook` |
| `ModelResponse.recorded[].journal` | `ModelResponse.recorded[].playbook` |

`writtenBy` becomes `recordedBy`, and it is now for agent roles only (see below).

## Execution vocabulary (one definition each)

**Unit.** One piece of work of one kind.
- It has a stable id and a `key` from `Kind.key`. The key routes signals and deduplicates creation.
- It enters the kind's first declared state.
- Its position is its state's position: pending, active, waiting or terminal.

**Attempt.** One continuation of a unit's flow.
- It starts at the first step, at a `restart` step, or at the top after the supervisor says so.
- It ends with exactly one outcome: **succeeded** (an exit was reached), **failed** (a step failed after its retries), or **cancelled**.
- While open, its status is one of three. Only `running` holds capacity.
  - `running`: holds runner slot, lane WIP and account reservation.
  - `blocked`: halted for a decision; this includes a kernel park after a restart; holds nothing.
  - `waiting`: at `await`, `wait` or `spawn`; holds nothing.
- An attempt that waits two weeks inside an Experiment loop is still one attempt.

**Step.** A named node of a flow: `step`, `halt`, `await`, `wait`, `spawn`, `loop` or `exit`. Step outputs are recorded and form the replay state.

**Invocation.** One call of an executable within a step.
- A retry is a new invocation.
- Its result is `ok`, `error` or `interrupted`.
- `interrupted` means the process died. Interrupted invocations are excluded from every metric and every trigger source.

"Run" is not a ledger concept.

## Entities

**Kinds** (vocabulary, no backend):
- work kind `H.kind`
- state `H.state`
- signal `H.signal`
- role `H.role` (with intents, not tool names)
- memory kind `H.memory`
- command `H.command`
- flow `H.flow`
- operation `H.operation`

**Instances** (carry a backend, built in subpaths):
- Account
- Model
- Runner
- Workspace
- Supplier
- Store
- MemoryStore
- Ledger
- QuotaLedger
- Client
- Observer

`H.clock` and `H.operator` are kernel suppliers.

- **Models no longer carry a pool.** An account declares which models it `serves`.
- **Accounts no longer carry a ledger.** The harness chooses where quota state lives.

**Pivots:**

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store × flow × exit→state map | managed units |
| Agent | role × model or model policy | a model-call executable |
| Pool | accounts × share caps × drain policy, registered per harness | quota-eligible access |
| Playbook | memory kind × memory store × recall × readers × recorders | recalled plays |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples | a rate with sample counts |
| Budget | spend cap × window × lanes | remaining spend |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | everything above, plus ledger, quota, clients and observers | a running harness |

## Rules

### Lifecycle (principle 12, repaired)

1. **States.**
   - A non-terminal state is declared as `H.state(name, 'pending' | 'active' | 'waiting')`.
   - A terminal state is declared as `H.state(name, 'terminal', 'success' | 'failure' | 'neutral')`.
   - There is no overload without a verdict.
   - The scheduler and the board work on positions.
   - The kind's own outcome rate is `success / (success + failure)`, with `samples` beside it. Neutral terminals (inconclusive, parked, churned, walked away) are counted, reported, and queryable by state. They are excluded from the denominator.
   - "Rejected by the approver" and "returned by the editor" are verdicts the kind declares. Scenarios declare them `failure` where they mean failure, so a reviewer whose drafts are always returned lowers the rate.
2. **Flows exit, lanes map.**
   - `handler(flow, { exits, during, failure? })` maps exits to any of the kind's states.
   - `during` maps step names to the kind's non-terminal states. This is enforced in the type.
   - Startup refuses the following:
     - a `wait`, `await` or `spawn` step mapped to a non-`waiting` state;
     - a `step` mapped to a `waiting` state.
   - A `halt` may map to an `active` or a `waiting` state. The battery maps halts to `waiting` states, because a blocked attempt holds no capacity.
   - `failure` is where a failed attempt moves the unit. If it is omitted, the unit returns to the state it held when the attempt started. This is how a failed tenancy review leaves the tenancy a customer. The failed *attempt* is still counted in attempt metrics, so nothing is hidden.
3. **Exits may map to non-terminal states.** A tenancy's `kept` exit maps to `Customer`, which is a `waiting` state. The unit then has no attempt, holds no capacity, and is not schedulable until a signal restarts it.
4. **`H.cancel`.** It cancels the open attempt. Without a lane reaction, the unit returns to its pre-attempt state. `on(H.cancel, { enter: Expired })` ends the unit instead.

### Signals, timers and triggers

5. **Signals.** A supplier route may `create`, `signal` (by key or by predicate) or `skip`. `Lane.on(signal, { update, restart, enter })` reacts.
   - Signals with no reaction are buffered for `await`.
   - **Creation by key is idempotent**: a `create` whose key matches a non-terminal unit in that lane is skipped, and the skip is recorded. This is how a trigger deduplicates by a group key, such as one open Audit per category.
6. **Timers** are ledger events: `timerSet`, `timerCancelled`, `timerFired`.
   - `when.timer(lane, { at, if })` is re-evaluated on every `attributesUpdated` for the unit.
   - If `at` changed, the old timer is cancelled (reason `rearmed`) and a new one is set. The old deadline never fires.
   - Extending an SLA is therefore `ops.workUpdate` on the attribute.
7. **Trigger sources.** Every source reads recorded events only, and every firing is a `triggerFired` event, including skips. The sources are:
   - `transition`
   - `pattern`: N consecutive matches per group
   - `timer`
   - `step`: typed output, plus models keyed by the lane's own step names
   - `invocation`
   - `threshold`

   `threshold(metric, { below, recoverAbove } | { above, recoverBelow }, window, minSamples, groups? })` works like this:
   - After each append that adds a sample to the metric, the kernel evaluates each group.
   - It appends `thresholdCrossed` only when the group's armed state flips. A breach arms the recovery side, and a recovery re-arms the breach side.
   - This is hysteresis with one firing per crossing.
8. **Consequences.**
   - `create` in a lane.
   - `signal`: to the source unit, or to `{ lane, key }`.
   - `record` into a playbook, optionally as a `candidate`.
   - `pause(lane, when?)` / `resume(lane, when?)`.
     - They append `lanePaused` / `laneResumed` with the trigger, the source sequence number and the metric value.
     - The optional predicate selects which source events act. Without it, every event acts.
     - A predicate that returns false records a skipped firing.
     - A paused lane starts nothing new; running attempts finish.
     - The board shows the pause. `metrics.pausedMs` totals it.
     - The operator can do the same through `ops.lanesPause`.
   - The value callbacks of `create`, `record` and `signal` return `undefined` to skip. Their return types are `NoInfer`, so the lane or playbook fixes the type and the callback is checked against it.

### Steps, durability and restart (scenario 10)

9. **Retry and timeout are step declarations.** Each retry is a new invocation.
10. **Restart behaviour is declared per step.** `{ restart: 'rerun' | 'park' | 'ask' | { parkUnless: check } }` sets what happens to the step that was running at a crash. `parkUnless` is a command typed on the step's input, returning `{ done }`.
    - **`rerun`** runs the step again.
    - **`park`** blocks the attempt with `blockedFor: 'restart'`.
    - **`ask`** calls `ModelDriver.status(handle)`. The handle was recorded by `invocationHandle` as soon as the driver started.
    - **The default is `park`.**
    - **Batch steps** record their handle when they submit. After a restart they are collected, never resubmitted.
11. **Restart procedure.** On restart the engine:
    1. claims the writer;
    2. replays;
    3. skips completed steps, using their recorded outputs at no cost;
    4. finds decisions, signals and children recorded while it was down;
    5. appends `invocationEnded{interrupted}` for open invocations and applies each step's rule.

    The attempt keeps its number. An interruption is never a model, agent or account failure.
12. **Definition drift.** `attemptStarted` records `flowHash` and `stepPath`. If the path up to the cursor differs at restart, the attempt is blocked with `blockedFor: 'restart'` and a reason. Resolving that blocker is an ordinary `blockersResolve` decision: `restart` (from the top, same attempt number) or `abandon` (cancelled).
13. **Single writer.**
    - `Ledger.claimWriter(holder, ttlMs)` returns a fenced token.
    - Every `append` carries the token. The backend rejects a stale fence.
    - A second process refuses to start while the first renews its claim, and takes over after the TTL expires.
14. **Determinism.** Policy choices, exit predicates, loop bounds, halt skips and scheduler admissions are recorded as `decision` events and read back on replay. `Metrics` is a synchronous snapshot.

### Capacity, cost and scheduling

15. **Capacity is held only by `running` attempts.**
16. **Cost.**
    - `Lane.ceiling({ maxUsd, onExceed })` checks projected cost before each invocation, for each unit.
    - A Budget sums spend over a window across lanes.
    - Batch invocations are priced at the batch rate by the driver.
17. **Scheduler.**
    - `priority`, `wip`, `boost`, `rank` and `admit` combine into one deterministic decision.
    - Admission sees three counts per lane:
      - `active`: units with a running attempt;
      - `pending`: units that are schedulable;
      - `open`: all non-terminal units, including waiting ones and those with a blocked attempt.
    - Preemption is priority plus admission. Running attempts are never interrupted.
    - Paused lanes are skipped.

### Metrics, memory, accounts and control

18. **Metrics.**
    - `outcomes({ of: lane, model? })` returns `attempts` (succeeded, failed, cancelled, samples, successRate) and `units` (success, failure, neutral, samples, successRate, and `byState` keyed by the kind's state names, typed).
    - Owner metrics are `H.metric(name).from(source).samples(e => [{ group, hit }])`.
    - `rate()` returns `{ rate, hits, samples }`.
    - Windows are given in `windowDays` or `windowHours`.
    - Creation is a transition with no `from`, so "Audits opened per category" is an owner metric over `transition(auditLane, { to: Open })`.
    - A `step` source event carries `steps`: the outputs this attempt recorded before the event, typed by the lane's flow. A metric can therefore group by what an earlier step decided, for example approvals by classified category.
19. **Memory.**
    - The kernel owns the envelope: id, created, status, `when`, `mergedInto` and track record.
    - Recall is a fixed, deterministic policy. It ranks by specificity or by the store's similarity score, and breaks ties by track record.
    - Reads take the union of every playbook of the memory kinds visible to the role. Each write names one playbook.
    - `recordedBy` lists the agent roles that may record through the `record` intent. Humans write through the `memoryWrite` and `memoryCurate` operations. That is one mechanism for each kind of writer, not two for one.
    - **A playbook is a per-harness pivot.** Two harnesses share a playbook's items by declaring a playbook of the same name over the same memory kind and the same `MemoryStore` instance, each with its own readers.
20. **Accounts and quota.**
    - Quota state lives in a `QuotaLedger`. By default this is the harness ledger's own `quota` facet. `Harness.quota(sqlite.quota(...))` points it at a shared file instead.
    - `reserve` is atomic in the backend, so two harnesses see each other's cooldowns immediately.
    - Pools and share caps are registered per harness with `Harness.pools`.
    - An invocation draws from the first registered pool that has an eligible account that `serves` the model.
21. **Control API.** Clients are granted operations. The Claude Code supervisor and plain HTTP are two `Client` backends of one `ControlApi`.
22. **Startup validation.** `start()` fails on any of the following:
    - duplicate descriptor names;
    - a flow without a reachable exit on some path;
    - unregistered lanes, playbooks, metrics, budgets or pools;
    - an unknown `restart` step;
    - a waiting step mapped to a non-waiting state;
    - a signal consequence with no target on a unit-less source;
    - a batch step on a driver without `submitBatch`;
    - an `ask` restart rule on an executable whose driver has no `status`;
    - a model that no registered pool serves.

## What changed and why

- **Journal → Playbook** (operator: rename). The reasons are given in "The rename" above. Every touching API is renamed.
- **Lifecycle repaired to amended principle 12.**
  - The parent's sixth outcome `ended` is gone.
  - States declare a position (adding `waiting`), and terminal states declare a mandatory verdict.
  - Attempts have exactly three outcomes.
  - Suspension is an attempt *status* (`waiting`), not an ending.
  - This fixes the adversary's points: suspended tenancies (a `waiting` state that the monthly clock route can exclude), "AwaitingVendor labelled active", hidden tenancy failures (attempt failure counted, unit stays), the `ended` junk drawer, and the untyped `byState`.
- **Instance relationships removed** (principles 8 and 10).
  - The model drops `pool`.
  - The account drops `ledger`.
  - Pools and quota are chosen by the harness.
  - Scenario 7 no longer needs a duplicate `docs-sonnet` model.
- **Roles no longer stand in for human writers.** `writtenBy` becomes the agent-only `recordedBy`.
- **Raw-string coupling reduced.**
  - `StepEvent.models` is keyed by the lane's step names.
  - `PolicyCtx.lane` replaces the `{ name: ctx.unit.lane }` object literal.
  - Lane-taking APIs accept `LaneRef`, not `Named`.
- **Scenario 9 surface added.**
  - a `threshold` source with hysteresis;
  - an `invocation` source;
  - key-idempotent `create` for group dedup;
  - a targeted `signal`;
  - `pause` / `resume` consequences with `lanePaused` / `laneResumed` events;
  - `ops.lanesPause`;
  - timer re-arming;
  - `metrics.pausedMs`;
  - `Sample.hit`, so a rate can count errors without the word "success".
- **Scenario 10 surface added.**
  - a per-step `restart` rule;
  - invocation handles and `ModelDriver.status`;
  - batch handles collected after restart;
  - `interrupted` invocations;
  - flow hash and step path, with drift parked as a kernel blocker;
  - a fenced single-writer claim on the ledger.
- **`StepEvent.steps` added** (found writing scenarios 2 and 3).
  - **Scenario 2:** the approval metric must group by the category that the `classify` step produced, but the `approve` event carried only its own output.
  - **Scenario 3:** prior findings are recorded only after the citation check passes, so the trigger on `cite` must read the `synthesize` output.
  - **Rejected alternative:** letting flows write unit attributes would open a second write path into the store. Instead, the step source now carries the attempt's earlier outputs, typed by the flow (`{ [K in keyof St]?: St[K] }`).
- **`AdmitCtx.open(lane)` added** (found writing scenario 4).
  - "No new Backup while an Incident is active" must count Incidents halted for acknowledgement.
  - Those units are neither running nor pending, so neither `active` nor `pending` sees them.
  - `open` counts every non-terminal unit of the lane.
- **`zendesk` adapter gains a `closed` event type** (scenario 2).
  - "Closed by customer" had no source event; `updated` was too vague to route honestly.
  - This is an adapter change only; the kernel is untouched.
- **`Trigger.pause` / `Trigger.resume` take an optional `when` predicate** (found writing scenario 9).
  - A threshold source emits both `breached` and `recovered` events.
  - With unconditional `pause(lane)` and `resume(lane)`, one trigger over one threshold would pause and resume on every crossing.
  - Splitting into two sources was rejected: it would need a crossing filter on `when.threshold`, which duplicates the predicate every other consequence already has (returning `undefined`).
  - `pause` and `resume` carry no value, so a boolean predicate is their form of "return undefined to skip".
- **`NoInfer` on consequence and spawn return types** (found writing scenarios 7 and 9).
  - In `Trigger.create`, `Trigger.record` and `Flow.spawn`, the attribute type was also inferred from the callback's return value.
  - A literal attribute (`origin: 'heartbeat'`) could therefore widen to `string` and fail the lane's schema type.
  - The lane or playbook now fixes the type, and the callback is checked against it.
- **Halt mapping stated** (scenarios 6, 8, 9, 10): rule 2 now says a `halt` may map to an `active` or `waiting` state. It was unstated.
- **Shared playbooks clarified** (scenario 7): rule 19 states that cross-harness sharing is a shared memory kind and store, with a per-harness playbook pivot. No new entity.

## Principles broken

None.

- **12** is repaired. The previous break (a sixth outcome) is removed. Neutral terminal verdicts express inconclusive, parked, churned and walk-away outcomes without lying.
- **15** holds. Quota state is a facet of the ledger interface (`Ledger.quota`). Pointing that facet at a shared file is a backend choice, not a second kernel store. No work store exists.
