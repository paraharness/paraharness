# harness-dsl, durable lens (generation 1)

A unit of work is a durable execution. Its identity outlives processes. Each attempt is one continuation of the unit's flow. The ledger is the event history the engine replays. This generation does three things:

- It takes the amended lifecycle skeleton (principle 12) as written.
- It closes the inference holes the adversary found, where raw strings and object literals stood in for typed entities.
- It adds what scenarios 9 and 10 need, using the nouns that already exist where possible.

## Execution vocabulary (one definition each)

**Unit.** One piece of work of one kind. It has a stable id and a `key` (from `Kind.key`). It is always at one **position**: `pending`, `active`, `waiting` or `terminal`. The position comes from its current named state.

**Attempt.** One continuation of a unit's flow, with one id.
- An attempt starts at a step: the first step, a `restart` step, or the step after a suspension.
- It ends with exactly one **attempt outcome**: `succeeded`, `failed` or `cancelled`.
- Reaching an exit or a suspension step (`await`, `wait`, `spawn`) ends it `succeeded`. Its share of the work is done, and the unit moves to the mapped state.
- While open, an attempt is `running` (it holds a slot) or `blocked` (it holds nothing). "Blocked" is an attempt state, never a unit state.
- `blockedFor` gives the reason: `decision` (a halt), `crash`, `definitionChanged` or `ceiling`.

**Step.** A named node of a flow. Its output is recorded once and replayed.

**Invocation.** One call of an executable within a step. A retry is a new invocation, so a step's `retry.retries` counts extra invocations, not attempts. Its handle is recorded before the call proceeds: a session id, or a batch id for a batch.

The word "run" is not used.

## Entities

**Kinds** (vocabulary, no backend):

| Entity | Built with |
|---|---|
| Work kind | `H.kind` |
| State | `H.state(name, position)`, or `H.state(name, 'terminal', verdict)` |
| Signal | `H.signal` |
| Role | `H.role`, with intents |
| Memory kind | `H.memory` |
| Command | `H.command` |
| Flow | `H.flow` |
| Operation | `H.operation` |

A terminal state must declare its verdict: `success`, `failure` or `neutral`. There is no default.

**Instances** (carry a backend, built in subpaths):

- Account
- Model
- Runner
- Workspace
- Supplier
- Store
- MemoryStore
- Ledger
- Client
- Observer

`H.clock` and `H.operator` are kernel suppliers.

**Pivots:**

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store × flow, plus the state map | managed units |
| Agent | role × model or model policy | a model-call executable |
| Pool | accounts × share caps × drain policy, per harness | quota-eligible access |
| Journal | memory kind × store × recall × agent readers/writers | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source → samples | rates with sample counts |
| Band | metric × two thresholds × minimum samples × window | crossings |
| Budget | | remaining spend |
| Scheduler | | start decisions |
| Harness | | a running harness |

## Rules

### Lifecycle and the state map

1. **Lane state map.** `handler(flow, map)` maps the flow onto the kind's states, and every mapping is checked by the compiler against each state's position:
   - `exits` must map to terminal or waiting states.
   - `during` must map to active states.
   - `waits` is required exactly when the flow has suspension steps, and must map each of them to a waiting state.
   - `failure` is required and must map to a non-active state.

   A flow never names a kind's state.

2. **Attempt failure.** A failed attempt is recorded as `failed` whatever the unit does next. Metrics still count the failed attempt.

3. **Initial state.** `Router.create(attrs, { state })` can create a unit directly in a non-terminal state.

4. **Cancellation.**
   - **`H.cancel`.** This signal ends the open attempt `cancelled`. The lane's `.on(H.cancel, { enter })` names the unit's state. `start()` fails if a lane can receive `H.cancel` and has no reaction to it.
   - **Other signals that end the attempt.** Any reaction that `restart`s, or that `enter`s a non-active state while an attempt is open, also ends that attempt `cancelled`. The cancellation is recorded before the reaction applies.

5. **Two success rates, kept apart.**

   | | Formula | Reported beside it |
   |---|---|---|
   | Attempt success rate | `succeeded / (succeeded + failed)` | `samples`; cancelled counted separately |
   | Unit success rate | `success / (success + failure)` over terminal verdicts | `samples`; neutral counted separately |

   `byState` is a mapped type over the lane's state names. A crash is never an attempt outcome.

### Suspension and signals

6. **Suspension.** `await`, `wait` and `spawn` end the attempt and place the unit in its mapped waiting state. Waiting units hold no capacity.
   - The unit's next attempt starts on the signal, on the timer, or when all children are terminal.
   - A spawned child records `parentId`.

7. **Signals.**
   - A supplier route `create`s a unit or `signal`s one, by key or by a predicate over a typed `UnitView`.
   - A lane reacts with `update`, `restart` or `enter`.
   - Signals reach terminal units too. An `enter` of a non-terminal state reopens a terminal unit as a recorded transition, which is how a recurring topic is reopened. Unit counts count each terminal transition once.

8. **Deduplication by key.** `create` into a lane where a non-terminal unit with the same kind key already exists is a recorded no-op (`unitDeduplicated`).

### Timers

9. **Timers are persisted.** A `when.timer` source writes a `timerSet` event.
   - On every `attributesUpdated`, the engine re-evaluates `at` and writes a new `timerSet` that `supersedes` the old one.
   - A superseded timer never fires.

### Triggers

10. **Trigger sources.**
    - `transition`; creation counts as a transition with `from: undefined`.
    - `pattern`: N consecutive matches per group.
    - `timer`.
    - `step`: a typed output, plus `steps`, the typed outputs of earlier steps in the same attempt, and `models`, by step name.
    - `invocation`.
    - `crossing(band, 'down' | 'up')`.

11. **Trigger consequences.**
    - `create`
    - `signal`, with a `UnitRef` target
    - `record`, optionally as a `candidate`
    - `pause` and `resume` of a lane

    Every firing is a `triggerFired` event.

12. **Bands (hysteresis).**
    - A band evaluates its metric per group after each recorded sample.
    - It writes `bandCrossed` with `down` when the rate falls below `below` while the group is normal and has at least `minSamples` samples.
    - It writes `up` when the rate rises above `above` while the group is low.
    - Band state per group is derived from `bandCrossed` events alone, so each crossing fires exactly once and survives a restart.

13. **Lane pause.**
    - `lanePaused` and `laneResumed` carry the trigger, a reason, and the sequence number of the crossing that caused them.
    - A paused lane starts nothing new, and running attempts finish.
    - `metrics.paused(lane, window)` returns the total time paused and the number of pauses.

### Capacity, cost and scheduling

14. **Capacity, cost and the scheduler.**
    - Only running attempts hold capacity.
    - A lane ceiling caps cost per unit.
    - A budget caps cost per window across lanes.
    - Scheduler gates read `count(lane, position)`, `budget`, `metrics` and `now`.
    - Preemption is priority plus admission. Running attempts are never interrupted.

15. **Pools and accounts.**
    - Pools are declared on the harness.
    - Account quota windows live in the ledger, through `reserve`, `settle` and `cooldown`. The SQLite ledger may place them in a shared `accountsPath`.

### Memory

16. **Memory.**
    - The kernel owns the envelope.
    - Recall is deterministic: filter by scope, rank by specificity or by the store's similarity score, break ties by track record.
    - Agents write only to journals whose `writtenBy` names their role.
    - Humans write through `memoryWrite` and `memoryCurate`.
    - Triggers write through `record`.

### Restart and crash

17. **After a crash.** On start, the engine replays the ledger. Completed steps return their recorded outputs. The step that was open at the crash is handled according to its `afterCrash` setting:

    | Value | Behaviour | Default for |
    |---|---|---|
    | `'rerun'` | Run the step again | |
    | `'park'` | Block the attempt with `crash` for the supervisor | commands |
    | `{ parkUnless: check }` | Run `check`; continue if it returns `true`, park otherwise | |
    | `'ask'` | Ask the driver for the status of the recorded session | agents |

    - A batch invocation with a recorded `batchId` is always collected, never resubmitted.
    - The resumed attempt keeps its id.

18. **Work that moved while the harness was down.** Halts, signals and operator updates arrive through `Ledger.deliver`, an inbox that a client may append to without holding the claim.

19. **Definition change.** Each attempt records `flowHash` and its cursor. If the recorded step path no longer matches the flow, the attempt is blocked with `definitionChanged`. The supervisor resolves it with `restartFromTop` or `abandon`.

20. **Single writer.** The ledger claim is fenced: an append from a holder that no longer has the claim is rejected.

### Control API and startup

21. **Control API.** Clients are granted operations.

22. **Startup validation.** `start()` fails on any of the following:
    - duplicate names;
    - an unregistered lane referenced by a trigger, spawn or scheduler;
    - a band whose `above` is lower than its `below`;
    - a flow that can fall off its end;
    - an `'ask'` without driver support;
    - a batch step on a driver without `submitBatch`;
    - an `H.cancel` with no reaction.

    No kind needs a store.

## What changed and why

### Skeleton repaired (principle 12, amended)

- The six-outcome `ended` drawer is gone.
- Positions and mandatory verdicts are in.
- Attempt outcomes are exactly three.
- Waiting is a real position.
- The state map is checked by position.

### Inference

- `byState`, `models`, `attempt.step` and `unit.state` are mapped types.
- Entities carry branded discriminants.
- Callbacks use `NoInfer`.

### Relationships moved off instances

- Models carry no pool, and accounts carry no ledger.
- The pool is a per-harness pivot.

### New for scenarios 9 and 10

- Bands, crossings, invocation sources, and pause/resume consequences.
- Timer supersession.
- Dedup by key.
- `afterCrash`, invocation handles, the inbox, `flowHash`, and the fenced claim.

### Scenario pass 1–5

**`StepEvent.steps`.**
- *Gap:* Scenario 2's approval-by-category metric observes the `approval` step, but the category is the `classify` step's output. Scenario 3's findings record observes `check` but needs the `synthesize` report. Without a typed view of earlier outputs, the author would have to echo data into decisions or invent attributes.
- *Change:* step events now carry `steps`, an optional mapped type over the lane's step names holding the outputs recorded so far in the same attempt.

**`Retry.maxAttempts` renamed to `retries`.**
- *Gap:* "attempt" already means one continuation of a unit's flow (principle 22). A step retry is a new invocation.
- *Change:* `retries` counts extra invocations, so "retry up to 3 times" is `retries: 3`.

**Signal reactions that end an attempt.**
- *Gap:* Rule 4 now states what scenario 2's external cancellation relies on: a `restart` or an `enter` reaction cancels the open attempt.
- *Change:* Rule 7 now states that signals reach terminal units, so a weekly clock can reopen recurring topics without a supplier needing to read the ledger.

**Helpdesk adapter.**
- *Gap:* Scenario 2's "closed by customer" outcome needs a closed event from the helpdesk.
- *Change:* the adapter's event union gains `closed`. The change is adapter-only.

## Principles broken

None.
