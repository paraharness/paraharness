# harness-dsl: supervision-tree seed (otp)

A harness is a supervision tree whose leaves are units of work. Each unit is a state machine (gen_statem) registered by kind and key. It has a mailbox. Attempts are temporary processes that may crash without harming the unit. Suppliers are producers with demand, and the scheduler pulls. All of it is described by immutable descriptors built through `H.*`. All backends come from subpaths.

## Execution vocabulary (one word each)

- **Run**: one lifetime of a harness process, from `start()` to `stop()`. Recorded as `run.started` / `run.stopped`.
- **Attempt**: one execution of a flow for one unit while it sits in a runnable state. It is the "let it crash" process. It ends `exited`, `crashed`, `cancelled` or `preempted`. The unit survives every attempt.
- **Step**: a named, durable point inside an attempt (`ctx.run`, `try`, `batch`, `decide`, `halt`, `spawn`, `children`). Its result is written as `step.recorded`. On restart, the flow is replayed, and recorded steps return their recorded result instead of executing again. This is how a blocked attempt survives a process restart (scenario 5). Flows must therefore be deterministic between steps.
- **Invocation**: one execution of an executable inside a step. Retries make several invocations per step. A batch makes one invocation per input.

## Entities

### Kinds (vocabulary, no backend)

| Entity | Builder | Notes |
|---|---|---|
| State | `H.state(name, outcome)` | Shareable across kinds. Outcome is one of `runnable`, `waiting`, `succeeded`, `failed`, `cancelled`, `ended`. |
| Work kind | `H.kind(name, { data, key })` | Data schema plus registry key. Methods: `.states([...], { initial })`, `.messages({...})`, `.timeout(states, timer, event)`, `.on(event, { from, to, attempt, guard, update })`. This is the gen_statem. Events, per-state timeouts and the transition table live on the kind because they are vocabulary. Who supplies, stores or handles the kind does not live here. |
| Role | `H.role(name, { prompt, intents, input, output })` | Intents (`read`, `edit`, `execute`, `search`, `browse`, `ask`) are mapped to tools by the driver. No tool names appear. |
| Memory kind | `H.memory(name, { authority })` | `observed` = experience (fallible, can be stale, deduped). `owner` = taste (never wrong). |
| Resource | `H.resource(name)`, `.key(k)` | Names files, services, databases and sections. Used by memory scope and by leases. |

Every kind receives two built-in messages:
- `cancel`: cancellation is a message.
- `down`: a monitored child terminated. The payload is its `UnitStatus`.

Timeouts add their own event names to the kind's message map. So `.on('slaBreached', ...)` type-checks only after `.timeout(..., 'slaBreached')`.

### Instances (carry their backend; only from subpaths)

Instances are: Account (`claudeCode.subscription`, `claudeCode.apiKey`, `anthropic.apiKey`), Model (`claudeCode.model`, `anthropic.model`), Runner (`shell.local`, `ssh.host`), Workspace (`git.worktree`), Store, MemoryStore, Ledger, Meter, Transport, Observer and Embedder.

`H.command` and `H.agent` are executables. They become runnable only when they reference instances (a runner, or a model and pool).

### Pivots (each names what it produces)

| Pivot | Produces | Connects |
|---|---|---|
| `H.pool` | an account choice | accounts × shares × order policy × fallback |
| `H.agent` | a model executable | role × model-or-choice × pool × journals × workspace × guards |
| `H.lane` | a supervised work line | kind × suppliers × store × handlers × limits × resources |
| `H.journal` | recalled memory | memory kind × memory store × recall policy |
| `H.trigger` | a recorded consequence | source × consequence |
| `H.client` | a control surface | transport × granted operations |
| `H.choose` | a model for an invocation | candidate models × deterministic pick |
| `H.metric` | a rate with samples | kind × owner-defined sample function × group |
| `H.scheduler` | an ordered plan | pending and active views × policy |
| `H.harness` | the supervision tree root | everything above |

`H.feed(producer)` wraps a backend producer. `.to(kind, map)` turns a feed into a **supplier** for a kind. A mapper may `create` a unit or `send` a message to an existing unit by key (registry lookup). So one webhook can open Conversations and update Negotiations.

## Rules

### Skeleton (changed, see principles broken)

Unit outcomes: `pending`, `active`, `waiting`, `succeeded`, `failed`, `cancelled`, `ended`.

- A unit in a `runnable` state is **pending** until the scheduler starts an attempt. It is **active** while the attempt lives.
- A unit in a `waiting` state has no attempt and holds **no capacity**: no WIP, no slot, no account. It waits for a message or a timer. Tenancies, negotiations awaiting the vendor, experiments between measurements and epics awaiting children sit here.
- `ended` is terminal and neither success nor failure. Examples: parked, inconclusive, churned, walked away, expired.
- **Blocked** is an attempt state: a pending `halt` or a driver `ask`. A blocked attempt keeps its lane WIP slot but releases runner slots and accounts.
- **Success rate** = succeeded / (succeeded + failed), over units that reached a terminal state in the window.
  - Cancelled and ended units are excluded from the denominator.
  - They are always reported beside it (`Outcomes.byState`, `bySkeleton`, `samples`).
  - Questions like "how often are experiments inconclusive" read `outcomes(...).byState`.

### Flows are coupled to exits, not states (weakness 1)

`H.flow(name, { input, params, writes, exits }, run)` returns named exits. The lane maps exits to the kind's states, per runnable state: `lane.handle(Building, ticketFlow, { params: { rounds: 3 }, exits: { done: Done, abandoned: Abandoned } })`.

- A flow's `input` is the minimum data it needs. The lane checks that the kind's data is assignable to it (contravariance), so the lane supplies the type (weakness 11).
- `writes` is the patch a flow may return with its exit. The lane checks it is a partial of the kind's data.
- `params` let one flow serve Bug (3 rounds) and Feature (5).

A crashed attempt (uncaught error) is retried per `crash: { retries, then }`. When retries are exhausted, the unit moves to `then`. Without `crash`, the unit stays runnable and is re-queued.

### Mailbox and registry

Every unit is addressable by `(kind, key)`. Messages arrive from four places: suppliers (`unit.send`), the control API (`writeWork`), timers, and child `down` notices. The kind's transition table decides what each message means in the current state.

- `attempt: 'cancel'` cancels the running attempt (external cancellation, scenario 2).
- `attempt: 'keep'` leaves the attempt running. The flow can read the message via `ctx.received(event, schema)`.
- Messages with no matching rule are recorded and dropped.
- A send to an unknown key is recorded and dropped.
- A `create` for a key already registered is recorded and dropped.

### Timers

Per-state timeouts are declared on the kind. Timers are armed on state entry and cancelled on exit. They are persisted in the ledger (`timer.armed`, `timer.fired`), so they survive restarts. A fired timer is a message, so time-sourced triggers fire only from recorded events. `H.time.deadline(data => Date)` reads a per-unit deadline (SLA). The scheduler sees the nearest armed timeout as `nextTimeoutAt`.

### Monitors (weakness 2)

`ctx.spawn(step, lane, data[])` registers children linked to the current unit. The parent's attempt then exits, typically into a `waiting` state.

- Each child termination delivers `down` to the parent.
- The parent's rule moves it back to a runnable state.
- A new attempt calls `ctx.children(step)` to decide.

An Epic has several short attempts, never a held slot.

### Triggers

Sources:
- `H.when.entered(kind, states)`
- `H.when.event(kind, event)`: messages, including timeouts
- `H.when.streak(kind, state, n, { by })`: n consecutive terminal units of one group ending in that state
- `H.when.decided(kind, step, schema)`: a halt resolution

`.where(...)` filters. Consequences are `.create(lane, ...)` and `.note(journal, ...)`. Firings are recorded as `trigger.fired` with the source sequence number. A source sequence fires each trigger at most once.

### Memory

The kernel envelope holds:
- id and created
- status: `candidate` | `active`
- `when`: kinds, roles, skills, resources
- body `{ do, condition, because }`, forward-phrased

Writing and reading:
- Agents `.recall(...)` a union across journals and `.record(journal)` into exactly one.
- Commands `.record(journal, extract)`.
- Triggers `.note(...)`.
- The supervisor writes and curates (`accept`, `merge`, `drop`).

Reads union and writes need one destination. This asymmetry is in the DSL signatures.

Recall is deterministic:
1. Filter by scope overlap with the invocation (unit kind, role, lane resources).
2. Rank by specificity or by store similarity.
3. Then rank by track record: the share of invocations citing the item that belonged to succeeded attempts (`invocation.ended.memoryIds`).

A similarity backend is still deterministic given the same index.

### Accounts and quota

Account window state lives behind a **Meter**, a backend of the account instance. By default, the kernel meters through its own ledger.

To share accounts across harnesses, give each account `sqlite.meter(sharedPath)`. `reserve` is atomic across processes and enforces this harness's share cap. A cooldown set by harness A is seen by harness B on its next reservation. Runs, attempts and invocations stay in each harness's own ledger.

An account's driver must match the driver of the models it serves. A Claude Code subscription pool falls back to a Claude Code API-key account (`claudeCode.apiKey`), not to a raw API account of another driver.

### Cost

`lane.limit({ maxUsdPerUnit })` sets a per-unit cost ceiling. Before each invocation, the kernel adds the driver's estimate to the unit's recorded spend across all attempts. If the total would exceed the ceiling, the attempt blocks (a kernel halt) for a human. Batch invocations are priced with the model's `batchDiscount`.

### Scheduler and back-pressure

Suppliers are producers. They emit only up to `demand()`, which is the lane's `queue` limit minus its pending units. Push feeds (webhooks) reject beyond demand.

The scheduler policy returns an order and optional preemptions. The kernel walks the order and starts what fits: lane WIP, runner slots (and preflight), and account eligibility. Preempted attempts end `preempted`, and their units return to pending.

### Supervision

The harness root is one-for-one, with restart intensity set by `restart({ maxRestarts, withinSeconds })`. Its children are each supplier, each lane, the scheduler, each client and each observer.

- A crashing supplier restarts alone (`child.restarted`).
- Exceeding the restart intensity stops the run.
- Attempts are temporary. The tree never restarts them; only the lane's crash rule re-queues them.

### Startup validation (weakness 16)

`start()` refuses:
- two descriptors with one name
- transitions, exits or timeouts naming states not in the kind
- `handle` on a non-runnable state
- runnable states with no handler
- triggers or spawns targeting unregistered lanes
- agents without a model
- choices or pools mixing drivers an agent cannot use
- journals without a store
- clients granting operations whose dependencies are missing

### Human in the loop

`ctx.halt` blocks the attempt with a typed decision schema. Resolution comes only through the control API, with `resolveBlockers` granted. The supervisor is one client; plain HTTP is another (`http.server`). Grants are operations (`H.ops.*` or `H.operation(name, executable)`).

## Vocabulary kept

These owner words are kept: work, unit, kind, attempt, lane, trigger, journal, supervisor.

- The lens suggested "process" for unit. "Unit" is clearer to non-Erlang readers.
- The lens suggested "registry" for lane. The registry is a property of the kernel, not an entity.
- "Monitor" and "down" are kept from OTP because they name exactly the parent/child relation.
- "Feed" is a backend producer before it is bound to a kind. "Supplier" is the bound pivot.

## What changed and why

Versus the brief's seed:

- Unit lifecycles are gen_statem tables on kinds: messages, per-state timeouts and rules (`attempt: 'cancel' | 'keep'`, `update`, `guard`). This answers external cancellation, SLAs, approval expiry and supplier updates without new entities.
- Flows return exits, and lanes map exits to states (weakness 1). The lane provides the input type (11).
- Spawn ends the attempt, and children send `down` (2).
- Roles declare intents, not tools (3). Resources are entities (4).
- Triggers have four sources, including time via timer messages and patterns via streaks (5). External cancellation and preemption are designed (6). Deadlines and per-unit cost ceilings exist (7).
- Account state moved behind a Meter (8).
- Triggers can note memory candidates (9).
- Execution vocabulary is defined (10).
- The memory read/write asymmetry is in signatures (12).
- Waiting and ended outcomes cover perpetual and multi-outcome units (13).
- Observers are a kernel interface from adapters (14).
- Transport is explicit on clients (15).
- Startup validation is specified (16).
- Durable steps with replay give restart survival.

Changes from writing the scenario battery:

- **`claudeCode.apiKey` added (scenario 1).** The coding team's pool falls back from three subscriptions to an API account. The only API account in the surface was `anthropic.apiKey`, whose driver differs from the Claude Code models the builder uses. Startup validation refuses pools that mix drivers, so the scenario would have compiled and then refused to start. The Claude Code adapter now offers an API-key account on its own driver. The kernel is unchanged.
- **Duplicate `create` is specified.** A poll that re-reads records already registered (scenarios 2, 6) produces creates for existing keys. These are recorded and dropped, like sends to unknown keys. This was implicit in "registry by key" and is now a stated rule.
- **Scenario 7's shared module is expressed in one file.** Scenario files may import only `harness-dsl*` and `zod`. The shared accounts, meter and taste journal are therefore one set of constants used by both harness descriptors in the same file. Descriptors are immutable and stateless, so sharing a constant and importing it are equivalent.

## Principles broken

- **12 (five outcomes).** The skeleton has seven. It adds `waiting` (a non-terminal unit holding no capacity) and `ended` (terminal, neither success nor failure). Without them, tenancies and negotiations either hold capacity or lie as pending, and parked or inconclusive outcomes lie as failed or succeeded. Success rate after the change is defined above: succeeded / (succeeded + failed), with cancelled and ended counted beside it and never hidden.
- **15 (ledger is the only state).** Account quota windows live in a Meter. The Meter is a backend of the account instance rather than of the ledger, because two harnesses with two ledgers must share it (scenario 7). The default meter is ledger-backed, so a single harness still has one state store.
- **11 (nothing read at definition time) is kept**, but flows are code that is replayed. Determinism between steps is an authoring rule. The kernel can detect a violation (a replay that diverges from recorded steps crashes the attempt) but cannot prevent one.
