# harness-dsl, durable lens (seed)

A unit of work is a durable execution. Its identity outlives processes, attempts are continuations of it, and suspending is the normal way an attempt ends. The ledger is the event history the engine replays. Everything below is in the harness's own words. **Signal** is kept because nothing in the owner's vocabulary names "an event addressed to one existing unit". **Flow** replaces "workflow". **Step** replaces "activity".

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind. It has a stable id and a `key` (the external identity given by `Kind.key`, used to route signals). It lives from creation to a terminal state and possibly beyond, because a signal may reopen it.
- **Attempt**: one continuation of a unit's flow. An attempt starts at a step (the first step, a `restart` step, or the resume point after a suspension) and ends in one of four ways:
  - *exited*: the flow reached an exit.
  - *suspended*: the flow reached `await`, `wait` or `spawn`.
  - *failed*: a step failed after its retries.
  - *cancelled*.

  While open, an attempt is `running` (holds a slot) or `blocked` (halted on a decision, holds nothing).
- **Step**: a named node of a flow. Steps are `step`, `halt`, `await`, `wait`, `spawn`, `loop` and `exit`. Step outputs are recorded and form the replay state.
- **Invocation**: one call of an executable (a command or a model call) within a step. A retry is a new invocation of the same step. Cost, tokens, model, account and runner are recorded per invocation.

The word "run" is not used. A process start is not a ledger concept.

## Entities

**Kinds** (pure vocabulary, no backend):

| Entity | Defined by |
|---|---|
| Work kind | `H.kind`, with `.attributes(zod)` (typed, indexed fields), `.states(...)` and `.key(fn)` |
| State | `H.state(name, outcome)` |
| Signal | `H.signal(name).payload(zod)` |
| Role | `H.role(name)`, with `.intents(...)` (driver-neutral: read, edit, run, search, browse, halt, record) |
| Memory kind | `H.memory(name)`, with `.body(zod)` and `.trust('experience' \| 'taste')` |
| Command | `H.command`: argv over typed input, optional output schema |
| Flow | `H.flow` |
| Operation | `H.operation` |

**Instances** (carry a backend, built only in subpaths):

- Account
- Model (bound to a pool)
- Runner (with `.slots` and `.preflight`)
- Workspace
- Supplier
- Store
- MemoryStore
- Ledger
- AccountLedger
- Client
- Observer

`H.clock` and `H.operator` are kernel suppliers, because time and the control API are kernel.

**Pivots** (each names what it produces):

| Pivot | Combines | Produces |
|---|---|---|
| **Lane** | kind × suppliers × store × flow, plus params and the exit→state map | managed units |
| **Agent** | role × model or model policy | a model-call executable |
| **Pool** | accounts × share caps × drain policy | quota-eligible access |
| **Journal** | memory kind × memory store × recall × reader/writer roles | recalled memory |
| **Trigger** | source → consequences | recorded firings |
| **Metric** | source → samples | a rate with sample counts |
| **Budget** | spend cap × window × lanes | remaining spend |
| **Scheduler** | priority, WIP, aging, rank, admission | start decisions |
| **Harness** | all of the above, plus ledger, clients and observers | a running harness |

## Rules

### Flows

1. **Flows are typed by the unit's attributes and know no states.** A flow declares the minimum attribute shape it needs (`.input`) and its own params (`.params`). It ends at named **exits**. The lane maps those exits to the kind's states with `handler(flow, { params, exits, during, failure })`. The `exits` map is a total mapped type, so a missing mapping is a compile error. `during` maps step names to non-terminal states (classifying, drafting, awaiting approval). One flow can therefore serve Bug (rounds 3) and Feature (rounds 5) through two lanes, and a flow never names a kind's states (known weakness 1).
2. **Exits may map to non-terminal states.** A tenancy's `reviewed` exit maps to `Active`. The unit then has no attempt and holds no capacity until a signal restarts it.

### Suspension, signals and timers

3. **Suspension is the normal case.** `await(signal)`, `wait({ms} | {until})` and `spawn(lane, children)` end the attempt and record why the unit waits.
   - The next attempt starts when the signal arrives, the timer fires or all children are terminal.
   - Spawn records `parentId`. Its output is the children's terminal states (weakness 2).
   - `halt` keeps the attempt open in `blocked`, without a slot, until the decision arrives through the control API. The decision is typed by the halt's zod schema.
   - `skip` returns an automatic decision, which is recorded as a decision event. Scenario 2's safe category uses this.
4. **Signals.** A supplier route may `create` a unit or `signal` one by key or by predicate. `Lane.on(signal, { update, restart, enter })` reacts in three possible ways:
   - `update` merges the payload into attributes.
   - `restart` cancels the open attempt, if there is one, and starts a new attempt at that step.
   - `enter` transitions the unit, and may reopen a terminal one. Each terminal entry counts in metrics.

   Without a reaction, signals are buffered for `await`. `H.cancel` is the built-in signal for cancellation. By default it cancels the open attempt and moves the unit to the kind's first `cancelled` state. External cancellation, operator cancellation and timer cancellation are all the same mechanism (weakness 6).
5. **Timers.** The engine owns the clock. Timers are persisted as ledger events (`timerSet`/`timerFired`), so they survive restarts. There are three sources of time:
   - `wait` steps.
   - `H.when.timer(lane, { at, if })` trigger sources (SLA breach, the 09:00 cancellation, negotiation expiry).
   - `H.clock` suppliers.

   `H.nextTime` is a pure date helper.

### Steps and determinism

6. **Retry and timeout are step declarations** (`{ retry: H.retry(...), timeoutMs }`). The engine retries, and each retry is a new invocation. A failure after retries fails the attempt, and the lane's `failure` state applies.
7. **Determinism and replay.** Every value a flow branches on is recorded once as a `decision` event and read back on replay:
   - `exit` predicates, `loop` bounds and `halt.skip`;
   - model and account policy choices;
   - scheduler admissions.

   `Metrics` is synchronous: policies read a snapshot taken at decision time. Restarting the process replays the ledger. A blocked attempt is still blocked, and it resumes at the same step (scenario 5).

### Capacity, cost and scheduling

8. **Capacity.** Only `running` attempts hold capacity: runner slots, lane WIP and account reservations. Blocked attempts and waiting units hold none, so a tenancy active for years costs nothing between evaluations.
9. **Cost.**
   - `Lane.ceiling({ maxUsd, onExceed })` checks projected cost before every invocation, so the scope is the unit.
   - A `Budget` sums invocation cost over a window across lanes.
   - The scheduler reads `ctx.budget(b)` and `metrics.meanCostUsd`.
   - Batch invocations are flagged `batch: true` and priced by the driver at the batch rate.
10. **Scheduler.** The scheduler is declarative sugar over one deterministic decision:
    - `priority` orders lanes;
    - `wip` caps active units per lane;
    - `boost` ages starved lanes;
    - `rank` orders units within a lane (for example by time to SLA breach);
    - `admit` gates a start on live state (for example "no Backup while an Incident is active", "projected cost ≤ remaining budget").

    Preemption is expressed as priority plus admission. Running attempts are never interrupted by the scheduler.

### Triggers and metrics

11. **Triggers fire only from recorded events**, and their firings are recorded. There are four sources:
    - `when.transition`;
    - `when.pattern` (N consecutive matches per group key);
    - `when.timer`;
    - `when.step` (step completion, carrying the typed output and the models used in the attempt).

    There are three consequences:
    - `create` in a lane;
    - `signal` the source unit;
    - `record` into a journal, optionally as a `candidate`. This is the capture loop (weakness 9).
12. **Metrics.** Built-in `outcomes({ of, model, windowDays })` returns counts per outcome and per state, with `samples` beside `successRate`. Owner metrics are `H.metric(name).from(source).samples(e => [{group, success}])`, queried through `rate(metric, { group, windowDays })`, which always returns `samples`. Editor actions are halt decisions, which are recorded step events, so "metrics from operator actions" needs no new concept.

### Memory and accounts

13. **Memory.**
    - The kernel owns the envelope: id, created, status (`candidate` | `active` | `retired`), `when` scope over kinds, roles, skills and resources, `mergedInto`, and track record.
    - Recall is `H.recall({ by, limit, minScore })`. It is deterministic: it filters by scope, ranks by specificity or by similarity score, and breaks ties by track record. Similarity scores come from `MemoryStore.similar`, a backend capability. The policy that uses them is fixed.
    - Reads take the union of all journals of the memory kinds visible to the role. Each write names one journal (weakness 12, now stated).
14. **Accounts.** An account's quota state lives in an `AccountLedger`, which is the account's own ledger facet, and the account may name a shared one. If it names none, the harness ledger serves it.
    - `reserve` is atomic in the backend, so two harnesses on one SQLite account ledger see each other's cooldowns and utilization immediately.
    - Share caps are per harness, on the `Pool`.

### Control API and startup

15. **Control API.** A client is granted operations (`H.ops.*`, plus custom `H.operation(...).run(exec)`), not capability strings. The Claude Code supervisor and plain HTTP are two `Client` backends of the same `ControlApi` (weakness 15).
16. **Startup validation.** `start()` fails on any of the following:
    - duplicate names among all descriptors;
    - a flow that can fall off its end without an exit;
    - an unregistered lane, journal, metric or budget referenced anywhere;
    - a `restart` step not in the flow;
    - a `skip`/`exit` result outside its schema;
    - a batch step on a driver without `submitBatch`;
    - a kind without a `cancelled` state that receives `H.cancel` without a reaction.

    No kind needs a store. Without one, attributes live in the ledger's `unitCreated` and `attributesUpdated` events.

## What changed and why

Versus the brief:

- **Durable identity and replay replace in-memory loops.** This answers weaknesses 2, 6 and 10 at once.
  - Attempts are continuations.
  - Spawn, await and wait suspend.
  - Halt blocks without a slot.
  - The ledger's event union is the replay log.
- **Flows exit, lanes map** (weakness 1). This also removes duplication between the flow input and the kind (weakness 11): the flow states its minimum shape, and the compiler checks that the kind's attributes cover it.
- **Signals unify** external events, supplier updates of existing units, and cancellation. Suppliers route events with `create`, `signal` or `skip`.
- **Timers** are trigger sources and steps. The clock is a kernel supplier, not a backend.
- **Search attributes are the kind's `.attributes`**: typed and indexed, and read by `rank`, `admit`, triggers and `pattern.per`.
- **Roles carry intents, not tool names** (weakness 3). Memory scope `resources` are names, not globs (weakness 4).
- **New pivots, each with a noun:**
  - Budget: daily spend across units.
  - Metric: owner-defined samples.
  - The account ledger: account state that spans harnesses (weakness 8).
- **Observers stay a backend interface** (board, telemetry, Slack). They are not a kernel noun.

## Principles broken

- **12 (lifecycle skeleton):** I add a sixth outcome, **`ended`**. It is terminal, and neither success nor failure. It covers Experiment's inconclusive and A/B wins, tenancy churn, negotiation walk-aways and expiry, and a parked topic. Without it each of these would be a lie mapped onto `succeeded` or `failed`.
  - **Success rate afterwards:** `successRate = succeeded / (succeeded + failed)`, and `samples = succeeded + failed`. `ended` and `cancelled` are excluded from the denominator and reported as their own counts. `byState` gives per-state counts, so "how often are experiments inconclusive" is `byState.Inconclusive / (succeeded + failed + ended)`.
  - The scheduler treats all four of `succeeded`, `failed`, `cancelled` and `ended` as terminal.
  - A kind that wants "A wins" counted as success maps it to a `succeeded` state. The choice is the kind's, never the flow's.
- **15 (ledger is the only state):** I bend it but do not break it. Account quota state is in the `AccountLedger`, a second ledger interface that the default SQLite ledger also implements. It is shareable across harnesses because account state is not one harness's. No work store is introduced.
