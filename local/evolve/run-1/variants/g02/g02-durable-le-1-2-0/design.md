# harness-dsl: durable, split control (child of g01-durable-able-1-2)

Lens: a unit of work is a durable execution, and the ledger is its history.

Operator for this generation: **split**. The parent's `Harness` did two jobs:
- it ran the scheduler as the single ledger writer;
- it served the control API to clients.

The parent told them apart with a hidden flag: `start()` and `control()` both returned `Running`, and only `ControlApi.scheduling: boolean` showed which mode was live. This child splits them:
- **harness** is the scheduler.
- **control plane** (`H.control(name, harness)`) is the endpoint that clients reach.

## Execution vocabulary (one definition each)

**Unit.** One piece of work of one kind in one lane, identified by `(lane, key)`. It lives in the ledger and may also have fields in a store.

**Attempt.** One pass of the lane's flow over a unit.
- Outcome: exactly one of `succeeded`, `failed` or `cancelled`.
- Status while open, exactly one of:
  - `running`.
  - `blocked`: waiting on a human. The reason is a decision, an agent question, the budget, a failure halt, a restart or a definition change.
  - `suspended`: waiting on the machine. It waits for a timer, children, a batch, or because it was preempted.
- `AttemptView.hold` is one discriminated value describing either a block or a suspension.
- A crash never ends an attempt. Suspension never creates a new one.

**Step.** One named node of a flow.
- A **halt** is the step that blocks an attempt. "Halt" names the step; "blocked" names the status.

**Invocation.** One execution of an executable inside a step. A retry is a new invocation.

**Waiting** is only a unit position: parked, holding nothing, not schedulable. No attempt status is called waiting, and the old `WaitView` is gone.

There is no "run", "block view" or "wait view".

## Entities

### Kinds (vocabulary, no backend)

`H.state`:
- `H.state(name, position)` for pending, active or waiting states.
- `H.state(name, 'terminal', verdict)` for terminal states. A terminal state has no default verdict.

`H.work(name)`, a work kind:
- `.attributes()`: ledger-held scalars.
- `.fields()`: store-held domain data.
- `.states([...])`: the first state listed is the initial one.
- `.onFailure(state)`.
- `.events()`.
- `.timers()`.
- `.key()`.

Other kinds:
- `H.role` with intents.
- `H.decision`.
- `H.memory.experience` and `H.memory.taste`, with `.curated()`.
- `H.resource`.
- `H.command` with `.parses()`.
- `H.flow`, which is blind to kinds and states.

### Instances (adapter subpaths)

- Account, model, runner.
- Ledger, quota partition, store, memory store.
- Supplier, client, projection, external executable.

### Pivots

| Pivot | Composed of | Produces |
|---|---|---|
| lane | kind × suppliers × store × flow × runner | the place a kind's units are produced, kept and handled |
| agent | role × model or model policy × pool × journals | an executable that thinks |
| pool | accounts × default shares × preference × fallback | the accounts an agent may draw on |
| journal | memory kind × memory store × recall | where items are written and how they are recalled |
| reaction | target state × from-states | how a lane answers an event |
| trigger | source × consequences | a recorded firing |
| threshold | metric × group × trip/reset bounds | recorded crossings |
| access | operations | what a client may do |
| harness | ledger × lanes × triggers × schedule × projections | the scheduler: the single writer of the ledger |
| control plane | harness definition × clients | the control API endpoint |

## Rules

### Skeleton (principle 12 as it stands)

**Positions.**
- **pending**: will be attempted; not active.
- **active**: an attempt is open and holds lane WIP. Blocked and suspended attempts keep WIP but release their runner slot and account.
- **waiting**: parked. It holds nothing.
- **terminal**.

**Attempt start.** When an attempt opens, the unit enters the kind's first-listed active state. If the kind has no active state, the unit keeps its state name and the board shows it under active.

**Handler config splits progress from outcome.**
- `outcomes` maps each end or exit label to any state of the kind.
- `progress` maps each `mark` label to an **active** state of the kind. This is type-checked through `Extract<St, {position:'active'}>`.
- A kind may declare several active states.
- A unit state never names an attempt status.

**Failure default.** A flow has no `failed` label.
- By default, a failed attempt leaves the unit pending. It is re-queued under the lane's `.retry(...)` policy.
- When retries are exhausted, the unit stays pending with no queue entry. The board shows it as exhausted, and `manageAttempts` re-queues it.
- Only a kind that declares `.onFailure(State)` moves on failure. It moves at once, with no lane retry.

**Kind outcome rate.**
- The rate is success / (success + failure) over terminal arrivals, with `n` reported beside it.
- Neutral endings appear in `byVerdict.neutral` and `byState` and never enter the rate.
- Success-with-warnings is a second success-verdict state, distinct in `byState`.

**Track record.** An agent or model is credited with the terminal verdict of the unit whose terminal transition its attempt caused. Interrupted invocations are excluded.

### Supply and dedupe

A supplier emits one of three things:
1. `{ create }`.
2. `{ key, event, payload }`, an event to an existing unit.
3. `{ key, fields }`, a refresh.

**Dedupe.**
- A create whose key matches **any** unit of the lane, terminal included, is recorded as `unit.deduplicated` and does nothing else.
- Kinds that re-open on purpose put the occurrence in the key (`slug@openedAt`, `service@due`, `category@trippedAt`).

**Refresh.**
- A refresh updates store fields and records `unit.refreshed`.
- An attempt reads fields once, at start.

### Reactions and external cancellation

A reaction moves the unit to its target state when the event arrives in one of its `from` states.
- If a `from` state is active and an attempt is open there, the reaction **cancels** it. The cancellation is recorded as `attempt.status` with outcome `cancelled` and cause `{by:'event'}`.
- A reaction on non-active states cancels nothing.
- Timers are events. An attribute timer re-arms whenever its attribute changes, so a moved deadline never fires at the old time.

### Triggers, thresholds, metrics

**Triggers.**
- Sources: transition, streak, step, event (including timers), crossed and recovered.
- Consequences: creates, sends, records, invokes, pauses and resumes.
- Every firing is recorded.

**Thresholds.**
- Thresholds keep hysteresis per group in the ledger. One `threshold.crossed` is recorded per crossing.
- Every crossing carries `trippedAt`: the time of the trip that opened the current episode. A reset event carries the same `trippedAt` as the trip it closes.
- A trip's consequence and its reset's consequence can therefore address the same unit by key. For example, an Audit keyed `category@trippedAt` is cancelled by the matching recovery.

**Metrics.**
- Every rate is `{rate, hits, n, window}`, and `window` may be `'all'`.
- An owner-defined metric's `hit` test returns `true` (a hit), `false` (a miss) or `null` (not a sample). This is how a metric is restricted to the events it is about, such as the decisions made on attempts that used a given model, or excludes interrupted invocations.
- Every policy read is recorded in `policy.decided`.

### Entities, not strings

Every test for "which lane" or "which kind" is `unit.is(laneOrKind)`.
- `UnitView.kind` and `UnitView.lane` are `Named`.
- The ledger returns `UnitRecord`, and the kernel wraps records into `UnitView`.

### Accounts and quota

Quota lives in `QuotaPartition`, a ledger partition of append-only quota events: `quota.consumed`, `quota.observed` and `quota.cooldown`.

**Append.**
- Each harness appends only its own events, tagged with its harness name.
- Appends need no writer token.

**Read.**
- The kernel folds the window at read time, at every eligibility decision.
- The latest observed window and cooldown come from any harness.

**Location.** `sqlite.ledger(path, { quota: sqlite.quota(sharedPath) })` places the partition in a shared file.

**Shares.**
- Shares on a `Pool` are descriptor defaults.
- `setShares` appends `share.set` to the harness's own ledger, through `submit`.

### Restart (scenario 10)

- Recorded step outputs are replayed.
- Per-step `restart` is one of:
  - `rerun`;
  - `park` (the default for commands and externals);
  - `{probe}`: the probe runs, `done` continues, anything else parks;
  - `ask` (the default for agents; it calls `Driver.settled` or `External.settled`).
- `batch.submitted` means the batch is collected, never resubmitted.
- Fingerprints park changed definitions with reason `definition`.
- A resumed attempt keeps its id, and `interrupted` invocations are excluded from rates.
- Halts resolved while the harness was down arrive through a control plane, which writes only facts through `Ledger.submit`.
- **Single writer:** `Ledger.claim` grants one fenced `WriterToken` per harness. Control planes never claim.

### Control plane

`H.control(name, harness).clients([...]).serve()` serves the control API for one harness definition, against that harness's ledger.
- Every write is an `ExternalFact` through `Ledger.submit`.
- It never schedules and never claims the writer token.

### Startup validation

`start()` and `serve()` fail on any of the following:
- duplicate names;
- an outcome label that is unmapped, or a mapping to a foreign state;
- a progress mark mapped to a non-active state;
- `.onFailure` given a state outside the kind;
- `.sets` keys that are fields;
- a reaction state outside the kind;
- a flow event the kind lacks;
- an unregistered lane in `unit()`, `event()` or `pauses()`;
- a terminal state without a verdict;
- `restart: 'ask'` on an executable that cannot settle;
- a batch on a non-batch model;
- an agent with no model or pool;
- a control plane whose harness has no ledger.

## What changed and why

### The split: Harness becomes harness plus control plane

Surface added:
- `H.control`;
- the `ControlPlane` entity;
- `HarnessSpec`.

Surface removed:
- `Harness.clients`;
- `Harness.control()`;
- `ControlApi.scheduling`;
- the `Running` type.

### Vocabulary repair

- One `Hold` replaces `WaitView` and `BlockView`.
- The attempt statuses are `running`, `blocked` and `suspended`.
- `WriterLease` became `WriterToken`.

### Quota repair

- The mutable `Quota` became the append-only `QuotaPartition`.
- `share.set` events replace mutation of the pool.

### Strings repair

- `UnitView.is(lane | kind)` is the one idiom.
- `UnitView.kind` and `UnitView.lane` are `Named`.

### Critique of scenario 2

- `progress` and `outcomes` were added, and multiple active states are allowed.
- Dedupe now spans terminal units.
- `window: 'all'` was added.

### Principle 12 failure default

- `.onFailure` was added on the kind and `.retry` on the lane.

### Scenario 11 pressure

- The `{ key, fields }` refresh was added.

### Battery pressure from scenarios 6 to 10 (this revision)

**`MetricHit.hit` may return `null` (not a sample).**
- Scenario 6 defines "editor acted on the critique written by model M". Both reviewer models appear on every attempt, so a decision may only count as a sample for M when M wrote one of the critiques.
- Scenario 9's model error rate must leave interrupted and cancelled invocations out of the denominator.
- `MetricSpec.test` in the kernel already returned `boolean | null`; the builder now exposes it.
- Surface change: one return type.

**`ThresholdEvent.trippedAt` and `threshold.crossed.trippedAt`.**
- Scenario 9 opens one Audit per crossing and must cancel exactly that Audit on recovery.
- Without an episode identifier, the recovery trigger could not name the unit to send to. Keying the Audit by category alone would have blocked every later Audit for the category, because dedupe spans terminal units.
- With `trippedAt`, the episode is the key, and the per-group hysteresis guarantees at most one open episode per group.
- Surface change: one field.

## Principles broken

none.
