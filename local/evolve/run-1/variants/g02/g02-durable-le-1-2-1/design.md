# harness-dsl: units as processes (child of g01-durable-able-1-2)

Lens: Erlang/OTP. A unit is a `gen_statem`:
- its kind's states are the machine's states;
- the events it receives are its mailbox;
- its timers are statem timeouts;
- a parent that spawns children monitors them;
- the harness is a supervision tree.

The owner's vocabulary is kept. The lens supplies rules, not new nouns, except where noted. Every OTP idea maps onto a word the harness already had:

| OTP | harness-dsl |
|---|---|
| process / `gen_statem` | unit (identity `(lane, key)`, outlives attempts) |
| state | kind state (position + verdict) |
| mailbox, `receive` | `event.received` records; `c.events` in flows; reactions |
| `state_timeout` / generic timeout | kind timers (recurrence, or an attribute deadline re-armed on change) |
| `monitor` / `DOWN` | `spawn` step; `monitor.down` ledger facts |
| child spec `restart` | step `restart`: `rerun` (permanent), `escalate` (temporary, report to supervisor), `ask`, `probe` |
| restart intensity | step `retry` over invocations; lane `retry` over attempts |
| escalation past intensity | unit parked for the human supervisor |
| node + global name registration | writer lease on the ledger (one live writer) |

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind in one lane. Its key is unique in the lane forever, so a create whose key matches any existing unit is recorded as `unit.deduplicated` and does nothing else. A unit outlives its attempts.
- **Attempt**: one pass of the lane's flow over a unit.
  - Its outcome is `succeeded`, `failed` or `cancelled`.
  - While open, its status is `running` or `blocked`.
  - **Blocked** means waiting on a human. The reasons are a decision, an agent question, the budget, an exhausted step, a restart, or a definition change.
  - A running attempt may be **receiving**: alive, holding lane WIP, but holding no runner slot or account. It receives children's `DOWN`s, a batch result, or an outstanding invocation. This is OTP's process parked in `receive`, not a third status.
- **Halt** is the flow step that makes the attempt blocked. Halt is the verb, blocked is the status (as with send and sent).
- **Step**: one named node of a flow.
- **Invocation**: one execution of an executable in a step. A retry is a new invocation.
- **Parked**: a unit whose lane retry intensity is exhausted.
  - Its position reads `waiting` (principle 12's own gloss).
  - It stays parked until the supervisor requeues it or moves it.
- Removed words: suspended, wait (as an attempt status), run.

## Entities

### Kinds (no backend)

**`H.state(name, position[, verdict])`**: terminal states must declare a verdict.

**`H.work`**: a work kind.
- `.attributes`, `.fields`, `.states`, `.events`, `.timers`, `.key`.
- **`.failsTo(state)`** is the kind's optional failure move (principle 12). It is typed to non-active states.

**`H.role`**: `.intents` are mapped to tools by the driver.

**`H.decision`**, **`H.memory.experience` / `.taste`** (with `.curated()`), **`H.resource`**, **`H.command`**.

**`H.flow`**:
- Blind to kinds and states.
- Its labels come in two sorts:
  - *marks* (`.mark`) are progress inside an attempt;
  - *ends* (`.exit`, `.ends`) are how the attempt finishes.

### Instances (adapter subpaths)

Account, model, runner, ledger and its quota partition, store, memory store, supplier, client, projection, external executable.

### Pivots

| Pivot | Composed of | Produces |
|---|---|---|
| lane | kind × suppliers × store × flow × runner × retry | where a kind's units are produced, kept and handled |
| agent | role × model or model policy × pool × journals | an executable that thinks |
| pool | accounts × default shares × preference × fallback | the accounts an agent may draw on |
| journal | memory kind × memory store × recall policy | where items are written and how they are recalled |
| reaction | target state × source states × attempt cancellation | a unit's answer to a received event |
| trigger | source × consequences | a recorded firing |
| threshold | metric × group × trip/reset bounds | recorded crossings |
| access | operations | what a client may do |
| harness | ledger × lanes × triggers × schedule × clients × projections | a running node (`start`) or a console (`console`) |

## Rules

### Lifecycle

**Lane mapping.** The handler config maps every mark to any state of the kind, and every end label to a non-active state. The types enforce both. `opens` names the active state the unit enters when an attempt opens. It is required when the kind has active states, so a kind may have several active states (Classifying, Drafting, AwaitingApproval).

**Failed attempts.**
- By default a failed attempt leaves the unit at its pending state. The lane's `retry` (OTP restart intensity) queues the next attempt with backoff.
- On exhaustion the unit is **parked**. A kind with `.failsTo(S)` instead moves to `S` on every failed attempt.
- `failed` is no longer a flow label.

**Positions.**
- Active-position units hold lane WIP.
- Waiting-position units (and parked units) hold nothing and are not schedulable.

**Outcome rate.**
- Rate = success / (success + failure) over units reaching terminal states, with `n` beside it.
- Neutral endings appear only in `outcomes().byVerdict` and `byState`.
- `outcomes({kind}).share(State)` answers "how often inconclusive".
- Track record for models and agents is the terminal verdict, attributed to the attempt that moved the unit to terminal. Attempt outcomes are reported separately, by `attempts()`.

### Mailbox and reactions

**Suppliers.**
- A supplier emits `create` or `event`. Every adapter map receives a typed `supply` maker (`supply.create(...)`, `supply.event(key, name, payload)`), so union-returning maps need no annotation.
- Since keys are unique forever, a poll can never resurrect a closed conversation.

**Received events.**
- Every received event is recorded (`event.received`, with `stateBefore`).
- A flow that declares `.events` reads the unit's whole mailbox for those names, typed, in arrival order. This is selective receive.

**Reactions** (`H.reaction(To).from([...])`) move the unit on an event.
- If any source state has position `active`, the reaction must say `.cancels()`. Otherwise `start()` fails.
- Cancellation of an open attempt is therefore always written, never implied.
- An event matching no reaction is recorded as `event.ignored`.
- Reactions may leave terminal states (a regression reopens a Done bug). The same unit keeps its key and history.

**Timers.**
- A timer fires as a mailbox event `{ firedAt, deadline }`.
- An attribute timer is re-armed in the same append that changes the attribute, so an extended SLA's old deadline never fires.

**Fields.** Store fields are loaded once when an attempt opens and are frozen for it. Edits in the store reach the next attempt, never the running one.

### Monitors (spawn)

**While children run.**
- `spawn` creates children and monitors them. The attempt stays running and receiving.
- It releases its runner slot and account, and keeps lane WIP. An Epic in progress is an epic in WIP.

**Children terminating.**
- Each child's terminal transition appends `monitor.down` for the parent attempt.
- The step completes when every child is down. Its output is the `ChildView[]`.

**Restart.** Restart reads the `monitor.down` facts from the ledger. Running children are separate units and are never restarted.

### Halts, skips, budget

**Halts.**
- `halt(key, decision, { ask })` blocks the attempt.
- Lane `skips` may resolve a halt by a deterministic gate. A skip records `skipped` and is never a decision sample.

**Budget.** `budget.maxUsdPerUnit` is checked before every invocation against the unit's cost. `onExceed: 'halt'` blocks the attempt with reason `budget`.

### Metrics

- `H.metric(name).of(lane | decision | executable).hit(test)` defines a metric. `.invocations(sorts?)` measures over invocations of the given sorts.
- Windows are a `Duration` or `'all'`. `'all'` gives "200 approvals and zero rejections ever".
- Every rate is returned as `{ rate, hits, n, window }`.
- Queries address entities only: `kind`, `lane`, `model`, `agent`, `role`. `UnitView.kind` and `UnitView.lane` are entity references, so `metrics.success({ kind: c.unit.kind })` builds no fake entity.
- Every read inside a policy is recorded in `policy.decided`.

### Policies

- `PolicyContext.unitOf(kind)` returns the unit typed by that kind, or null. Model policies read `category` without index lookups.
- The schedule context offers `c.order(key, key, ...)` (ascending, lexicographic) and the type guard `Candidate.is(lane)`.
- `OpenAttempt.is(lane)` replaces `inLane`.
- Lane names never appear as strings in policies.
- The kernel never starts work in a paused lane. The policy only orders the candidates and names attempts to preempt.

### Triggers and thresholds

**Sources.** `transition`, `streak`, `step`, `event` (including timers), `crossed` / `recovered`.

**Consequences.** `creates`, `sends`, `records`, `invokes`, `pauses` / `resumes`.

**Recording.** Each firing is recorded with its source sequence number. A pause and a resume are recorded as `lane.paused` / `lane.resumed` with the metric reads that caused them.

**Thresholds.**
- They hold hysteresis per group in the ledger.
- Each crossing appends one `threshold.crossed` event, so the threshold itself is the dedupe: one Audit per crossing.
- Every crossing carries `trippedAt`, the time of the trip that opened the current episode for its group. On a trip it equals `at`. On a reset it names the trip being closed.
- An Audit's key is `category@trippedAt`. Keys stay unique forever, and the recovery trigger can address exactly the Audit its own trip opened.

### Restart after a crash (scenario 10)

**Replay.** The kernel replays recorded `step.recorded` outputs; completed steps are not run and cost nothing. For the step that was running, it applies that step's restart rule:

| Rule | Behaviour |
|---|---|
| `rerun` | runs the step again |
| `escalate` (the default for commands and externals) | blocks the attempt with reason `restart` |
| `ask` (the default for agents) | `Driver.settled` / `External.settled` reports whether the invocation finished |
| `{ probe }` | runs a probe command; `done: true` continues, otherwise the attempt escalates |

**State that moved while the harness was down.**
- Batches are collected through their recorded `batch.submitted`, never resubmitted.
- Halts resolved meanwhile and children that finished are ledger facts. `harness.console()` serves clients with no writer lease, and writes only through `Ledger.submit`.

**Identity and metrics.** A resumed attempt keeps its id. An interrupted invocation is excluded from every rate.

**Changed definitions.** If the fingerprint prefix up to the running step changed, the attempt blocks with reason `definition`. `manageAttempts` lets the supervisor restart it from the top or abandon it.

**Single writer.** `start()` claims a fenced writer lease. A second process is refused while the lease is live, or takes over a dead holder's lease with a higher token. Stale tokens are rejected on append.

**What the author writes.** Restart rules and probes only.

### Accounts and quota (principle 15 as ruled)

**The quota partition.**
- `Ledger.quota` is an append-only partition of `QuotaEvent`s: consumed, cooldown, observed.
- Each harness appends its own events with no lease and no lock.
- The kernel folds the window from all harnesses' events at every eligibility read.
- `sqlite.ledger(path, { quota: sqlite.quota(shared) })` places the partition in a shared file. The adapter only stores and streams events; there is no `state()`, `consume()` or lock.

**Shares.**
- Pool shares are defaults on the descriptor.
- `setShares` appends `share.set` to the harness's own ledger, and the effective share is folded from those events. Descriptors are never mutated.

### Control API

- Operations are built-ins or custom, granted through an access.
- Transport is the client adapter (MCP session, plain HTTP).
- `start()` returns `Running` (lease + control). `console()` returns `Console` (control only, no scheduling). These are two named products, not one product with a flag.

### Startup validation

`start()` fails on any of:
- duplicate names;
- a label mapped outside the kind, or an end label mapped to an active state;
- a kind with active states but no `opens`;
- a reaction from an active state without `.cancels()`;
- a reaction state outside the kind;
- a flow event the kind lacks;
- an unregistered lane in `unit()` / `event()` / `pauses()`;
- a terminal state without a verdict;
- `restart: 'ask'` on an executable with no `settled`;
- a batch on a model that cannot batch;
- an agent without a model or pool;
- `.sets` keys that are fields.

## Answers to the adversary

**Scenario 2 could not start.**
- Kinds may now have several active states. `opens` picks the entry state, and marks move between active states.
- Awaiting approval is still a blocked attempt (halt), while the unit's state says where the conversation is.
- `supply.event` removes the annotation.
- Forever-unique keys stop the poll from resurrecting closed tickets.
- `window: 'all'` gives the exact safe-category rule.
- A rejection ends the attempt at a non-active state the author chooses, and the lane's retry intensity bounds loops.

**Scenario 11 (the tracker is the truth).**
- `linear.issues` map receives `status` / `statusChanged` and may emit `supply.event(key, 'trackerMoved', { status })`.
- Reactions map tracker moves: to Abandoned with `.cancels()` from Working; to Todo from Done (regression, same unit).
- Fields are frozen per attempt, so description edits reach only the next attempt.
- Board causes distinguish `supplier:linear` from `flow`.
- No store watch is needed: the supplier is the read side, the store the write side.

**Quota as a second store.** Repaired as above. The partition is append-only events, has no lock, and the kernel folds them.

**Raw strings for entities.**
- `entry.lane`, `agent: string`, `inLane` and `paused: string[]` are gone.
- Typed `unitOf` and entity-valued `UnitView.kind` / `lane` replace them.
- `c.order` removes the helper-parameter annotation.

**Halt / block / wait / suspend.**
- One status word, blocked, for human waits. Halt is its verb.
- Machine waits are "receiving" (a detail of running).
- The unit position `waiting` is the only waiting.
- `suspended` and `WaitView` are removed. A Tenancy's "Suspended" is the customer's word for a domain state, not kernel vocabulary.
- `start()` / `console()` are distinct products.
- Reactions say `.cancels()`.

## What changed and why

**Lens.**
- Mailbox semantics are defined: whole-mailbox selective receive, `event.ignored`, reactions allowed from terminal states.
- Monitors are the spawn mechanism (`monitor.down` facts).
- Supervision intensity: the lane gains `.retry`, and parked units replace the implicit "failed → some state".

**Principle 12 as amended.**
- `failed` is removed from flow labels.
- `WorkKind.failsTo` is the declared failure move.
- The default is pending under the lane's retry policy.

**Flows.**
- Marks are separated from end labels in the types; end labels must map to non-active states.
- `opens` is added.
- `wait` and `H.time.after` are removed: long waits are unit states with timers (attempt per round), as OTP models them.

**Unit keys.** Keys are unique forever: no resurrection, and dedupe for Audits is by threshold crossing.

**Supply.** `SupplyMaker` is passed to every supplier map.

**Quota.**
- `Quota` (with `state`, `consume`, `cooldown`) is replaced by `QuotaPartition` (`append`, `events`), with folding in the kernel.
- Shares are folded from `share.set` events.

**Policies.** `PolicyContext.unitOf`, `ScheduleContext.order`, `Candidate.is` and `OpenAttempt.is` are added; lane and agent strings are removed.

**Metrics.** `Window = Duration | 'all'`, and `MetricQuery.role` is added.

**Control.** `harness.console()` replaces `control()`. `Running` carries the lease. `ControlApi.scheduling` is removed.

**Removed.** `WaitView`, `suspended`, `ScheduleContext.paused` / `inLane`, `Candidate.entry`, the `flow.wait` step, `Delay`.

**Scenario pass 06–10: `trippedAt` on crossings.**
- `ThresholdEvent` and the `threshold.crossed` ledger fact gain `trippedAt`.
- The gap: scenario 9's recovery trigger must cancel the Audit its trip opened. Audit keys must embed the trip time, because keys are unique forever and a category may be audited many times. A reset event carried only its own time, so the trigger could not name the unit.
- `trippedAt` is part of the hysteresis state the threshold already holds per group, so no new entity is introduced. `h.d.ts` is unchanged.

## Principles broken

none.
