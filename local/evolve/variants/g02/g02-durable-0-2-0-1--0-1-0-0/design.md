# harness-dsl, durable lens, generation 5 (split: exit → end / rest; lane → intake / handler)

A unit of work is a durable execution. Its identity outlives processes and attempts. The ledger is the event history the engine replays. Waiting is normal and holds nothing.

## The split

**What was doing two jobs.** The parent's `exits` map sent a flow exit to any state of the kind. Sometimes that meant "the unit is finished" (`clean → Done`). Sometimes it meant "this round is over and the unit sleeps until something happens" (`offered → AwaitingVendor`). One word covered two facts with different consequences. The first changes the kind's outcome rate; the second changes only where the unit waits.

**How it is split.** The handler has two destination maps:
- `ends: { exit → terminal state }`: the unit is finished, and the state's verdict counts in the kind's outcome rate.
- `rests: { exit → pending or waiting state }`: the round is over and the unit stays alive.

The two maps are disjoint. Their union must cover every exit of the flow; the compiler checks this (`Covers`) and so does `start()`. The types also check direction: a waiting state in `ends` or a terminal state in `rests` does not compile.

**The same split on the lane.** Principle 8 names lane = kind × suppliers × store × **handler**; the child makes that literal.
- **Lane methods (intake):** `supply`, `store`, `handler`, `on`.
- **Handler argument:** `{ ends, rests, params, retry, ceiling, lease, order }`, passed to `.handler(flow, …)`.
- Retry stays declared on the lane, inside the lane's handler (principle 12). Two lanes over one kind differ by handler (scenario 11).

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind. Stable id and a `key` (from `Kind.key`). At most one non-terminal unit per lane holds a given key.
- **Attempt**: one pass of the lane's flow over a unit. Ends with exactly one outcome: succeeded, failed or cancelled. While open it is *running* (holding a slot) or *blocked* (holding nothing), and records what it is blocked on: `decision`, `timer`, `children`, `job` or `recovery`.
- **Step**: a named node of a flow; the name is its address. `step` runs now and holds capacity; `halt`, `wait`, `spawn` and `job` block and hold nothing; `loop` and `exit` are structure.
- **Invocation**: one call of an executable within a step.
- **End / rest**: what an exit does to the unit.

"Run" is not used.

## Entities

**Kinds**: work kind, state, signal, role, memory kind, halt, resource, facet, command, job, flow, operation.

**Instances** (subpaths): account (naming its quota partition), model, embedder, runner, workspace, supplier, store, memory store, ledger, client, observer, quota partition, supervisor (one session yielding one client per harness).

**Pivots**:

| Pivot | Combines | Produces |
|---|---|---|
| Lane | kind × suppliers × store × handler × reactions | managed units |
| Handler | flow × ends × rests × params × retry × ceiling × lease × order | attempts and their destinations |
| Seat | role × (model, or candidates × choice policy) × pool × workspace × guards × halts | a model-call executable and a stable metric key |
| Pool | accounts × share caps × drain policy × fallback | quota-eligible access |
| Journal | memory kind × store × recall × reader/recorder roles | recalled memory |
| Trigger | source → consequences | recorded firings |
| Metric | source × facets | windowed figures with sample counts |
| Scheduler | priority, WIP, aging, rank, admission | start decisions |
| Harness | ledger and everything above | a running harness |

## Lifecycle (principle 12)

- `H.state(name, 'pending' | 'waiting')`, `H.terminal(name, verdict)` with no default verdict. A kind declares no states for active work.
- **Position is derived**: an open running attempt puts the unit at `active`; an open blocked attempt at `waiting`; otherwise the state's position.
- Stores that mirror active work map positions: `store(tracker, { states, running, blocked })`.
- **Failure belongs to the lane.** `handler.retry` is required: `{ maxAttempts, backoff, initialDelayMs, exhausted }`; `exhausted` is a terminal or waiting state (a pending one would loop and does not type). Exhaustion records `retryExhausted` and a `transition` with `cause: 'retryExhausted'`.
- **Attempt outcome**: failed (step fails after its retries, job polls failed, exit ends in a failure terminal); cancelled (`H.cancel`, a `restart`, an `enter` into a terminal while open); succeeded otherwise. A crash is never an outcome.
- **Success rate** of a kind is over terminal verdicts only; rests never count.

## Reactions (signals)

`Lane.on(signal, { update, restart, enter })`.
- **`update`** applies at once and re-arms timers.
- **`restart: { to, at }`**: if the open attempt is blocked at an `at` step, restart at `to` now; if the open attempt has not yet blocked there, restart when it does (`applies: 'atBlock'`). **With no open attempt, the restart is dropped and only `update` applies** (recorded `applies: 'now'`); the next attempt already starts from the top with the updated attributes.
- **`enter` into a terminal state** cancels any open attempt and ends the unit.
- **`enter` into a non-terminal state while an attempt is open is deferred** to attempt end; a terminal `end` wins, otherwise it replaces the `rests` destination.
- **Routing signals.** Routers signal by unit key, by state entity, or by key filtered by state: `to.signal(followUp, { key, in: Sent }, payload)`. No raw state string remains.
- **Unmatched signals** record `signalSkipped`; creation deduplicates by key and records `createSkipped`.

## Halts (principles 8, 17)

`flow.halt(address, haltEntity, { ask, policy?, timeout?, escalate? })`. The address is the step name; the entity is the question.
- `policy: { by: H.policy.halt(name, halt, inputSchema, decide), input }`: recorded with input, figures read and sample counts. `resolvedBy: 'policy'`.
- `timeout: { afterMinutes, decide }`: the attempt continues. `resolvedBy: 'timeout'`.
- A human resolves only through a client holding `H.ops.resolve(halt)`; `H.ops.resolve(halt, { afterMinutes })` is a time-gated grant (the deputy). `escalate.run` pages.
- Every clock runs from the recorded `attemptBlocked`.
- `handler.ceiling.onExceed` is `'fail'` or a halt whose decision is a `CeilingDecision`. A return bound is `loop({ max })`.

## Jobs

`H.job(name, { submit, collect, pollEveryMinutes })`; `seat.batch()` also returns a `Job`. `flow.job(name, job, input)` is the only blocking external step. A job holds no slot, WIP or reservation in flight; `jobSubmitted` records the job id; on restart it is collected by id; `jobCollected.inFlightMs` feeds GPU-hour metrics; model jobs carry `batch: true`.

## Seats and model choice

`seat.model(m)` or `seat.model(policy, [incumbent, ...challengers])`. The policy sees `seat`, `kind`, `candidates`, `current`, `peers`, `metrics`. A returned model outside `candidates` is refused and falls back to `candidates[0]`. The seat is the metric key.

## Ordering between units

`handler.order: { after: attrs => predecessorKey | undefined, held }`. A unit whose predecessor has not reached a success terminal is unschedulable; a failed predecessor moves it to `held` with `orderHeld { reason: 'predecessorFailed' }`; a later success of a unit with that key records `orderReleased`.

## Memory

Authored scope uses entities. Stored `MemoryItem.when` uses branded idents. Recall matches scope, ranks by specificity or similarity, ties by track record.

## Accounts and shared quota (principle 15)

The account names its `QuotaPartition`; the ledger carries no quota. Each harness appends its own consumption and folds the window at read time. Share caps are per harness, registered with `register(harness, ledgerId)`. One supervisor session yields one client per harness.

## Restart

One writer claim with a TTL. Completed steps replay at zero cost. The running step follows its `afterCrash`: `rerun`, `park` (with `alreadyDone`), or `askDriver`. Jobs are collected by id. Children are read from the ledger. A `flowVersion` mismatch parks as `definitionChanged`. Interrupted attempts are excluded from every rate. Loops resume at the first unrecorded iteration.

## Startup validation

`start()` fails, naming the descriptor, on: duplicate names; a facet named after a column; a handler without `retry`; `ends`/`rests` overlap or gaps; a flow path without exit; `order` on a keyless kind; a reachable waiting state with no way out (reaction, order release, timer trigger, or granted `workSignal` with a reaction); `spawn` to an unregistered lane; a signal routed or triggered toward a lane without a reaction; `workCancel`/`H.cancel` toward a lane without `on(H.cancel)`; a seat without role, model or pool; a pool no account of which the driver serves; an unenforceable guard; `batch()` or `askDriver` on a driver without support; a used halt without resolver; `resolve` for an unused halt; a halt policy on the wrong halt; timeout not greater than escalation; a gated grant not less than the timeout; a crossing over a total metric; unregistered references; a quota partition refusing `register`.

## What changed and why

### Operator: split
The exit map is split into `ends` and `rests`; the lane is split into intake methods and one handler argument.

### Principle 12 repair
The parent's `during` map made kinds declare states for active steps. Removed; position derives from the open attempt; stores map `running` and `blocked`.

### Critiques 1–3, scenario 8
Lane reduced to intake; `order` with `held` and `orderReleased`; generic model policies over `peers`; one `job` step; `askIf` removed; time-gated grants; entity-typed views.

### Scenarios 7–12 pass (this revision)
- **Signal by key filtered by state.** Scenario 9 (the support harness of scenario 2) must send a customer reply to one conversation two different ways: restart the open attempt if the unit is still in `New`, or move it back to `New` if it rests in `Sent`. Targeting by key alone delivered both signals; targeting by state alone hit every sent conversation. `Router.signal`'s target is now `string | { key?, in }`. One property added, nothing removed.
- **Restart with no open attempt is dropped.** The parent left this undefined; in scenarios 9 and 11 a reply or redline can arrive while the unit is pending. The deferred-restart reading would restart the *next* attempt at its first block for a stale reason. Now only `update` applies, recorded `applies: 'now'`.
- **Metric/policy cycles.** A halt policy that reads a metric whose source is the lane that uses the policy is a definition cycle (scenarios 9, 11). The author breaks it with one type annotation, `const approvalRate: MetricRef<'rate'> = …`, and reads the metric inside the policy body. That is a declaration, not an escape hatch. It is recorded here so that the next generation can decide whether a metric should be declarable before its source.

### Open
Reopened work is not expressible (deferred). Skills remain strings in memory scope.

## Principles broken

None.
