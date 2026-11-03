# harness-dsl, OTP seed

A harness is a supervision tree. Its long-lived children are the ledger, suppliers, lanes, the scheduler, clients and observers. Around them run short-lived processes, the attempts.

- Units are registered, addressable state machines with mailboxes.
- Policies are pure functions over a metrics snapshot.

TypeScript 5.4+ is required, because `NoInfer` keeps kinds, not state literals, as the inference site.

## Vocabulary

The owner's words are kept: work, kind, unit, attempt, lane, trigger, journal. Two lens words are adopted because they are better than the alternatives:

- **receive** replaces any "on message" or "handle". A lane receives messages for its units.
- **exit reason** replaces "flow transitions to state". A flow ends with a reason, and the lane maps reasons to states.

"Process", "GenServer" and "Registry" stay out of the API. They describe the runtime, not the model.

### Execution levels

| word | definition |
|---|---|
| run | One boot of a harness process. It starts and stops in the ledger. Restarts create new runs, not new attempts. |
| attempt | One execution of a lane's handler flow for one unit. It is a temporary, linked process: it crashes alone and the unit survives. Status is running, blocked, exited, crashed or cancelled. |
| step | One named node of a flow: call, fanout, halt, spawn, when, repeat. A step can execute many times inside a repeat; each execution is a `round`. |
| invocation | One call of an executable inside a step. A fanout of 20 is 20 invocations, and a retry is another invocation. Cost, model, account and runner attach here. |

## Entities

### Kinds: pure vocabulary, no backend

| builder | is |
|---|---|
| `H.state(name, outcome)` | A named state refining a skeleton outcome. Shareable between kinds. |
| `H.work(name, schema).states(...).key(fn)` | A work kind. The key is its registry identity: `(kind, key)` addresses a live unit. |
| `H.message(name, schema)` | A mailbox message kind. `H.down` is the built-in child-exit message. |
| `H.role(name).intents(...).instructions().skills()` | A role. Intents (read, edit, execute, search, browse, halt) are mapped to tools by the driver. |
| `H.resource(name)` | A resource. Leases and memory scope name resources, not paths. |
| `H.memory.experience(name)`, `H.memory.taste(name)`, `.curated()` | Memory kinds. With `.curated()`, items enter as candidates. |

### Instances: carry their backend, adapters only

Instances live in adapters:

- accounts (`claude-code.subscription`, `anthropic.apiKey`, each with `.quotaIn(store)`);
- models;
- runners (`local`, `ssh`, `git.worktrees`, each with `.slots(n)` and `.preflight(cmd)`);
- suppliers and stores;
- memory stores;
- the ledger;
- account-state stores;
- clients;
- observers.

`H.command(name).run(argv)` is the one instance in `H.*`. An argv is not a backend; where it runs is decided by the step's runner.

### Pivots: each produces a named thing

| pivot | from | produces |
|---|---|---|
| `H.pool` | accounts × share × order policy × fallback | an account choice per invocation |
| `H.agent` | role × model (or model policy) × pool × journals × guards | an executable |
| `H.journal` | memory kind × store × recall policy | recalled items and a write destination |
| `H.flow` | steps | a handler with exit reasons and step names |
| `H.lane` | kind × suppliers × store × handler(params) × exits/phases × receive × deadline × ceiling | a supervised subtree that turns arrivals into attempts |
| `H.trigger` | source × consequence function | recorded firings |
| `H.scheduler` | order policy × WIP limits | the next attempt to start |
| `H.grant` | operations | what a client may do |
| `H.metric` | selector ratio | an owner-defined rate with samples |
| `H.harness` | ledger × lanes × triggers × scheduler × clients × observers | a running tree |

Pools, agents and journals are discovered transitively from lanes and triggers. Only roots are registered on the harness.

## Rules

### Supervision

The harness root supervises its children one_for_one: the ledger, the scheduler, each lane, each trigger, each client and each observer. Restart intensity is set by `.restart()`.

Each lane is itself a supervisor:

- one_for_one over its suppliers;
- simple_one_for_one over attempts, which are temporary.

A crashing supplier is restarted by its lane, and the lane's attempts continue. A crashing attempt maps to the lane's `crashed` exit, which is a required key in `.exits()`. The unit lives on. "Let it crash" is the default `onFailure` of every step.

### Lifecycle

States declare outcomes, and the initial state is the kind's first pending state. Flows never name states. They declare `.exits(...)` and end with `.exit(...)` or `.exitWhen(...)`.

The lane maps every reason, plus `crashed`, to a kind state. It may also map step names to states with `.phases()`. One flow therefore serves Bug and Feature, with `params` carrying the round count.

### Capacity

Capacity is held by attempts, not units. An active unit with no running attempt is idle and occupies no slot.

A blocked attempt keeps its unit active and releases its runner slot. It holds only its leases.

### Mailbox

`.receive(message, (payload, unit) => reaction)` decides what a message means in the unit's current state. A reaction is plain data: `{ cancel?, to?, update?, start? }`.

- **Cancellation** is a reaction with `cancel: true`.
- **`start: true`** asks the scheduler for a new attempt from the top of the flow.
- **`H.down`** delivers child exits to units that spawned them. Its payload carries `remaining`, `succeeded` and `failed`.

`spawn` ends nothing by itself. The flow exits right after, so the parent holds no slot while its children run.

### Registry and supply

A supplier yields arrivals of two shapes:

- `{ create: data }`, which makes a unit;
- `H.deliver(message, key, payload)`, which routes a message to the live unit `(kind, key)`.

A delivery to a key with no live unit is recorded and dropped. A `create` whose key is already live is idempotent: it is recorded as a duplicate and ignored. This is what lets a poll back up a webhook.

`H.supply.schedule(kind, cadence)` either creates units or sends messages to existing ones. Reopening a terminal unit creates a fresh unit under a new key, because a terminal state stays terminal.

### Back-pressure

- Poll suppliers implement `pull(demand)`.
- Push suppliers call `offer()`, which returns false when the lane's bounded buffer is full.

Demand flows from the scheduler: free slots and WIP headroom.

### Runners

A lane names a default runner. A step may override it with `on: runner` or `on: ctx => runner`. The function form picks a runner per unit, for example the host a database lives on.

A runner's `.slots(n)` is its concurrency, and `.preflight(cmd)` runs before every acquisition.

### Scheduler

`order` is a policy from `{ pending, running }` to an ordered candidate list, and omitted candidates are deferred this tick. The kernel starts the first feasible candidate given three limits:

- runner slots;
- lane WIP;
- account eligibility, read fresh from account state at start time.

Lane `.deadline(fn)` populates `Candidate.deadline`. Preemption is ordering plus deferral: the kernel never kills a running attempt for priority. Daily budget is read through `metrics.spentUsd` and `meanCostUsd`.

### Triggers

A trigger is written `H.trigger(name).on(source).do(event => consequence | consequence[] | undefined)`.

Sources:

- `H.on.enter(kind, states)`: a transition;
- `H.on.streak(kind, { state, count, by })`: a run of consecutive terminal states within a group;
- `H.on.deadline(lane, { while })`: time.

Sources fire only from ledger events. A deadline becomes a recorded `timer.elapsed` event before it can fire.

Consequences:

- `create`, which makes a unit in a lane;
- `send`, which delivers a message;
- `react`, which cancels or transitions a unit from outside;
- `record`, which captures memory;
- `run`, which runs an executable.

### Memory

Items are forward-phrased: `do`, `when`, `because`. The kernel owns the envelope:

- `id` and `created`;
- the `when` scope: kinds, roles, resources, skills, labels;
- `status`;
- `source`.

Recall is `Policy<RecallInput, RecallPlan>`: a pure function returning a plan, which the store executes. `similar()` is an optional capability of a memory store, so similarity is a backend feature.

Writes go to exactly one journal, through one of four paths:

- an agent's `.record(journal)`;
- a flow's `.record(journal, fn)`;
- a trigger's `H.do.record`;
- the `writeMemory` operation.

Reads union the journals an agent `.recall`s. Curation (accept, merge, drop) is the `curateMemory` operation.

### Metrics

Every rate is `{ rate, hits, samples }`, and `rate` is null when samples are 0.

- **`successRate`** = succeeded / (succeeded + failed), over units of the kind that reached a terminal state in the window. Cancelled and concluded units are excluded from both terms.
- **`endedIn(kind, state)`** = units ending in that state / all terminal units of the kind.
- **Owner metrics** (`H.metric(name, { count, of })`) count selected step results, halt decisions or state entries.

A slice narrows any metric:

- **`labels`** selects units carrying those labels.
- **`model`** selects attempts in which that model served an invocation.
- **`agent`** (an agent name) selects attempts in which that agent ran.
- **`agent` and `model` together** select attempts in which that agent ran on that model.

This is how a step result or an editor's decision, which has no model of its own, is credited to the model that produced the work it judges.

### Halts and restart survival

A halt step blocks the attempt and records `attempt.blocked`.

- `unless: { policy, assume }` lets a policy skip the halt. A skipped halt is recorded as an assumed decision by `policy`. Decision selectors count only decisions made by a client, so auto-approvals never inflate the approval metric that grants them.
- `onFailure: { halt }` turns a step failure into a blocker, resolved by retry or crash.

The ledger is event-sourced at step granularity. After a restart, open attempts are replayed from `step.ended` outputs, so a blocked attempt is blocked again at the same step. Retry is `retry: { max, initialSeconds, factor }` on the step.

### Cost ceilings

Lane `.costCeiling({ maxUsd, onBreach })` sums invocation cost per unit across attempts. When the next invocation's estimate would pass the ceiling, the kernel halts or crashes before spending.

### Accounts

An account's quota window is the account's own state, kept in an `AccountState` backend named by `.quotaIn()`. The default is the ledger backend.

Two harnesses sharing accounts point `.quotaIn()` at the same `sqlite.accountState(path)`:

- reservations are compare-and-set;
- `watch()` streams changes, so B sees a cooldown caused by A on its next eligibility check.

Share caps live on the pool, which is per harness.

### Control

The control API is a set of operations:

- built-ins live in `H.op`;
- custom operations come from `H.operation`;
- a grant lists operations, and a client is constructed from a grant.

Clients are transports: `claude-code.supervisor({ grant })` in-process, or `http.server({ grant, port })`. A remote supervisor session takes `{ endpoints }`.

Observers are children that receive every ledger event plus a read-only view.

### Startup validation

`start()` validates the tree and refuses to start on any `StartupProblem`:

- duplicate names;
- states outside the kind;
- unmapped exits or unknown phases;
- two lanes for one kind;
- a spawn of a kind with no lane;
- a trigger on an unregistered lane;
- an agent without a model or pool;
- a kind without a pending state.

## Non-obvious choices taken

1. **A sixth outcome, `concluded`.** It covers verdicts and endings that are neither success nor failure.
2. **Flows end with exit reasons, and lanes map them.**
3. **Deadline is a lane setting.** It serves scheduler ordering and the time-trigger source.
4. **Trigger consequences are a function of the event.**
5. **Capacity belongs to attempts.** Perpetual units need no special lifecycle.
6. **Account state is owned by the account instance.**
7. **Spawn plus `H.down`** replaces `await: true`.
8. **Recall policies return plans.**
9. **Owner metrics are credited to models through slices,** not through labels the flow cannot know.

## What changed and why

Versus the brief:

- The supervision tree is real. Attempts are temporary children, and suppliers restart under their lane.
- gen_statem is states + mailbox reactions + phases.
- The mailbox is `receive`, and cancellation is a reaction.
- The registry is the kind key plus `H.deliver`.
- Back-pressure is `pull(demand)` or a bounded `offer()`.
- Monitors are automatic for spawned children.

Seed weaknesses addressed:

- Intents replace tool names, and resources are entities.
- Triggers cover transitions, patterns and time.
- External cancellation, deadlines and per-unit ceilings are designed.
- Shared account state has a home.
- Execution words are defined, and capture is a trigger consequence.
- The lane supplies a flow's input type by contravariance.
- Startup validation is specified.

### Scenario pass (revision 2)

Writing the eight scenarios exposed three gaps in the surface and two unstated rules.

1. **`WorkKind.states` takes a rest tuple.** It was `states<S2 extends State>(...states: S2[])`. That asks TypeScript for a common supertype of `State<'todo','pending'>` and `State<'done','succeeded'>`, which does not exist, so every multi-state kind failed to compile. It is now `states<T extends readonly State[]>(...states: T): WorkKind<N, D, T[number]>`, which infers the union.
2. **Step `on` accepts `(ctx) => Runner`.** Scenario 4 runs each backup on the host its database lives on. One lane per host would violate "one lane per kind", and two `when` branches with duplicate steps would split metrics by step name. Choosing the runner per unit is the honest shape.
3. **`Slice.agent` is an agent name (`string`), not an `Agent`.** Scenario 6's model-choice policy is installed on the very agents whose track record it reads. With object references, the policy and the agent reference each other in their initializers. `ModelChoice.agent` was already a name, and `MetricSlice.agent` in the kernel already was one, so the declaration now agrees with both. Startup validation rejects unknown agent names.
4. **Slice semantics are defined (rule, no type change).** A model or agent slice selects attempts, so an owner metric over decisions or command steps (citation-check pass rate, editor acted on critique) is credited to the model that produced the judged work.
5. **Assumed decisions and duplicate creates are defined (rules, no type change).**
   - An auto-skipped halt records an assumed decision that decision selectors do not count, which keeps scenario 2's safe-category rule from feeding itself.
   - A `create` for a live key is an idempotent no-op, which is what makes scenario 2's poll a safety net for the webhook.

Scenario 7 must import shared entities from a shared module, but scenario files may import only from `harness-dsl`, `harness-dsl/*` and `zod`. Its shared definitions therefore sit at the top of the one file and both harnesses read them. In a real repository that block is a module both harness files import, and nothing in the descriptors changes.

## Principles broken

- **12. Lifecycle skeleton.** The skeleton has six outcomes: `concluded` is terminal and is neither success nor failure.
  - **Success rate afterwards:** succeeded / (succeeded + failed). Concluded and cancelled are excluded from both terms and are reported through `endedIn` with their own sample counts.
  - **Scheduler:** concluded is terminal like the others.
- **15. The ledger is the kernel's only state.** Partially broken. Account quota windows belong to the account instance's `AccountState` backend, because they span harnesses that must not share ledgers. The default ledger implements `AccountState`, so a single-harness setup still has one store.
