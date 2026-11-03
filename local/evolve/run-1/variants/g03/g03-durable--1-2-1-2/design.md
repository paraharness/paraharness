# harness-dsl: units as processes, reactions are triggers (child of g02-durable-le-1-2-1)

Lens: Erlang/OTP `gen_statem`, as in the parent. The operator for this generation is **merge**. The merged pair is **reaction** and **trigger**.

A reaction was "on event E in states S, move to T". A trigger is "on a recorded source, apply consequences". These rhyme exactly: a reaction is a trigger whose source is a unit's received event and whose consequence is a move of that same unit. `H.reaction`, `Lane.reacts` and `ReactionSpec` are gone. `Trigger.moves(to, { from, cancels })` replaces them.

The adversary's three critiques are each repaired by one rule:
- Shadow statuses: `parked` and `receiving` are deleted.
- Flow-to-state coupling: marks are deleted, and the lane maps step keys instead.
- Silent drops: mailbox postponement replaces `event.ignored`.

The worst-scenario defects are repaired as follows:
- Halts no longer hold WIP, because a halt puts the unit in a waiting state.
- Rejection loops are bounded by `Repeated` endings.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind in one lane.
  - Its key is unique in the lane forever. A repeated create is recorded as `unit.deduplicated` and does nothing else.
  - A unit outlives its attempts.
- **Attempt**: one pass of the lane's flow over a unit.
  - Its outcome is `succeeded`, `failed` or `cancelled`.
  - While open, its status is `running` or `blocked`.
  - **Blocked** means waiting on a human. The reasons are: decision, question, budget, failure, restart, definition.
- **Halt**: the flow step that blocks an attempt for a decision.
- **Step**: one named node of a flow. `AttemptView.step` carries its key and sort.
- **Invocation**: one execution of an executable in a step. A retry is a new invocation.
- **Mailbox**: the unit's received events, in arrival order. Each one is in exactly one of four states:
  - **pending**: not yet offered;
  - **postponed**: offered, nothing could use it yet;
  - **applied**: a moving trigger used it, and a flow of the lane still has to read it;
  - **consumed**: done.
- **Removed words**: parked, receiving, mark, reaction, ignored.

## Entities

### Kinds (no backend)

- `H.state(name, position[, verdict])`. Terminal states must give a verdict.
- `H.work`, with these builders:
  - `.attributes`
  - `.fields`
  - `.states`
  - `.events`
  - `.timers`: timers are mailbox events.
  - `.key`
  - `.failsTo(state)`
- `H.role`, with `.intents` that the driver maps to tools.
- `H.decision`
- `H.memory.experience` and `H.memory.taste`, with `.curated()`.
- `H.resource`
- `H.command`
- `H.flow`. A flow is blind to kinds and states.

### Instances (adapter subpaths)

Account, model, runner, ledger with its quota partition, store, memory store, supplier, client, projection, and external executable.

### Pivots

| Pivot | Composed of | Produces |
|---|---|---|
| lane | kind × suppliers × store × flow × runner × retry | where a kind's units are produced, kept and handled; the step/halt/end → state map |
| agent | role × model or model policy × pool × journals | an executable that thinks |
| pool | accounts × shares × preference × fallback | the accounts an agent may draw on |
| journal | memory kind × memory store × recall policy | where items are written and how they are recalled |
| trigger | source × consequences (moves, creates, sends, records, invokes, pauses, resumes) | a recorded firing |
| threshold | metric × group × trip/reset bounds | recorded crossings |
| access | operations | what a client may do |
| harness | ledger × lanes × triggers × schedule × clients × projections | a running node (`start`) or a console (`console`) |

## The merge: reaction into trigger

`H.trigger('customerReplied', H.on.event(conversations, 'customerReplied')).moves(New, { from: [Classifying, Drafting, AwaitingApproval], cancels: true })`

How it types:
- `H.on.event` returns `Source<E, St>` carrying the lane's state union.
- `Trigger.moves` accepts only states of that kind.
- Every other source carries `St = never`, so `.moves` cannot be called on it.

**One firing, all consequences.** A trigger with `.moves` fires when its move applies: the unit is in a `from` state and `where` holds. It then performs the move and every other consequence in one append.

**Postponement and consumption** (OTP `postpone`). When an event is offered:

1. **A moving trigger applies to it.** The trigger fires.
   - If some flow of the lane declares the event name, the event becomes **applied**. It stays readable by the next attempt and is consumed at that attempt's watermark.
   - Otherwise it is consumed at once.
2. **No moving trigger applies, but a flow of the lane declares it.** It stays pending for the next attempt's read. Events up to the last reading step's `step.recorded.mailboxSeq` are consumed when the attempt ends.
3. **Nothing could ever move or read it.** Its non-moving triggers fire at receipt and consume it.
4. **Otherwise it is postponed** (`event.postponed`). After every transition of the unit, postponed events are re-offered in arrival order.

The checks around this rule:
- `start()` fails if a kind's event has no trigger and no flow that reads it. **No event is dropped silently.**
- `UnitView.postponedEvents` puts the count on the board.

**Ordering.** Each unit's mailbox is processed strictly in arrival order.

**Cancels.**
- `cancels: true` is required when any `from` state can hold an open attempt: an active state, or a waiting state that a halt targets in that lane.
- `start()` checks this.

### What the merge costs in honesty

1. A moving trigger may fire later than its source event. The firing records both `sourceSeq` and `appliedAtSeq`.
2. Event moves live in the harness's trigger list, not in the lane. The board lists moving triggers under their lane.
3. The consumption rule has four cases where the parent had two.

## Rules

### Lifecycle and positions

**Lane mapping.** `handler(flow, config)` maps the flow onto the kind:
- `ends`: every end label goes to a non-active state, or to a `Repeated` `{ to, times, thereafter }`. The count comes from the ledger.
- `opens`: the active state entered when an attempt opens. It is required when the kind has active states.
- `progress`: optional. It maps step keys (not halt keys) to non-terminal states.
  - A command or agent step must target an active state.
  - A spawn or batch step may target a waiting state.
- `halts`: required for every halt key, and typed to the kind's waiting states. When the halt resolves, the unit returns to the active state it held before.

**Capacity is defined on positions only.**
- Active-position units hold lane WIP.
- Waiting-position units hold nothing and are not schedulable.
- A runner slot and an account are held only while a command or agent step is invoking.

**Unplanned blocks** (budget, question, restart, definition, step failure set to halt) leave the unit in its active state, holding WIP. This is deliberate back-pressure.

**Failed attempts.**
- By default a failed attempt leaves the unit at its pending state under `.retry(policy, { exhausted: S })`.
- A kind with `.failsTo(S)` moves to `S` on every failed attempt.
- `start()` fails when a kind has no `failsTo` and its lane has no `retry`.

**Outcome rate.**
- The rate is success / (success + failure) over units reaching terminal states, with `n` beside it.
- Neutral endings appear in `byVerdict`, `byState` and `share(State)`.

### Mailbox

- **Suppliers** emit `create` or `event` through a typed `supply` maker. Keys are unique forever.
- **Reading events.** A flow that declares `.events` reads the unit's pending and applied mailbox entries for those names, typed, in arrival order.
- **Attribute timers** are re-armed in the same append that changes the attribute. An extended SLA's old deadline never fires.
- **Fields** are loaded when an attempt opens and frozen for that attempt.

### Spawn (monitors)

- `spawn(key, { child, items })` creates children and monitors them. The lane's `spawns` map is keyed by step key.
- Each child's terminal transition appends `monitor.down`. Restart reads these from the ledger.

### Halts, skips, budget

- `halt(key, decision, { ask })` blocks the attempt and moves the unit to the mapped waiting state.
- A lane `skips` entry may resolve a halt by a deterministic gate. It is recorded as `skipped` and is never a decision sample.
- `budget.maxUsdPerUnit` is checked before every invocation.

### Metrics, policies, thresholds

- `H.metric(...).of(lane | decision | executable)` and `.invocations()`.
- Every rate is `{ rate, hits, n, window }`.
- For a decision metric, `MetricQuery.model` keeps the decisions whose attempt used that model in any step.
- Every policy read is recorded in `policy.decided`.
- Thresholds hold hysteresis per group and carry `trippedAt`.

### Restart after a crash (scenario 10)

**Replay.** Recorded `step.recorded` outputs are replayed. The running step gets its restart rule:

| Rule | Behaviour |
|---|---|
| `rerun` | runs the step again |
| `escalate` (the default for commands and externals) | blocks the attempt with reason `restart` |
| `ask` (the default for agents) | the driver's `settled` reports whether the invocation finished |
| `{ probe }` | a probe command decides |

**State that moved while the harness was down.**
- Batches are collected through `batch.submitted`.
- Halts resolved and children that finished meanwhile are ledger facts, submitted by `console()`.

**Identity and metrics.** A resumed attempt keeps its id. Interrupted invocations are excluded from rates.

**Changed definitions.** A changed fingerprint prefix blocks the attempt with reason `definition`. `manageAttempts` lets the supervisor restart or abandon it.

**Single writer.** `start()` claims a fenced writer lease.

**What the author writes.** Restart rules and probes only.

### Accounts and quota (principle 15 as ruled)

- `Ledger.quota` is an append-only partition of `QuotaEvent`s, folded at read time.
- `sqlite.ledger(path, { quota: sqlite.quota(shared) })` places the partition in a shared file.
- Shares are folded from `share.set` events.

### Control API

- Operations are granted through an access.
- Transport is the client adapter: an MCP session or plain HTTP.

### Startup validation

`start()` fails on any of:
- duplicate names;
- an end label mapped to an active state, or outside the kind;
- a kind with active states but no `opens`;
- a progress mapping of a command or agent step to a non-active state;
- a moving trigger from an attempt-holding state without `cancels`;
- states outside the kind;
- a kind event with no trigger and no reading flow;
- a flow event the kind lacks;
- an unregistered lane;
- a terminal state without a verdict;
- a kind with neither `failsTo` nor `retry`;
- `restart: 'ask'` without `settled`;
- a batch on a model that cannot batch;
- an agent without a model or pool;
- `.sets` keys that are fields.

## What changed and why

- **Merge.**
  - Reaction became trigger (`.moves`).
  - `Source` and `Trigger` gained the kind's state parameter.
  - Removed: `H.reaction`, `Lane.reacts`, `Reaction`, `ReactionSpec`.
- **Mailbox.**
  - Added postponement: `event.postponed`, `event.consumed`, `Ledger.mailbox`, `step.recorded.mailboxSeq` and `UnitView.postponedEvents`.
  - Removed `event.ignored`.
- **Flows.** `.mark` was removed. `spawn` lost `outlet`.
- **Lane.** The handler config gained `ends`, `progress`, `halts` and `Repeated` endings. `.retry(policy, { exhausted })` replaces parking.
- **Capacity.** It is defined on positions only.
- **Applied events (this generation's scenario pass, 06–10).**
  - The gap: a moving trigger used to consume the event it applied. That made the event unreadable by the very attempt it scheduled.
  - Scenario 8 broke on it: `vendorReplied` moves a Negotiation from AwaitingVendor to RoundDue, and the next round must read the vendor's text. Scenario 2 had the same flaw: `customerReplied` returns a conversation to New "with the new message".
  - The fix: an applied event stays readable when a flow of the lane declares its name. It is consumed at the reading attempt's watermark.
  - This is a rule change with no type change. The mailbox fold derives "applied" from `trigger.fired.sourceSeq`, so `kernel.d.ts` is unchanged.
- **Decision metrics by model.** `MetricQuery.model` on a decision metric selects decisions from attempts that used that model in any step. Scenario 6's A/B policy relies on this, and the rule was previously unstated.

## Principles broken

None.
