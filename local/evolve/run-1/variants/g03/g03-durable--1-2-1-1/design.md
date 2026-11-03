# harness-dsl: demand-driven lanes (child of g02-durable-le-1-2-1)

Lens: GenStage / Broadway. Work flows from producers to consumers only as fast as consumers ask for it.

- Suppliers are **producers**.
- Lanes are **consumers** whose demand is their free capacity.
- The scheduler is the **dispatcher**.
- Unit events are **messages**. A message is acknowledged when something has used it, and is never dropped for want of a handler.
- The batch step is the **batcher**.

The owner's vocabulary stays. The lens contributes three rules and one word, *demand*. It adds no new entity except `Loopback`, which the adversary's counsel scenario forced; see below.

| GenStage / Broadway | harness-dsl |
|---|---|
| producer | supplier |
| buffer of produced events | the ledger's pending queue (pending units hold nothing) |
| consumer `max_demand` | lane WIP, runner slots, account eligibility, unit budget |
| dispatcher | schedule policy, which orders candidates; the kernel grants demand |
| message ack | `SupplySink.emit` resolves with a `SupplyAck` only after the durable append |
| unhandled message stays in mailbox | `event.deferred`; routed later by `event.routed` |
| batcher | `batch` step (cloud batch API, priced `batch`) |
| `demand: :accumulate` (pause) | `lane.paused`: the lane's demand is zero, and running attempts finish |

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind in one lane.
  - Its key is unique in the lane forever, so a second create with the same key is recorded as `unit.deduplicated`.
  - A unit outlives its attempts.
  - It has one state of its kind, and that state's position is the unit's position. There is no flag beside it.
- **Attempt**: one pass of the lane's flow over a unit.
  - Its outcome is succeeded, failed or cancelled.
  - While open, its status is `running` or `blocked`. Blocked means waiting on a human, and `BlockView.reason` says why.
  - There is no third status.
- **Halt**: the flow step that blocks an attempt for a decision.
- **Step**: one named node of a flow.
- **Invocation**: one execution of an executable inside a step. A retry is a new invocation.
- **Demand**: the capacity a lane offers right now. It is the minimum of:
  - WIP minus active units;
  - free runner slots;
  - eligible accounts;
  - zero if the lane is paused.

  Demand is not stored. The kernel folds it from the ledger.
- Removed words: parked, receiving, mark.

## The three rules of the lens

### Rule 1: capacity follows position, and nothing else

- Only units at an **active** state consume demand.
- A unit at a waiting state holds no WIP, no runner slot and no account, even if its attempt is still open.

Consequences:

**Halt and spawn steps.**
- In the lane's handler config, every halt key and every spawn key must map to a **waiting** state of the kind. The types enforce this: the `Wt` keys map to `Waiting<St>`.
- When the attempt reaches that step, the unit moves to that waiting state and releases its demand.
- When the decision arrives, or the last child ends, the attempt is queued as `resume` and needs demand again.
- So forty contracts awaiting counsel consume none of a drafting WIP of 3, and the counsel's answer stays a `Decision`, measurable with `H.metric().of(decision)`.

**Batch steps.**
- A batch step may map to a waiting state, which releases its slot while the cloud batch runs.
- It may also map to an active state, which holds the slot.

**Kernel-caused blocks.**
- These are budget, an exhausted step, an agent question, a restart, or a definition change.
- They move the unit to the lane's optional `blocked:` waiting state.
- If a lane declares none, the unit keeps its state and the board shows it holding capacity while blocked.
- This is written, never implied.

**The board** reads one thing: the state's position. Attempt status explains *why* an open attempt is not moving. It never contradicts the position.

This repairs the adversary's sharpest critique. `UnitView.parked`, `AttemptView.receiving` and `ReceiveView` are deleted. "Not progressing" now has exactly two words:
- the unit's position `waiting`, which concerns capacity;
- the attempt's status `blocked`, which concerns the reason.

### Rule 2: messages are never dropped; unrouted messages are deferred

Every supplied or trigger-sent event is appended as `event.received`. Its routing works like this:

- **Reaction from the current state.** The reaction fires, recorded as `event.routed`.
- **No reaction from the current state, but one elsewhere.** The event is recorded as `event.deferred`. Each time the unit enters a new state, the kernel re-examines deferred events in arrival order, one per append. The first one with a reaction from the new state is routed.
- **No reaction anywhere in the lane.** The event is a *data message*. It needs no routing and is never deferred.

Flows that declare `.events({...})` read the unit's whole inbox for those names, typed and in arrival order, frozen at attempt open. This is how a counterparty redline that arrives mid-draft reaches the next round, with no cancellation and no loss.

Timers are the one exception. A timer firing with no reaction from the current state is recorded as `timer.lapsed`, not deferred. A timer is a state timeout, not a message from outside, and a daily 09:00 cutoff must not pile up on units that have moved on.

`UnitView.deferredEvents` is shown on the board. A unit sitting on deferred messages is visible, not silent.

Effects on the scenarios:
- Scenario 8's `vendorReplied` arriving during `Drafting` is deferred. When the round ends at `AwaitingVendor`, it routes to `RoundDue`. The parent's stall is gone.
- Scenario 2's `customerReplied` and `ticket.solved` are routed strictly in arrival order, each in its own append, so the race the adversary named cannot interleave.

### Rule 3: a producer is acknowledged only after the ledger has the item

`SupplySink.emit` resolves with a `SupplyAck` (seq, outcome) only after the append. Each outcome is a fact:
- `created`;
- `deduplicated`;
- `received` (an event on an existing unit).

Push adapters (webhooks) answer their sender only after the ack, so a crash between receipt and record makes the sender retry. Pull adapters (poll, folder, schedule) may be called again freely, because keys deduplicate. This is GenStage's at-least-once delivery, made exactly-once by forever-unique keys.

## Entities

### Kinds (no backend)

`H.state(name, position[, verdict])`. Terminal states must declare a verdict.

`H.work`: `.attributes`, `.fields`, `.states`, `.events`, `.timers`, `.key`, `.failsTo`.

`H.role`: its `.intents` are mapped to tools by the driver.

`H.decision`, `H.memory.experience` and `H.memory.taste` (with `.curated()`), `H.resource`, `H.command`.

`H.flow`:
- It is blind to kinds and states.
- Its vocabulary is step keys, end labels (`.exit`, `.ends`), halts, spawn outlets and declared events.
- `.mark` is removed: the lane maps step keys to states directly (see "Flows are decoupled" below).

### Instances (adapter subpaths)

Account, model, runner, ledger and its quota partition, store, memory store, supplier, client, projection, external executable.

### Pivots

| Pivot | Composed of | Produces |
|---|---|---|
| lane | kind × suppliers × store × flow × runner × retry × WIP | where a kind's units are produced, kept and handled, and the demand they offer |
| agent | role × model or model policy × pool × journals | an executable that thinks |
| pool | accounts × shares × preference × fallback | the accounts an agent may draw on |
| journal | memory kind × memory store × recall policy | where items are written and how they are recalled |
| reaction | target state × source states × cancellation | the routing of a message |
| loopback | return state × maximum × exhausted state | a bounded way back to an earlier state |
| trigger | source × consequences | a recorded firing |
| threshold | metric × group × trip/reset bounds | recorded crossings |
| access | operations | what a client may do |
| harness | ledger × lanes × triggers × schedule × clients × projections | a running node (`start`) or a console (`console`) |

## Rules

### Flows are decoupled from kind states (known weakness 1, adversary critique 2)

Flows contain no state names and no marks. The lane's `states:` map is the only bridge between flow and kind:

| Flow key | Allowed targets | Required? |
|---|---|---|
| step and batch keys (`Sk`) | any state | optional; the state the unit takes while that step runs, and an unmapped step keeps the previous state |
| halt and spawn keys (`Wt`) | waiting states | required |
| end labels (`L`) | non-active states, or a `Loopback` | required |
| `opens` | active states | required when the kind has active states |

So scenario 2 maps `classify → Classifying`, `draft → Drafting`, `approval → AwaitingApproval`, with no `.mark` lines. The same flow serves Bug and Feature unchanged.

### Loopback (adversary scenario 2, counsel)

`H.loopback(New, { max: 2, then: Declined })` is an end-label target. It means:
- move the unit back to `New`, at most `max` times over the unit's life;
- on the next occurrence, move it to `Declined` instead.

The count is folded from `unit.transition` facts carrying the end `label`, so a flow never counts its own rounds. This repairs the unbounded rejection loop in scenario 2: `rejected: H.loopback(New, { max: 3, then: Escalated })`.

A loopback is not a retry:
- **Retry** is about failed attempts.
- **Loopback** is about succeeded attempts that decided to go round again.

### Failure and retry (principle 12 as amended)

**A failed attempt.** The unit returns to its pending state, and the lane's `retry` sets the delay before the next attempt.

**When the bound is reached.** The unit moves to the kind's `failsTo` state. This is the kind's declared failure move. Only then does an attempt's failure move the unit.

**Defaults when a lane declares no `.retry`.**

| Kind | Default |
|---|---|
| declares `failsTo` | 0 retries (the first failure moves the unit) |
| no `failsTo` | exponential backoff, 1 minute to 1 hour, unbounded |

A bounded `.retry` on a kind without `failsTo` is refused at `start()`, because the unit would have nowhere honest to go.

This replaces the parent's `parked` flag, which contradicted the state's position.

### Outcome rate and track record

- The rate is success / (success + failure) over units reaching terminal states, with `n` beside it.
- Neutral endings appear only in `outcomes().byVerdict`, `byState` and `share(State)`.
- Model and agent track record uses the terminal verdict, attributed to the attempt that moved the unit to terminal.
- Attempt outcomes are reported separately, by `attempts()`.

### Reactions and cancellation

- `H.reaction(To).from([...])` routes a message.
- A reaction from an active state must say `.cancels()`, otherwise `start()` fails. Cancelling an open attempt is always written.
- Reactions may leave terminal states (a reopened bug keeps its key).
- Store fields are loaded once at attempt open and frozen for that attempt.

### Spawn (known weakness 2)

The spawn step maps to a waiting state, so an Epic waiting on Features holds no WIP. `.wip(1)` on epics limits decomposition, not the weeks of waiting.

Each child's terminal transition appends `child.ended` for the parent attempt. When the last child ends, the attempt is queued `resume`, and the step's output is the `ChildView[]`.

Restart reads `child.ended` facts. Running children are separate units and are never restarted.

### Halts, skips, budget

- `halt(key, decision, { ask })` blocks the attempt.
- Lane `skips` may resolve a halt through a deterministic gate. A skip records `skipped` and is never a decision sample.
- `budget.maxUsdPerUnit` is checked before every invocation against the unit's cost. `onExceed: 'halt'` blocks the attempt with reason `budget`, and the unit moves to `blocked:` if declared.

### Metrics

- `H.metric(name).of(lane | decision | executable).hit(test)` defines a metric over transitions, decisions or executables.
- `.invocations(sorts?)` defines a metric over invocations.
- Windows are a `Duration` or `'all'`.
- Every rate is returned as `{ rate, hits, n, window }`.
- Queries address entities only.
- Every read inside a policy is recorded in `policy.decided`.
- `TransitionEvent.from` and `.to` are `StateSpec` entities, and `on.transition` filters by `from` and `to` states. No policy or trigger compares state names as strings; this repairs the scenario 2 SLA trigger.

### Policies

- `PolicyContext.unitOf(kind)`, `ScheduleContext.order`, `Candidate.is(lane)` and `OpenAttempt.is(lane)` are kept.
- `OpenAttempt.holdsCapacity` tells a preemption policy whether stopping the attempt would free any demand.
- The kernel grants only what demand allows. The policy orders candidates and names attempts to preempt. Starting in a paused lane is impossible, because its demand is zero.

### Triggers and thresholds

**Sources:**
- `transition`, with typed `from`, `to`, verdict and position filters;
- `streak`;
- `step`;
- `crossed` / `recovered`.

`H.on.event` is removed. Scenario 2's SLA trigger now reads `on.transition(conversations, { to: [Escalated] })`, which states the fact it actually cares about.

**Consequences:** `creates`, `sends`, `records`, `invokes`, `pauses` / `resumes`.

**Recording.** Each firing is recorded with its source sequence number. A pause and a resume are recorded as `lane.paused` / `lane.resumed` with the metric reads that caused them.

**Thresholds.**
- They hold hysteresis per group in the ledger. One `threshold.crossed` is appended per crossing.
- `trippedAt` names the episode, so `category@trippedAt` keys an Audit, and the recovery trigger addresses exactly that Audit.
- `per` is `keyof A`, so it is type-checked against the kind's attributes.

### Restart after a crash (scenario 10)

Unchanged from the parent; the author writes only restart rules and probes.

**Replay.** Recorded `step.recorded` outputs are replayed and cost nothing. The step that was running at the crash follows its rule:

| Rule | Behaviour |
|---|---|
| `rerun` | runs the step again |
| `escalate` (default for commands and externals) | blocks the attempt with reason `restart` |
| `ask` (default for agents) | `Driver.settled` / `External.settled` reports whether the invocation finished |
| `{ probe }` | runs the probe command; a positive answer continues, otherwise the attempt escalates |

**State that moved while the harness was down.**
- Batches are collected through `batch.submitted`, never resubmitted.
- Halts resolved meanwhile (through `Ledger.submit` from a `console()`) and children that ended are ledger facts, found on restart.

**Identity and metrics.** A resumed attempt keeps its id. Interrupted invocations are excluded from every rate.

**Changed definitions.** A changed fingerprint prefix up to the running step blocks the attempt with reason `definition`. `manageAttempts` lets the supervisor restart it from the top or abandon it.

**Single writer.** A fenced writer lease (`claim`, `renew`, a token on every append) means a second process is refused, or takes over a dead holder.

**Demand after restart.** Demand is re-folded from positions, so a unit that was waiting at the crash still holds nothing.

### Accounts and quota (principle 15 as ruled)

- `Ledger.quota` is an append-only `QuotaPartition` of quota events.
- Each harness appends its own events and folds the window at read time. There is no lock and no second store.
- `sqlite.quota(shared)` places the partition in a file both harnesses name.
- Shares are folded from `share.set` events.

### Control API

- Operations are granted through an access.
- Transport is the client adapter (MCP session, plain HTTP).
- `start()` returns `Running`. `console()` returns `Console`, which has control only and no scheduling.

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
- `.sets` keys that are fields.

## Answers to the adversary

**Halts held capacity (scenarios 2, 5, 10).**
- Rule 1: halts map to waiting states, and capacity follows position.
- `AwaitingApproval` is now a waiting state in every scenario.
- `WIP 10` counts only classifying and drafting.

**Unbounded rejection loop.** Replaced by `Loopback`, with `max` and `then`.

**String state comparison.** `TransitionEvent.from` / `.to` are entities, `on.transition` takes a `from` filter, and `on.event` is gone.

**Overlapping customer events.** Arrival-order routing, one event per append.

**Contract counsel.**

| Requirement | How |
|---|---|
| Counsel's wait holds no WIP | the `counsel` halt maps to a waiting `AwaitingCounsel` |
| Counsel stays a `Decision` | it is a halt, so its approval rate is a decision metric |
| The second return ends in `Declined` | `returned: H.loopback(Drafting… pending state, { max: 1, then: Declined })` |
| A redline mid-draft is neither cancelled nor dropped | it is a data message read by the next round's `c.events` |

**Shadow statuses.** `parked`, `receiving` and `ReceiveView` are deleted. Position is the only capacity truth; `blocked` is the only reason flag.

**Marks mirroring kind states.** `.mark` is deleted. Step keys map to states in the lane, and the flow has no lifecycle of its own. `unitDoesNotSatisfyFlowInput` remains: it is a compile-time message for a genuine mismatch between the kind's data and the flow's input, not a lifecycle patch.

**Silent drops.** `event.ignored` is deleted. Events are routed, deferred, or kept as data, and timers that miss are recorded as lapsed.

**`outlet: 'feature'` as a string.**
- It stays a string, by argument. It is a typed port label, exactly like step keys. The lane's `spawns` config is checked against it, so a typo fails compilation.
- Naming the child lane inside the flow would make the flow know other kinds, which principle 13 forbids.
- `per` is already `keyof A`.

## What changed and why

**Lens rules.**
- Capacity follows position (demand).
- Deferred routing of messages.
- Producer ack after durable append: `SupplyAck`, and `emit` now returns it.
- Pause is zero demand.

**Flows.**
- `.mark` is removed.
- The flow tracks step keys (`Sk`) and wait keys (`Wt`) as type parameters.
- The handler config maps step keys to any state and halt/spawn keys to waiting states.
- The lane gains an optional `blocked:` waiting state.

**New pivot.** `H.loopback`, as a `Loopback` entity and `LoopbackSpec` in the kernel. `unit.transition` gains `label` so loopbacks fold.

**Failure.**
- The `parked` flag is replaced by `failsTo` as the bound-reached destination, with documented retry defaults.
- `unit.parked` and `unit.requeued` are removed.

**Ledger facts.**
- `event.ignored` is replaced by `event.deferred` / `event.routed`, and `timer.lapsed` is added.
- `monitor.down` is renamed `child.ended`, the lens-neutral noun.

**Views.**
- `UnitView.state` and `ChildView.state` are `StateSpec`. `UnitView.parked` is replaced by `deferredEvents`.
- `AttemptView.receiving` and `ReceiveView` are removed. `OpenAttempt.holdsCapacity` is added.
- `BlockView` reason `failure` is renamed `step`.

**Triggers.**
- `H.on.event` and `UnitEventFired` are removed.
- `on.transition` gains `from`, and `TransitionEvent` carries `StateSpec`s and `label`.

**Causes.** `Cause.by` gains `timer` and `retry`, and loses `supervision`.

## Principles broken

none.

`failsTo` as "where the unit goes when the lane's retry gives up" reads principle 12's "a kind may declare a move for a failure, and only then does an attempt's failure move the unit" literally:
- by default, a failure leaves the unit at pending under the retry policy;
- the declared move applies when that policy stops retrying.
