# harness-dsl: units as processes, memory as playbooks (child of g02-durable-le-1-2-1)

The lens is still Erlang/OTP. A unit is a `gen_statem`, its received events are its mailbox, timers are statem timeouts, and `spawn` monitors children. This generation does three things:

- It renames the weakest noun: **journal → playbook**.
- It repairs the parent's three named defects: shadow statuses, flows coupled to state names, and silently dropped events.
- It fixes the worst-scenario defects: halts holding lane capacity, and unbounded rejection loops.

## The rename: journal → playbook

The pivot is memory kind × memory store × recall policy. A *journal* is a diary of what happened, and principle 14 forbids exactly that: memory is forward-phrased ("do X when Y because Z"), never history. Known weakness 17 already said so ("curated items are not a journal").

What the pivot produces is a body of forward rules that an agent consults before acting and that grows from outcomes. That is a **playbook**: a set of plays, each with a situation it applies to (`when`) and a reason (`because`). The noun also fits both memory sorts:

- An experience playbook can hold a stale play.
- A taste playbook is the owner's house style.
- Curation (accept, merge, drop) is how anyone maintains a playbook.

What changes with the rename:

| Before | After |
|---|---|
| `H.journal(name, kind)` | `H.playbook(name, kind)` |
| `Journal` | `Playbook` (`.store`, `.recall`) |
| `JournalSpec` | `PlaybookSpec` |
| — | `MemoryItem.playbook` (new) |

Agents call `.recalls(playbooks)` and `.records(playbook)`. Triggers call `.records(playbook, make)`. The verb "records" stays: recording a play into a playbook reads correctly.

The read/write asymmetry (known weakness 12) is stated as follows:
- An agent recalls from several playbooks.
- An agent records into exactly one.
- A playbook is one store, so a write has one destination.

## Execution vocabulary (one definition each)

**Unit.** One piece of work of one kind in one lane, identified by `(lane, key)`.
- Keys are unique forever. A create with an existing key records `unit.deduplicated`.
- A unit outlives its attempts.
- Its **position is always its state's declared position.** There is no flag beside it.

**Attempt.** One pass of the lane's flow over a unit.
- Its status while open is `running` or `blocked`.
- Its outcome is `succeeded`, `failed` or `cancelled`.
- **Blocked** means waiting on a human. The reasons are `decision`, `question`, `budget`, `failure`, `restart` and `definition`.

**Halt.** The flow step that blocks an attempt. Halt is the verb; blocked is the status.

**Step.** One named node of a flow.

**Invocation.** One execution of an executable in a step. A retry is a new invocation.

**Removed words:**
- *parked* (the `UnitView.parked` flag);
- *receiving* (`AttemptView.receiving`, `ReceiveView`);
- *mark*;
- `event.ignored`;
- `unit.parked`;
- `unit.requeued`.

"Not progressing" is now said in exactly two places:
- a unit's position (`waiting`);
- an attempt's status (`blocked`).

## Capacity: who holds what

This rule repairs the worst scenario (2) and the adversary's contract-counsel scenario.

| Resource | Held by | Released when |
|---|---|---|
| Lane WIP | a **running** attempt | the attempt blocks or ends |
| Runner slot | an attempt **during an invocation** | the invocation ends; `Runner.reacquire(attemptId)` restores the same workdir (worktree) |
| Account quota | an invocation | the invocation ends |

Consequences:
- A blocked attempt holds no WIP, no slot and no account. Ten conversations awaiting approval, or forty contracts awaiting counsel, consume none of the lane's WIP. The unit is still at an active state, since it has an open attempt. This is principle 12's split: blocked is an attempt state and does not occupy the scheduler.
- When a halt is resolved, the attempt re-enters the scheduler as a `resume` candidate under the same WIP limit.
- A `spawn` or `batch` step keeps its attempt running, so it holds lane WIP while children or the batch are outstanding, but not a slot. An Epic in progress counts against the epic WIP limit.

## Entities

### Kinds (no backend)

**`H.state(name, position[, verdict])`**. Terminal states must declare a verdict.

**`H.work`**: `.attributes`, `.fields`, `.states`, `.events`, `.timers`, `.key`.
- `.failsTo(S)` is the kind's optional failure move (principle 12). It is typed to non-active states and carried in the kind's type.

**`H.role`**: `.intents` are mapped to tools by the driver.

**`H.decision`**, **`H.memory.experience` / `.taste`** (with `.curated()`), **`H.resource`**, **`H.command`**.

**`H.flow`**: blind to kinds and states.
- Its only labels are **ends** (`.exit`, `.ends`): how the attempt finishes, in the flow's own words.
- Steps are named by key.

### Instances (adapter subpaths)

Account, model, runner, ledger and its quota partition, store, memory store, supplier, client, projection, external executable.

### Pivots

| Pivot | Composed of | Produces |
|---|---|---|
| lane | kind × suppliers × store × flow × runner × retry | where a kind's units are produced, kept and handled |
| agent | role × model or model policy × pool × playbooks | an executable that thinks |
| pool | accounts × default shares × preference × fallback | the accounts an agent may draw on |
| **playbook** | memory kind × memory store × recall policy | the plays an agent consults and that outcomes add to |
| reaction | target state × source states × attempt cancellation | a unit's answer to a received event |
| trigger | source × consequences | a recorded firing |
| threshold | metric × group × trip/reset bounds | recorded crossings |
| access | operations | what a client may do |
| harness | ledger × lanes × triggers × schedule × clients × projections | a running node (`start`) or a console (`console`) |

## Rules

### The lane maps the flow onto the kind (critique 2)

The flow never names a state. The lane's handler config is the only place where flow vocabulary meets kind vocabulary:

```
.handler(flow, {
  opens: Working,                        // active state entered when an attempt opens
  during: { draft: Drafting, approval: AwaitingApproval },  // optional: active state shown while a step runs
  ends: { sent: Sent, rejected: { to: New, upTo: 2, then: Escalated } },
  exhausted: Stalled,                    // required iff the kind has no failsTo
  params, spawns, skips,
})
```

**`during`** is keyed by the flow's own step keys (`keyof Out`, typed). It replaces the parent's `.mark`:
- the same flow can serve a kind with one active state (no `during`) and a kind with five;
- nothing is duplicated, because the flow declares no lifecycle;
- `unit.transition` records `cause: { by: 'flow', ref: step }`.

**`ends`** maps every end label to a non-active state. This is known weakness 1's "flows end at labels, the lane maps them to the kind's states". It is not a rename table: one flow serves Bug (`unfinished → Stalled`) and Feature identically, and scenario 8's experiment flow ends in `aWins` / `bWins` / `inconclusive`, which only the kind can call success or neutral.

**`Route`: `{ to, upTo, then }`** bounds a repeating end without flow arithmetic.
- The first `upTo` times this end lands for a unit, the unit goes to `to`; after that it goes to `then`.
- The count is folded from `unit.transition.end` facts on the ledger.
- This repairs scenario 2's unbounded rejection loop (`rejected: { to: New, upTo: 2, then: Escalated }`) and the contract scenario ("after the second return, Declined") with no `c.attempt.number` in the flow.

**Spawn.** A spawn step's children are made by `spawns[stepKey]`. The parent's free-string `outlet` is gone, and the key is the typed step key.

### Failure and retry (principle 12 as amended)

A failed attempt leaves the unit at its pending state, and the lane's `retry` queues the next attempt with backoff. The default is no retries.

On exhaustion the unit moves to the handler's **`exhausted`** state, which is any non-active state of the kind, typically waiting (`Stalled`). The move is recorded as `unit.transition` with `cause.by = 'retry'`.

A kind with `.failsTo(S)` moves to `S` on every failed attempt, and then `exhausted` is not accepted. This is enforced by the types: `exhausted` is required exactly when the kind's failure type is `never`.

This replaces the parked flag. Its effect is real and honest:
- a unit that is "stuck after retries" is in a state whose position is `waiting`;
- the board needs no reconciliation;
- the supervisor moves it on with `updateWork` or `sendEvents`.

### Positions

| Position | Meaning |
|---|---|
| pending | schedulable |
| active | has an open attempt (running or blocked) |
| waiting | no open attempt, not schedulable, holds nothing |
| terminal | terminal |

A Tenancy between reviews sits at `Customer` (waiting) and holds nothing.

### Outcome rate

- Rate = success / (success + failure) over units reaching terminal states, with `n` beside it.
- Neutral endings appear in `outcomes().byVerdict` and `byState`.
- `share(State)` answers "how often inconclusive".
- Success-with-warnings is a separate success state: one verdict, distinct `byState`.
- Attempt outcomes are reported separately, by `attempts()`.

### Mailbox: deferral, never silent loss (critique 3)

Every received event is recorded as `event.received`. Then, in per-unit ledger sequence order:

1. If a reaction matches the unit's current state, it applies (`event.applied`).
2. If none matches, the event is **deferred** (`event.deferred`). This is OTP `postpone`.
3. On every state change, deferred events are re-evaluated in arrival order against the new state. The first match applies.
4. If the unit becomes terminal with events still deferred, each is recorded as `event.dropped` with the terminal state.

Nothing is ignored silently, and `UnitView.deferredEvents` shows the backlog on the board.

Consequences:
- A redline or vendor reply that lands while a draft is being written is neither cancelled nor lost. When the round ends at `AwaitingCounsel` / `AwaitingVendor`, the deferred reply moves the unit to `RoundDue`.
- The next attempt's flow reads the reply through `c.events`, which is selective receive over the whole mailbox.
- Authors no longer enumerate every source state to avoid loss. `.from` lists only the states where the event should *act now*.

**Ordering.** Two events for one unit are applied in ledger sequence order. Each reaction is evaluated against the state the previous one left. A `customerReplied` that reopens a Sent conversation, followed by `ticket.solved`, closes it. That is deterministic.

**Cancellation.** A reaction from an active state must say `.cancels()`, or `start()` fails. Cancellation is always written; deferral is the default for everything else.

**Triggers on events.** `H.on.event(lane, name, { in: [States] })` filters by state entity, never by name strings. An SLA breach that arrives after `Sent` is not routed. Alternatively, trigger on the transition the reaction causes (`H.on.transition(lane, { to: [Escalated] })`).

### Typed keys, not strings

These keys are typed:
- `per` in `H.on.streak` and `H.threshold`: `keyof A`, checked against the kind's attributes;
- `during` and `spawns`: the flow's step keys;
- `ends`: the flow's end labels.

The adversary's "untyped string keys" applied only to `outlet`, which is removed. An attribute reference is a key of a typed schema, and making it an entity would add a noun with no product (principle 9).

### Timers

- A timer fires as a mailbox event `{ firedAt, deadline }`.
- An attribute timer is re-armed in the same append that changes the attribute, so an extended SLA's old deadline never fires.
- A timer with no matching reaction is deferred like any event. A recurring timer supersedes its own deferred predecessor rather than piling up.

### Fields

Store fields are loaded once when an attempt opens and are frozen for it.

### Monitors (spawn)

- Each child's terminal transition appends `monitor.down`.
- The spawn step completes when every child is down. Its output is `ChildView[]`.
- Restart reads the `monitor.down` facts. Running children are separate units and are never restarted.

### Halts, skips, budget

- Lane `skips` resolve a halt by a deterministic gate. They are recorded as `skipped` and never counted as decision samples.
- `budget.maxUsdPerUnit` is checked before every invocation. With `onExceed: 'halt'` the attempt blocks with reason `budget`, holding no WIP while it waits.

### Metrics and policies

Metrics:
- `H.metric(name).of(lane | decision | executable).hit(test)` or `.invocations(sorts)`.
- Every rate is returned as `{ rate, hits, n, window }`. Windows are a `Duration` or `'all'`.
- Queries address entities only.

Policies:
- `PolicyContext.unitOf(kind)` returns the unit typed by that kind.
- The schedule context offers `c.order(...)`, `Candidate.is(lane)` and `OpenAttempt.is(lane)`.
- Every read inside a policy is recorded in `policy.decided`.
- The kernel never starts work in a paused lane.

### Triggers and thresholds

**Sources.** `transition`, `streak`, `step`, `event` (including timers), `crossed` / `recovered`.

**Consequences.** `creates`, `sends`, `records`, `invokes`, `pauses` / `resumes`.

**Recording.**
- Each firing is recorded with its source sequence number.
- A pause and a resume are recorded as `lane.paused` / `lane.resumed` with the metric reads that caused them.

**Thresholds.**
- They hold hysteresis per group in the ledger, so one crossing means one firing.
- `trippedAt` names the episode, so an Audit keyed `category@trippedAt` is addressed exactly by its own recovery.

### Restart after a crash (scenario 10)

**Replay.** The kernel replays `step.recorded` outputs; completed steps are not run again. For the step that was running, it applies that step's restart rule:

| Rule | Behaviour |
|---|---|
| `rerun` | runs the step again |
| `escalate` (the default for commands and externals) | blocks the attempt with reason `restart` |
| `ask` (the default for agents) | `Driver.settled` / `External.settled` reports whether the invocation finished |
| `{ probe }` | runs a probe command; `done: true` continues, otherwise the attempt escalates |

**State that moved while the harness was down.**
- Batches are collected through their recorded `batch.submitted`, never resubmitted.
- Halts resolved meanwhile (submitted through `console()` / `Ledger.submit`) and children that finished are ledger facts, found on restart.
- Events received meanwhile are applied in sequence order, with deferral, on restart.

**Identity and metrics.** A resumed attempt keeps its id. An interrupted invocation is excluded from every rate.

**Changed definitions.** A changed fingerprint prefix up to the running step blocks the attempt with reason `definition`. The supervisor uses `manageAttempts` to restart it from the top or abandon it.

**Single writer.** `start()` claims a fenced writer lease. A second process is refused while the lease is live, or takes over a dead holder's lease with a higher token. Stale tokens are rejected on append.

**What the author writes.** Restart rules and probes only.

### Accounts and quota (principle 15 as ruled)

- `Ledger.quota` is an append-only `QuotaPartition` of consumed, cooldown and observed events.
- Each harness appends without a lock. The kernel folds the window from all harnesses' events at every eligibility read.
- `sqlite.ledger(path, { quota: sqlite.quota(shared) })` places the partition in a shared file.
- Pool shares are defaults on the descriptor. `setShares` appends `share.set`, and the effective share is folded from those events.

### Control API

- Operations are built-ins or custom, granted through an access.
- Transport is the client adapter (MCP session, plain HTTP).
- `start()` returns `Running`; `console()` returns `Console`.

### Startup validation

`start()` fails on any of:
- duplicate names;
- an end routed to an active state;
- a `during` key that is not a step;
- a kind with active states but no `opens`;
- a reaction from an active state without `.cancels()`;
- a reaction state outside the kind;
- a flow event the kind lacks;
- an unregistered lane;
- a terminal state without a verdict;
- `restart: 'ask'` on an executable with no `settled`;
- a batch on a model that cannot batch;
- an agent without a model or pool;
- `.sets` keys that are fields;
- a `Route` with `upTo < 1`.

## Answers to the adversary

**Worst scenario 2.**
- *Approvals held WIP.* Fixed by the capacity rule: blocked attempts hold nothing.
- *Unbounded rejection loop.* Fixed by `Route` (`upTo`/`then`).
- *State-name strings in the SLA filter.* Replaced by `H.on.event(..., { in: [...] })` with state entities, or by triggering on the transition to `Escalated`.
- *Event races.* Resolved by the per-unit sequence-order rule.

**Contract counsel.**
- Counsel's verdict is a `halt` on a `Decision`, so it stays a decision metric and holds no drafting WIP.
- Returns are counted by `returned: { to: Redrafting, upTo: 2, then: Declined }`.
- A redline during drafting is deferred and applied when the round ends.

**Critique 1 (shadow statuses).** `parked` and `receiving` are deleted. Exhaustion moves to a declared state, and spawn/batch waits are a running attempt at a step. Two words remain, position and attempt status, as principle 12 defines them.

**Critique 2 (flows coupled to state names).** `.mark` is deleted. Flows name steps and ends; the lane's `during` / `ends` map them. One flow now fits kinds with any number of active states.

**Critique 3 (dropped events, string keys).** Deferral with explicit `event.dropped` replaces `event.ignored`, and nothing is lost silently. `outlet` is removed, and the remaining keys are typed.

## What changed and why

**Rename.**
- `Journal` → `Playbook` throughout: `H.playbook`, `PlaybookSpec`, `MemoryItem.playbook`.
- Reason: a journal is history and principle 14 forbids history; a playbook is forward rules with situations and reasons.

**Capacity.**
- Lane WIP is held by running attempts only. Blocked attempts release WIP, slot and account.

**Lifecycle mapping.**
- `.mark` is removed. The handler's `states` becomes `ends` plus `during` (keyed by step).
- `Route { to, upTo, then }` bounds repeating ends.
- `unit.transition` gains `end`, and `TransitionEvent` gains `end`.

**Retry exhaustion.**
- The handler gains `exhausted`, typed as required iff the kind has no `failsTo`.
- `WorkKind` and `Lane` carry the failure state as a type parameter.
- `UnitView.parked`, `unit.parked` and `unit.requeued` are removed. `Cause.by` gains `retry` and loses `supervision`.

**Mailbox.**
- `event.ignored` is replaced by `event.deferred` / `event.applied` / `event.dropped`.
- `UnitView.deferredEvents` is added.
- Per-unit sequence ordering is stated.

**Spawn.** `outlet` is removed; `spawns` is keyed by the spawn step key.

**Triggers.** `H.on.event` gains a state-entity filter `{ in }`.

**Removed.** `ReceiveView`, `AttemptView.receiving`, the `mark` step sort.

**Adapters.** They take `KindRef<A, F, St, Ev>`, the kind's data shape, instead of the full `WorkKind` generic list, so adding the failure parameter did not widen every adapter signature.

## Principles broken

none.
