# harness-dsl: durable, inference-first, honest triage (child of g01-durable-able-1-2)

Lens: a unit of work is a durable execution, and the ledger is its history. This generation's operator task is to fix the worst-handled scenario, scenario 2 (support triage). The parent's scenario 2 could not start. It needed a type annotation. It let a poll resurrect closed tickets. It approximated "ever" with 365 days. It left rejection unbounded.

Every fix is a surface change that the other nine scenarios also use. The adversary's three sharpest critiques are each repaired:
- quota as a second store;
- strings standing in for entities;
- four words for "not running".

## Execution vocabulary (one definition each)

**Unit.** One piece of work of one kind in one lane, identified by `(lane, key)`. By default a key names one unit forever. It lives in the ledger and may also have fields in a store.

**Attempt.** One pass of the lane's flow over a unit.
- Its outcome is exactly one of `succeeded`, `failed` or `cancelled`.
- While open, its status is one of:
  - `running`;
  - `blocked`: it needs a human or the supervisor. Reasons are `halt`, `question`, `budget`, `failure`, `restart` and `definition`;
  - `sleeping`: it will wake by itself, on a timer, children, a batch, or after preemption.
- Sleeping never creates a new attempt, and a crash never ends one.

**Step.** One named node of a flow.

**Invocation.** One execution of an executable inside a step. A retry is a new invocation.

**Halt.** The flow node that produces a block. "Halt" names the node and "blocked" names the status.

**Waiting.** A unit position, never an attempt status. A waiting unit has no open attempt.

There is no "run", no "suspended" attempt status, and no "wait view".

## Entities

### Kinds (vocabulary, no backend)

**`H.state(name, position[, verdict])`**
- A terminal state must declare its verdict; there is no default.
- A kind may have any number of active states. An active state is a progress label for the open attempt.

**`H.work(name)`**, a work kind:
- `.attributes`: ledger-held.
- `.fields`: store-held.
- `.states`: the first listed state is the initial one.
- `.fails(state)`: optional. This is the principle-12 failure move (see Skeleton).
- `.events`, `.timers`, `.key`.

**Other kinds:**
- `H.role`: carries intents, never tool names.
- `H.decision`.
- `H.memory.experience|taste` with `.curated()`.
- `H.resource`.
- `H.command`.
- `H.flow`: blind to kinds and states.

### Instances (adapter subpaths)

Accounts, models, runners, ledger, store, memory store, supplier, client, projection, and external executables.

There is no quota instance. Quota is a partition of the ledger, located by the ledger adapter's own option (`sqlite.ledger(path, { quotaPartition })`).

### Pivots

| Pivot | Composed of | Produces |
|---|---|---|
| **lane** | kind × suppliers × store × flow × runner × retry | where a kind's units are produced, kept and handled |
| **agent** | role × model or model policy × pool × journals | an executable that thinks |
| **pool** | accounts × default shares × preference × fallback | the accounts an agent may draw on |
| **journal** | memory kind × memory store × recall | where items are written and how they are recalled |
| **reaction** | event × from-states × target × cancels | how a lane answers an event |
| **trigger** | source × consequences | a recorded firing |
| **threshold** | metric × group × trip and reset bounds | recorded crossings |
| **access** | operations | what a client may do |
| **harness** | ledger × lanes × triggers × schedule × clients × projections | a scheduler (`start`) or a console (`console`) |

## Rules

### Skeleton (principle 12)

**Positions.**
- **pending**: queued.
- **active**: an attempt is open and holds lane WIP.
- **waiting**: parked. It holds nothing and is not schedulable.
- **terminal**.

**Active states.**
- When an attempt opens, the unit enters the kind's **first listed active state**. If the kind lists none, the unit keeps its state and the board shows it under active.
- A flow `mark('x')` moves the unit to the active state the lane maps `x` to.
- `handler(flow, { ends: {...}, marks: {...} })` keeps outcomes and progress apart. `marks` is typed to the kind's active-position states only, so a mark cannot name a pending or terminal state.

**Ends.** Every end label (from `exit` or `ends`) maps to one of the kind's states. A succeeded attempt moves the unit there.

**Failure.**
- If the kind declares `.fails(S)`, a failed attempt moves the unit to `S` at once.
- Otherwise the unit stays pending and is re-queued under the lane's `.retry(...)`. The default is exponential, 3 retries, starting at 1 minute.
- When retries are exhausted, the unit is **held**: it is still pending but unqueued. The kernel appends `unit.held`, and the board shows it. The supervisor's `manageAttempts` re-queues or abandons it.
- The kernel never invents a failure state.

**Rates.**
- Kind outcome rate is success / (success + failure) over units reaching terminal, with `n` beside it.
- Neutral endings appear in `outcomes().byVerdict.neutral` and `byState`, and never enter the rate.
- Agent and model rates attribute the terminal verdict to the agents and models in the attempt that moved the unit to terminal.
- A success-with-warnings state is a second success-verdict terminal state: it is success to the scheduler and distinct in `byState`.

### Supply

**What a supplier emits.** Every adapter map receives `(item, to)`, where `to: SupplyTo<A, F, Ev>` has three typed builders:
- `to.create(...)`;
- `to.update(key, fields)`;
- `to.event(key, name, payload)`.

The map returns one of them or `null`. Because the builders' return types come from the kind, no scenario annotates a mapper.

**Key identity.** A create whose key matches **any** unit of the lane, terminal included, is recorded as `unit.deduplicated` and does nothing else. A poll therefore cannot resurrect a closed unit.

A lane that wants a key to become reusable once its unit is terminal declares `.reuseKeys()`.

**Updates.** `to.update` records `unit.fields` and saves through the store. An open attempt keeps the field snapshot it started with, and the next attempt sees the new values.

**Store observation.** A store may implement `observe(sinceMs)` to report changes made in the backend itself.
- The kernel records the move as `unit.transition` with cause `store`.
- If the unit had an open attempt, that attempt is cancelled, because the store is the source of truth.
- Field changes arrive as `unit.fields`.

### Reactions and external cancellation

`.reacts({ ev: H.reaction(Target).from([...]).cancels() })` reads as follows:
- When `ev` arrives in a listed from-state, the unit moves to `Target`. It is queued if `Target` is pending.
- `.cancels()` says, in the name, that an open attempt on the unit is cancelled first.
- A reaction whose from-states include an active state but which does not declare `.cancels()` is a startup error. Cancelling is never implicit.
- A reaction target must not be an active state, since active means an attempt is open.
- An event outside the from-states is recorded, delivered to the flow's `c.events` if the flow declares it, and changes nothing else.

Timers fire as events of the same name. An attribute timer is re-armed when its attribute changes, in the same append that removes the old queue entry.

### Triggers, thresholds, metrics

These are unchanged from the parent except for two points:
- `MetricQuery.window` accepts `'ever'`.
- Every metric query names entities: `kind`, `lane`, `model` and `agent` are `Named | null`, never strings.

### Policies read entities, not strings

**`PolicyContext`** carries the decision's subject as entities:
- `kind`, `lane` and `agent`;
- `unitIn(lane)`, which returns the unit typed by that lane's attributes, or `null`.

**Schedulers** test membership only by `candidate.is(lane)` and `inLane(attempt, lane)`.

### Loops

`loop(key, { carry, rounds }, body, again)` runs `body` up to `rounds` times.
- `again(last)` returns the next carry, or `null` to stop.
- Marks and halts declared inside the body belong to the flow like any other. The lane maps the marks, and skips may target the halts.
- End labels cannot be introduced inside a body. Exits come after the loop, reading `out[key].last` and `out[key].exhausted`.

### Halts and gates

- `flow.halt` blocks the attempt with reason `halt`.
- Skips are lane relationships typed by `GateContext<A>`. A halt inside a loop is skippable per round.
- Skipped decisions are never metric samples.

### Restart (scenario 10)

This is unchanged:
- step fingerprints;
- restart rules (`rerun`, `park`, `probe`, `ask`);
- `batch.submitted`;
- halts resolved while the harness was down, found through `Ledger.submit`;
- children read from the ledger;
- definition-change parking with `manageAttempts`;
- fenced writer leases.

### Harness modes are named

- `harness.start()` claims the writer lease and returns `Running`, which has the lease, the control API and `stop`.
- `harness.console()` returns a `Console`, which has the control API and `close`. It never schedules. It writes only external facts through `Ledger.submit`, which needs no lease.

### Accounts and quota (principle 15 as ruled)

**The partition.**
- `Ledger.quota` is a `QuotaPartition` of append-only `QuotaEvent`s.
- Each harness appends only its own events, tagged with its name, with no writer lease and no lock.
- The kernel folds the window at read time into `AccountState`.
- The partition may live in a shared file (`sqlite.ledger(path, { quotaPartition: sharedPath })`). This is the ledger partitioned by backend, not a second store.

**Shares.**
- Pool shares are the declared default.
- `setShares` appends `share.set` to the harness's own ledger, and the effective share is the latest `share.set` for that pool and account, else the declared default.
- No descriptor is mutated.

**Eligibility** folds both partitions at every decision and is never cached.

### Memory and control API

These are unchanged:
- Reads union every journal named; writes go to exactly one.
- Trigger writes into curated kinds enter as candidates.
- Operations are granted through an access.
- Transport is the client adapter.

### Startup validation

`start()` and `console()` fail on any of:
- duplicate names;
- an unmapped end label or mark;
- a mark mapped to a non-active state;
- `.fails` naming a state outside the kind;
- a reaction targeting an active state;
- a reaction from an active state without `.cancels()`;
- a flow event the kind lacks;
- an unregistered lane in `unit()` / `event()` / `pauses()`;
- a terminal state without a verdict;
- `restart: 'ask'` on an executable with no `settled`;
- a batch on a model that cannot batch;
- an agent without a model or pool.

### How scenario 2 now reads

**States.**
- `New` is pending and initial.
- `Classifying`, `Drafting` and `AwaitingApproval` are active. Attempt open enters `Classifying`; `mark('drafting')` and the in-loop `mark('awaitingApproval')` move the unit on.
- `Sent` has verdict success, `ClosedByCustomer` neutral, and `Escalated` failure.

**Customer replies.** `customerReplied` cancels and returns the unit to `New`. The next attempt reads the reply from `c.events.customerReplied`.

**Rejections are bounded in the flow.** A `loop` of up to 3 draft-and-approve rounds carries the reviewer's notes. When it ends without approval, `exit('escalate')` → `Escalated`.

**Safe category.** A skip on the in-loop `approval` halt reads `window: 'ever'`, `n ≥ 200`, `hits === n`.

**Cost ceiling.** `.budget({ maxUsdPerUnit: 0.4, onExceed: 'halt' })`.

**SLA breach.** An attribute timer drives a reaction to `Escalated` and a trigger that creates an Escalation unit.

## What changed and why

**Scenario 2 (operator).**
- Removed "at most one active state". Added the first-active-on-open rule.
- Split handler config into `ends` and `marks`, with marks typed to active states.
- Replaced literal `Supply` returns with typed `SupplyTo` builders, which removes the annotation.
- Keys are now forever by default, with `.reuseKeys()` to opt out.
- Added the `'ever'` metric window.
- Rejection is bounded in the flow.

**Principle 12 as currently ruled.**
- The failure default is pending plus the lane `.retry`, then held.
- `.fails(state)` on the kind is the declared move.

**Critique 1 (quota as a second store).**
- `QuotaPartition`: append-only events, no lock, folded at read.
- The shared location is a ledger adapter option.
- `setShares` appends `share.set`.

**Critique 2 (strings for entities).**
- `MetricQuery` takes `Named | null` only.
- `PolicyContext` gained `kind`, `lane`, `agent` and a typed `unitIn(lane)`.
- Schedules use `is(lane)` only.

**Critique 3 (vocabulary).**
- `suspended` is renamed to `sleeping`, and `WaitView` is replaced by `SleepView`.
- The block reason `decision` becomes `halt`.
- `control()` is replaced by the named `console()`.
- Cancellation by a reaction is explicit.

**Scenario 11 (adversary).** `to.update`, `to.event` and the optional `Store.observe` express a tracker that owns the lifecycle.

**Loop bodies carry marks and halts (found writing scenarios 1–5).**
- `loop` was typed so that the body had to return the same marks and halts it was given. Scenario 2's draft-and-approve round therefore could not:
  - mark `awaitingApproval` inside the round, which the board needs;
  - be skipped for the safe category, because skips are typed by the flow's halts and the halt was invisible.
- `loop` now infers the body's marks (`BM`) and halts (`BH`) and returns them on the flow. Their defaults are the outer ones, so a body that adds none (scenario 1's build-and-audit) is unchanged.
- End labels stay outside loops: a mid-loop exit would make "rounds ran out" ambiguous.

**Removed.** `sqlite.accounts`, `Quota`, `ControlApi.scheduling`, `ScheduleContext.paused`, `WaitView`, and the `failed` handler label.

## Principles broken

none.
