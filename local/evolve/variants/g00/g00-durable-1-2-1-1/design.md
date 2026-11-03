# harness-dsl: demand-driven lanes (child of g02-durable-le-1-2-1)

Lens: GenStage / Broadway. Work flows from producers to consumers only as fast as consumers ask for it.

- Suppliers are **producers**.
- Lanes are **consumers** whose demand is their free capacity.
- The scheduler is the **dispatcher**.
- Unit events are **messages**. A message is acknowledged when something has used it, and is never dropped for want of a handler.
- The batch step is the **batcher**.

The owner's vocabulary stays. The lens contributes three rules and one word, *demand*. It adds no new entity except `Loopback`, which the adversary's counsel scenario forced.

| GenStage / Broadway | harness-dsl |
|---|---|
| producer | supplier |
| buffer of produced events | the ledger's pending queue (pending units hold nothing) |
| consumer `max_demand` | lane WIP, runner slots, account eligibility, unit budget, free locks |
| dispatcher | schedule policy, which orders candidates; the kernel grants demand |
| message ack | `SupplySink.emit` resolves with a `SupplyAck` only after the durable append |
| unhandled message stays in mailbox | `event.deferred`; routed later by `event.routed` |
| batcher | `batch` step (cloud batch API, priced `batch`) |
| `demand: :accumulate` (pause) | `lane.paused`: the lane's demand is zero, and running attempts finish |

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind in one lane.
  - Its key is unique in the lane forever, so a second create with the same key is recorded as `unit.deduplicated`.
  - A unit outlives its attempts.
  - It has one state of its kind, and that state's position is the unit's position.
- **Attempt**: one pass of the lane's flow over a unit.
  - Its outcome is succeeded, failed or cancelled.
  - While open, its status is `running` or `blocked`. Blocked means waiting on a human, and `BlockView.reason` says why.
- **Halt**: the flow step that blocks an attempt for a decision.
  - The decision entity (`H.decision`) is what grants, metrics, timers and policies reference.
  - The halt step key is its address in one flow.
- **Step**: one named node of a flow.
- **Invocation**: one execution of an executable inside a step. A retry is a new invocation.
- **Job**: an executable submitted now and collected later.
  - A cloud batch of model calls is a job whose driver is the model's.
  - An `H.job` is a job whose submit and collect are commands.
- **Demand**: the capacity a lane offers right now. It is the minimum of:
  - WIP minus active units;
  - free runner slots;
  - eligible accounts;
  - grantable locks;
  - zero if the lane is paused.

  Demand is folded from the ledger, never stored.

## The three rules of the lens

### Rule 1: capacity follows position, and nothing else

- Only units at an **active** state consume demand.
- A unit at a waiting state holds no WIP, no runner slot and no account, even if its attempt is still open.

**Halt and spawn steps.**
- Every halt key and every spawn key must map to a **waiting** state of the kind.
- When the attempt reaches that step, the unit moves to that state and releases its demand.
- When the decision arrives, or the last child ends, the attempt is queued `resume`.

**Batch and job steps.**
- A batch or job step may map to a waiting state, which releases the slot while the job runs.
- It may also map to an active state, which holds the slot.

**Kernel-caused blocks.**
- These are budget, an exhausted step, an agent question, a restart, or a definition change.
- They move the unit to the lane's optional `blocked:` waiting state.

**The board** reads only the state's position.

### Rule 2: messages are never dropped; unrouted messages are deferred

Every supplied or trigger-sent event is appended as `event.received`. Its routing works like this:

- **Reaction from the current state.** The reaction fires, recorded as `event.routed`.
- **No reaction from the current state, but one elsewhere.** The event is recorded as `event.deferred`. It is re-examined on each state entry, in arrival order, one per append.
- **No reaction anywhere in the lane.** The event is a data message.

Flows that declare `.events({...})` read the unit's whole inbox for those names, typed and in arrival order, frozen at attempt open.

Timers that find no reaction are recorded as `timer.lapsed`, not deferred.

### Rule 3: a producer is acknowledged only after the ledger has the item

`SupplySink.emit` resolves with a `SupplyAck` only after the append. Push adapters answer their sender only after the ack.

## Entities

### Kinds (no backend)

`H.state(name, position[, verdict])`. Terminal states must declare a verdict.

`H.work`: `.attributes`, `.fields`, `.states`, `.events`, `.timers`, `.key`, `.failsTo`.

`H.role`, `H.decision`, `H.memory.experience` and `H.memory.taste` (with `.curated()`), `H.command`, `H.job`.

`H.resource`: a named shared thing (a file pattern, a database, a host). Locks and leases reference it by identity.

`H.flow`: it is blind to kinds and states.

### Instances (adapter subpaths)

Account, model, runner, ledger and its quota partition, store, memory store, supplier, client, projection, external executable.

### Pivots

| Pivot | Composed of | Produces |
|---|---|---|
| lane | kind × suppliers × store × flow × runner × retry × WIP × locks × order | where a kind's units are produced, kept and handled, and the demand they offer |
| agent | role × model or model policy × pool × journals | an executable that thinks |
| pool | accounts × shares × preference × fallback | the accounts an agent may draw on |
| journal | memory kind × memory store × recall policy | where items are written and how they are recalled |
| reaction | target state × source states × cancellation | the routing of a message |
| loopback | return state × maximum × exhausted state | a bounded way back to an earlier state |
| trigger | source × consequences | a recorded firing |
| threshold | metric × group × trip/reset bounds | recorded crossings |
| access | operations × halts it resolves | what a client may do |
| report | metric reads | named readings on telemetry and the control API |
| harness | ledger × lanes × triggers × schedule × clients × projections × reports | a running node (`start`) or a console (`console`) |

## Rules

### Flows are decoupled from kind states

The lane's `states:` map is the only bridge between flow and kind.

| Flow key | Allowed targets | Required? |
|---|---|---|
| step, batch and job keys | any state | optional |
| halt and spawn keys | waiting states | required |
| end labels | non-active states, or a `Loopback` | required |
| `opens` | active states | required when the kind has active states |

### Loopback

`H.loopback(New, { max, then })` is an end-label target. It moves the unit back to `New` at most `max` times over the unit's life, and moves it to `then` on the next occurrence. The count is folded from `unit.transition` facts carrying the label.

### Failure and retry

- A failed attempt returns the unit to pending under the lane's `retry`.
- When the bound is reached, the unit moves to the kind's `failsTo` state.
- With no `.retry`:
  - a kind with `failsTo` gets 0 retries;
  - a kind without one gets unbounded exponential backoff.
- A bounded `.retry` on a kind without `failsTo` is a startup error.
- Two lanes of one kind may declare different retries.

### Outcome rate and track record

- The rate is success / (success + failure) over terminal units, with `n` beside it.
- Neutral endings are counted in `byVerdict`, `byState` and `share`.

### Reactions and cancellation

- A reaction from an active state must say `.cancels()`.
- A reaction from a waiting state with an open attempt may say `.cancels()`. The attempt is then cancelled and the unit re-enters the flow from the top.

### Spawn

- The spawn step maps to a waiting state.
- `child.ended` facts resume the parent when the last child ends.

### Halts: resolvers and clocks

A halt resolution is recorded as `halt.resolved` with `resolver: 'human' | 'policy' | 'timeout'` and `haltedAt`.

**Human.** A client whose access `resolves([decision])` names the halt's decision. Grants name decisions, never strings. The builtin `resolveBlocks` covers kernel blocks only: budget, question, step, restart and definition.

**Policy.** `H.policy.halt(name, kind, decision, decide)` is a registered deterministic function, set in the lane's `resolvers: { haltKey: policy }`.
- It runs when the halt is reached.
- A non-null result resolves the halt with that value. The resolution is recorded as `policy.decided`, with its metric reads and sample counts, and then `halt.resolved` with `resolver: 'policy'`.
- A null result leaves the halt to the other resolvers.

**Clock.** `halt(key, decision, { ask, timeout: { after, resolve } })` resolves the halt itself when no one has answered `after` the recorded `halt.opened`, with `resolver: 'timeout'`.
- The attempt continues; nothing is cancelled.
- The deadline is stored on `halt.opened`, so it survives restarts and never reads unit data.

**Paging before the clock.** `H.on.halted(decision, { after })` is a trigger source. It fires once per halt still unresolved `after` its recorded opening. Typical use: paging a deputy. Anyone the access names may resolve.

### Jobs

`H.job(name, { submit, collect, poll, status })` is an executable used with the ordinary `.step`.

**Submit.**
- The kernel runs `submit` once and parses `{ jobId }`.
- It appends `job.submitted`, then releases the slot if the step maps to a waiting state.

**Collect.**
- Every `poll`, the kernel runs `collect` on a briefly acquired slot of the lane's runner, with `HARNESS_JOB_ID` in its environment.
- `status(data)` returns `running`, `succeeded` or `failed`.
- `failed` is an invocation failure, so the attempt fails.

**Restart.**
- A recorded `job.submitted` means collect resumes; the job is never resubmitted.
- A crash between submit and its record follows the step's restart rule, `escalate` by default.

**Batches.** A cloud batch is the same fact with `sort: 'batch'`.

**Metrics.** `metrics.jobs` folds hours in flight from submission to collection, with `n`.

### Locks on resources

`lane.locks(unit => [{ resource, mode }])` declares locks.
- A unit is a candidate only if all its locks are grantable.
  - An exclusive lock excludes every other lock.
  - A shared lock excludes exclusive locks.
- Locks are acquired at attempt start as a lease on the ledger (`lock.acquired`, carrying `waitedMs` from readiness).
- They are released at attempt end.
- While the attempt is blocked or waiting the lock is kept, because it protects data, not capacity.

File-write leases are the same mechanism, in exclusive mode keyed by path.

`metrics.lockWait` reports wait time per resource with `n`.

### Ordering between units

`lane.after(unit => predecessorKey | null, parksIn)` makes a unit a candidate only once the predecessor unit in the same lane has reached a terminal success state.
- It applies whatever order the units were supplied in. A missing predecessor simply waits.
- A predecessor ending in a failure or neutral terminal state moves the unit to `parksIn`, a waiting state. The cause is `{ by: 'order', ref: '<key> ended in <state>' }`, shown on the board.

### Batch-shaped resumption

A `loop` body's steps are recorded per round. After a crash, recorded rounds replay at no cost, and the round that was running follows its restart rule. A backfill with `restart: 'rerun'` on its batch command therefore resumes at the interrupted batch, never at the first. The author writes no checkpoint.

### Metrics and reports

- Metrics are as before: `{ rate, hits, n, window }`.
- Windows are a `Duration`, `'all'` or `{ sinceMs }`.
- `MetricQuery.resolver` filters decision metrics.
- `metrics.decisions` gives median time to decision per halt, filtered by resolver, with `n`, counts per resolver, and `share(resolver)`.
- `metrics.attempts(...).retries` counts retry attempts.
- `H.report(name, read)` is a deterministic function from metrics to named readings. A reading is a number, a rate or a stat, each with `n`. Reports are published on telemetry projections and via `readTelemetry`.

### Restart after a crash

The author writes only restart rules and probes.

| Rule | Behaviour |
|---|---|
| `rerun` | runs the step again |
| `escalate` (default for commands, externals and an unrecorded job submit) | blocks the attempt with reason `restart` |
| `ask` (default for agents) | `Driver.settled` / `External.settled` reports whether the invocation finished |
| `{ probe }` | runs the probe command |

- Jobs resume collection from `job.submitted`.
- Halts resolved while the harness was down, and children that ended, are ledger facts.
- A resumed attempt keeps its id.
- A changed fingerprint prefix blocks the attempt with reason `definition`.
- A fenced writer lease ensures a single writer.

### Accounts and quota

- `Ledger.quota` is an append-only `QuotaPartition`.
- `sqlite.quota(shared)` places it in a file both harnesses name.

### Control API

- Operations and resolvable halts are granted through an access.
- Transport is the client adapter.

### Startup validation

`start()` fails on any of:
- duplicate names;
- a halt or spawn key mapped to a non-waiting state;
- an end label mapped to an active state;
- a kind with active states but no `opens`;
- a reaction from an active state without `.cancels()`;
- a reaction or loopback state outside the kind;
- a flow event the kind lacks;
- a bounded `.retry` on a kind without `failsTo`;
- an unregistered lane in `unit()` / `event()` / `pauses()`;
- a terminal state without a verdict;
- `restart: 'ask'` on an executable with no `settled`;
- a batch on a model that cannot batch;
- an agent without a model or pool;
- `.sets` keys that are fields;
- a halt resolver policy whose decision differs from the halt's;
- a halt no access resolves that has neither a timeout nor a resolver policy;
- an `after` parking state that is not waiting.

## What changed and why

**Lens generation (versus parent).**
- Capacity follows position.
- Deferred routing of messages.
- `SupplyAck`.
- Pause is zero demand.
- `.mark` is removed, and the lane maps step keys to states.
- `H.loopback` is added.
- `failsTo` replaces the `parked` flag.
- `event.deferred` / `event.routed` / `timer.lapsed` are added, and `child.ended` replaces `monitor.down`.
- `H.on.event` is removed.

**Scenarios 11 and 12 (run two).**
- **Halt clock.** The halt spec gains `timeout: { after, resolve }`. `halt.opened` carries the deadline. `halt.resolved` carries `resolver` and `haltedAt`, and `DecisionFact` gains `resolver` and `waitedMs`. Without these, a timeout could only cancel.
- **Paging before the clock.** `H.on.halted(decision, { after })` and `HaltEvent` are added, so the 20-minute deputy page is a recorded trigger measured from the halt.
- **Policy resolvers.**
  - `H.policy.halt` and the kernel's `HaltPolicy` replace the inline `Skip` object, and the lane config key `skips` becomes `resolvers`.
  - Reason: scenario 11 requires the skip to be a registered policy whose decision records its metric reads. The old skip was an anonymous predicate whose results were never decision samples.
  - Scenario 2 rewrites its one `skips:` line as `resolvers: { approval: H.policy.halt(...) }`.
- **Scoped resolvers.** `Access.resolves(decisions)` and `AccessSpec.resolves` are added. `resolveBlocks` now covers kernel blocks only.
- **Jobs.**
  - `H.job` and the kernel's `JobSpec` are added. `Executable` gains the `'job'` sort.
  - `batch.submitted` is generalized to `job.submitted { sort: 'batch' | 'job' }`, and `InvocationView.batchId` becomes `jobId`.
  - This partly answers known weakness 2: one fact and one restart rule for both batches and jobs, though the batch step keeps its own builder because it fans out items.
- **Locks.**
  - `lane.locks` and `LockRequest` are added, with `lock.acquired` / `lock.released` facts.
  - `Ledger.lease` takes `{ key, mode }` claims, so file leases and database locks are one mechanism.
  - Grantable locks join demand.
- **Ordering.** `lane.after(predecessor, parksIn)` is added, and `Cause.by` gains `'order'`.
- **Metrics.**
  - `Window` gains `{ sinceMs }`, for "this month".
  - `MetricQuery.resolver` is added.
  - `metrics.decisions`, `metrics.jobs`, `metrics.lockWait` and `AttemptCounts.retries` are added.
- **Reports.** `H.report` and `harness.reports` are added. Medians, hours in flight and lock waits are not rates, and nothing could publish them before.
- **Adapter.** `harness-dsl/ironclad` provides a document-system store.

## Principles broken

none.

`lane.after` and `lane.locks` put relationships on the lane, never on the kind (principle 10). Resources and decisions are referenced by identity (principle 8).
