# harness-dsl: durable, inference-first (child of g00-durable-1)

Lens: a unit of work is a durable execution, and the ledger is its history. This generation has one goal: no scenario should need a cast, an explicit type argument or a type annotation to make the surface infer. Each such site in the parent was traced to a surface cause and removed at the source. The amended principle 12 is adopted, which also repairs the parent's one broken principle.

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind in one lane, identified by `(lane, key)`. It lives in the ledger and may also have fields in a store.
- **Attempt**: one pass of the lane's flow over a unit.
  - Its outcome is exactly one of `succeeded` (the flow reached an end label), `failed` (a step failed after its retries, a timeout, or a budget failure), or `cancelled` (an event, an operator or the supervisor ended it).
  - While open, its status is `running`, `blocked` (waiting on a human: decision, agent question, budget, restart or definition change), or `suspended` (timer, children, batch, preemption).
  - Suspension never creates a new attempt. A crash never ends one.
- **Step**: one named node of a flow. Its start (`step.started`) and its output (`step.recorded`) are ledger events.
- **Invocation**: one execution of an executable inside a step. A retry is a new invocation. A batch has one invocation per item, sharing a `batchId`.
- There is no "run".

## Entities

### Kinds (vocabulary, no backend)

**`H.state(name, position)`** or **`H.state(name, 'terminal', verdict)`**
- Position is one of pending, active, waiting, terminal.
- A terminal state must declare its verdict (success, failure or neutral). There is no default.

**`H.work(name)`**, a work kind:
- `.attributes()`: ledger-held, typed scalars.
- `.fields()`: store-held domain data.
- `.states([...])`: the first listed state is the initial one. A kind declares at most one state with position `active`.
- `.events({...})`: typed external events the kind accepts.
- `.timers(t => ...)`: each timer is a recurrence, a delay, or `t.attribute(key)` (an epoch-ms deadline).
- `.key()`: the unit's identity within the lane.

**`H.role`**:
- `.intents()`, `.instructions()`, `.input()`, `.output()`.
- Intents are mapped to tools by the driver.

**`H.decision(name, shape)`**: a named kind of human decision (reply approval, editor verdict, load approval). Halts produce decisions, and metrics read decisions.

**Memory kinds**: `H.memory.experience` and `H.memory.taste`. `.curated()` makes non-owner writes candidates.

**`H.resource`**: a named scope target for memory and leases.

**`H.command(name, argv)`**: `.parses(shape)` turns stdout into typed `data`.

**`H.flow(name)`**:
- Blind to kinds and states.
- `.requires` declares the input it needs.
- `.events` declares the event payloads it reads, typed.

### Instances (carry a backend; adapter subpaths)

Account, model, runner, ledger, account-state partition (`Quota`), store, memory store, supplier, client, projection, external executable.

### Pivots (each names its product)

| Pivot | Composed of | Produces |
|---|---|---|
| **lane** | kind × suppliers × store × flow × runner | the place a kind's units are produced, kept and handled |
| **agent** | role × model or model policy × pool × journals | an executable that thinks |
| **pool** | accounts × shares × preference × fallback | the accounts an agent may draw on |
| **journal** | memory kind × memory store × recall policy | where items are written and how they are recalled |
| **reaction** | target state × from-states | how a lane answers an event |
| **trigger** | source × consequences | a recorded firing |
| **threshold** | metric × group × trip/reset bounds | recorded crossings |
| **access** | operations | what a client may do |
| **harness** | ledger × lanes × triggers × schedule × clients × projections | a running scheduler |

## Rules

### Skeleton (principle 12 as amended)

**Unit positions.**
- **pending**: queued for an attempt.
- **active**: an attempt is open and holds lane WIP.
  - When an attempt opens, the unit enters the kind's active state.
  - If the kind declares no active state, the unit keeps its state name, and the board shows it under the active position.
- **waiting**: parked. It holds no capacity and is not schedulable. A tenancy between reviews or a negotiation awaiting the vendor sits here.
- **terminal**.

**Lane mapping.**
- The lane maps each flow label to a state, plus the implicit label `failed`.
- An attempt's outcome moves the unit only where that mapping says. For example, a tenancy review that fails returns to Current.

**Kind outcome rate.**
- Rate = success / (success + failure) over units reaching a terminal state in the window, with `n` beside it.
- Neutral endings are counted in `outcomes().byVerdict.neutral` and `byState`. They never enter the rate.
- Examples: Parked, Churned, Inconclusive, We walked away, Rejected-by-approver.
- "How often are experiments inconclusive?" is `outcomes({kind: Experiment}).share(Inconclusive)`.

**Agent and model track record.**
- `metrics.success({ model })` attributes a unit's terminal verdict to the agents and models that ran in the attempt that moved the unit to terminal.
- `metrics.attempts()` reports raw attempt outcomes.
- "The flow finished" is therefore never success.

**Success-with-warnings.** A second terminal state with verdict success is success to the scheduler and distinct in `byState`.

### Events and reactions

**Suppliers.**
- A supplier emits `{ create }` or `{ key, event, payload }`. The second updates an existing unit.
- A create whose key matches an open (non-terminal) unit is recorded as `unit.deduplicated` and does nothing else. This is how per-group dedupe works (one Audit per category).

**Lane reactions.**
- Declared as `.reacts({ name: H.reaction(State).from([...]) })`.
- When a reaction applies, the open attempt (if any) is cancelled, the unit moves to the target state, and it is queued if that state is pending.
- An event that arrives in a state not listed in `.from` is recorded and changes nothing.

**Events in flows.**
- Every received payload is recorded.
- A flow that declares `.events({...})` reads `c.events.<name>` as typed `Received<P>[]`, in arrival order.
- The lane checks at compile time that the kind declares those events with compatible payloads.

**Timers.**
- A timer fires as an event of the same name, with payload `{ firedAt, deadline }`.
- An attribute timer is re-armed when its attribute changes. The old queue entry is removed in the same append, so the old deadline never fires.

**Ordering.** Triggers and reactions see the same `event.received` record. Its `stateBefore` is the unit's state before the reaction applied.

### Triggers

**Sources.**
- `H.on.transition`.
- `H.on.streak`.
- `H.on.step`.
- `H.on.event`.
- `H.on.crossed(threshold)` and `H.on.recovered(threshold)`.

**Consequences.**
- `.creates(e => lane.unit({...}))`.
- `.sends(e => lane.event(key, name, payload))`.
- `.records(journal, ...)`.
- `.invokes(executable, ...)`.
- `.pauses(lane)` and `.resumes(lane)`.

**Recording.** Every firing is recorded with its source sequence number. A pause and a resume are recorded as `lane.paused` / `lane.resumed` with the metric reads that caused them. The board shows them, and `metrics.pausedMs` sums them.

**Thresholds.**
- `H.threshold(name, metric, { kind, per, window, minSamples, trips, resets })` is evaluated after every append that changes the metric's inputs.
- Each group has its own hysteresis state, held in the ledger.
- A `threshold.crossed` event is appended once per crossing, and only when `n ≥ minSamples`.

**Value builders.** `lane.unit(create)` and `lane.event(key, name, payload)` are typed value builders.

### Halts and gates

- `flow.halt(key, decision, { ask })` blocks the attempt until a human resolves the decision.
- Skips are lane relationships: `handler(flow, { skips: { approval: { name, when, decision } } })`.
  - `when` receives `GateContext<A>`.
  - A skip records `step.recorded` with status `skipped`.
- Metrics over a decision count only human `halt.resolved` facts. Skipped decisions are never samples.

### Metrics

- `H.metric(name).of(x).hit(test)` takes a lane (transitions), a decision (human resolutions), or an executable (its invocation outputs).
- `.invocations(sorts?)` measures over invocations of the given executable sorts (all sorts if omitted). For example, the model error rate is `invocations(['agent'])`. Invocations of other sorts are not samples.
- Every rate is returned as `{ rate, hits, n, window }`.
- Windows are `Duration`s.
- `count` and `pausedMs` answer "Audits opened per category this month" and "how long the lane was paused".
- Every metric read inside a policy is recorded in `policy.decided`.

### Suspension, capacity, scheduler

- A blocked or suspended attempt releases its runner slot and account. It keeps lane WIP.
- Waiting-position units hold nothing.
- The schedule policy:
  - orders the candidates;
  - may name running attempts to preempt;
  - never starts work in a paused lane.
- Admission is subject to WIP, runner slots, preflight, account eligibility, and the per-unit budget.

### Restart (scenario 10)

**On restart**, for each open attempt, the kernel replays recorded step outputs. For a step with `step.started` but no `step.recorded`, it applies the step's `restart` rule:

| Rule | Behaviour |
|---|---|
| `rerun` | runs the step again |
| `park` (the default for commands and externals) | blocks the attempt with reason `restart` |
| `{ probe }` | runs a probe command given the invocation id; `done: true` continues, otherwise the attempt is parked |
| `ask` (the default for agents) | calls `Driver.settled` / `External.settled` |

**Batches.** `batch.submitted` lets a batch be collected, never resubmitted.

**State that moved while the harness was down.**
- Halts resolved meanwhile, through a client served by `harness.control()` (no writer claim, writes only through `Ledger.submit`), are found in the ledger.
- Child terminal transitions are read from the ledger.

**Identity and metrics.** A resumed attempt keeps its id. An interrupted invocation is recorded as `interrupted` and excluded from every rate.

**Changed definitions.** Each step carries a fingerprint. If the prefix up to the running step no longer matches, the attempt is parked with reason `definition`. `manageAttempts` lets the supervisor restart it from the top or abandon it.

**Single writer.** `Ledger.claim` grants one fenced writer lease per harness. A second process is refused while the lease is live, or takes over a dead holder's lease with a higher token. Appends carrying a stale token are rejected.

### Accounts and quota

- Account state is a partition of the ledger: `Ledger.quota`.
- The ledger backend decides where that partition lives. `sqlite.ledger(path, { accounts: sqlite.accounts(sharedPath) })` places it in a shared file.
- Accounts carry no state.
- Eligibility is read at every decision and never cached.

### Memory

- Reads union every journal named; writes go to exactly one.
- Recall policies order and cut pre-scored candidates.
- Trigger writes into curated kinds enter as candidates.
- Curation is `curateMemory`.

### Control API

- Operations are built-ins or custom, granted through an access.
- Transport is the client adapter: MCP through a coding-agent session, or plain HTTP.

### Startup validation

`start()` fails on any of:
- duplicate names;
- an unmapped or foreign label;
- `.sets` keys that are fields;
- a reaction state outside the kind;
- a flow event the kind lacks;
- an unregistered lane in `unit()` / `event()` / `pauses()`;
- a terminal state without a verdict;
- a kind with more than one active state;
- `restart: 'ask'` on an executable with no `settled`;
- a batch on a model that cannot batch;
- an agent without a model or pool.

## What changed and why

**Skeleton (principle 12 as amended).**
- `concluded` is gone. States declare a position, and terminal states declare a verdict.
- Attempts have exactly three outcomes.

**Inference sites removed.**
- `H.policy.model` is non-generic.
- Metrics address entities, not flow step keys.
- Adapter map callbacks return `NoInfer<Supply>`.
- Spawn targets are lane config entries.
- Skips carry `GateContext<A>`.
- `flow.events` are typed.
- `http.webhook` takes a body schema.

**Critique fixes.**
- Skips are not samples.
- `stateBefore`.
- Verdicts are the author's.
- One word for events.
- Quota ownership: the ledger's partition only.

**Additions for scenarios 9 and 10.**
- Thresholds.
- Lane pause and resume.
- Attribute-timer re-arming.
- `count` and `pausedMs`.
- Restart rules, probes and driver `settled`.
- `batch.submitted`.
- Fingerprints.
- `manageAttempts`.
- Writer leases and `harness.control()`.

**Removed.** `H.policy.gate`, `H.child`, `H.move`, `SupplyOf`, `Account.quota`, and `signalWork`.

**Writing scenarios 6–10.**
- `H.metric(name).invocations(sorts?)`.
  - Scenario 9's pause trigger needs "the model error rate over the last hour with at least 20 invocations".
  - Unfiltered, the command and external invocations in the same harness (the reply sender, the fact-check command) became samples, which dilutes the rate and inflates `n`.
  - That breaks principle 18 (honest sample counts).
  - The filter is an argument, not a new entity. The kernel's `MetricSpec.test` already returns `null` for non-samples, so `kernel.d.ts` is unchanged.
- **The active state on attempt start is now defined.**
  - Scenarios 6, 8 and 10 declare `Reviewing` / `Composing` / `Releasing` states with position `active`, and the parent never said when a unit enters one.
  - Now: an attempt opening moves the unit into the kind's one active state.
  - A second active state is a startup error, since the kernel could not choose between them.

## Principles broken

none.
