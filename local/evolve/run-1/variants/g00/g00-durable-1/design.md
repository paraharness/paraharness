# harness-dsl: durable seed

Lens: a unit of work is a durable execution. Its identity (kind + key) outlives processes. Attempts are continuations of it. The ledger is the event history. Timers, signals and children are the normal case, not exceptions.

Temporal's vocabulary was considered and mostly declined:

| Temporal | harness-dsl |
|---|---|
| workflow | **flow** |
| activity | **step** (with an **invocation** per execution) |
| signal | **signal** (kept: no owner word is better for "an event delivered to a unit by id") |
| search attribute | **attribute** |
| child workflow | **spawn** |

## Execution vocabulary (one definition each)

- **Unit**: one piece of work of one kind, identified by `(kind, key)`. It is durable and lives in the ledger. It may also have fields in a store.
- **Attempt**: one pass of the lane's flow over a unit, from start to an end label (or to failure or cancellation).
  - An attempt may **suspend** and later continue. It suspends when blocked on a human, waiting on a timer, waiting on children, or preempted.
  - Suspension is not a new attempt.
  - Statuses: running, blocked, waiting, completed, failed, cancelled.
- **Step**: one named node of a flow. Its output is recorded in the ledger. On resume, recorded outputs are replayed, never re-executed.
- **Invocation**: one execution of an executable inside a step.
  - A retry is a new invocation of the same step.
  - A batch step makes one invocation per item, all sharing a `batchId`.
- There is no "run". The process lifetime is not a domain concept. Restart survival is a property of attempts.

## Entities

### Kinds (vocabulary, no backend)

- `H.state(name, outcome)`: a state entity on the skeleton. Shareable across kinds.
- `H.work(name)`: a work kind.
  - `.attributes()`: typed, indexed, ledger-held scalars that policies and triggers read.
  - `.fields()`: domain data held by the store, if any.
  - `.states([...])`: the first listed state is initial.
  - `.signals({...})`: typed external events the kind accepts.
  - `.timers(t => ...)`: named clocks. Each is a recurrence, a delay from creation, or an attribute holding epoch ms.
  - `.key(fn)`: identity for dedupe and for addressing signals.
- `H.role(name)`:
  - `.intents([...])`: one or more of `read`, `write`, `execute`, `search`, `browse`, `ask`, `remember`. Drivers map intents to their own tools.
  - `.instructions()`, `.input()`, `.output()`.
- `H.memory.experience(name)` / `H.memory.taste(name)`: memory kinds. `.curated()` makes non-owner writes enter as candidates.
- `H.resource(name).paths([...])`: a named thing memory can be scoped to (a service, a database, a path set).
- `H.command(name, argv)`: a deterministic executable. `.parses(shape)` turns stdout JSON into typed `data`.
- `H.flow(name)`: the handler graph (see Flows). Blind to kinds and states.

### Instances (carry a backend; come from adapter subpaths)

Account, model, runner, quota, ledger, store, memory store, supplier, client, projection, external executable.

An instance *is* the kernel interface implementation (`kernel.d.ts`). It is inert until `start()`.

### Pivots (every one names its product)

| Pivot | Composed of | Produces |
|---|---|---|
| **lane** | work kind × suppliers × store × flow × runner | *the place a kind's units are produced, kept and handled* |
| **agent** | role × model (or model choice policy) × pool × journals | *an executable that thinks* |
| **pool** | accounts × shares × preference policy × fallback | *the accounts an agent may draw on* |
| **journal** | memory kind × memory store × recall policy | *where items of a kind are written and how they are recalled* |
| **trigger** | source × consequences | *a recorded firing* |
| **access** | a set of operations | *what a client may do* |
| **harness** | ledger × lanes × triggers × schedule policy × clients × projections | *a running scheduler* |

The lane owns: label→state mapping, flow params, spawn targets, WIP, per-unit budget, signal reactions and preflight.

Policies (`H.policy.schedule|model|account|gate|recall`) and metrics (`H.metric`) are deterministic functions. They are named and never self-modifying.

## Rules

**Skeleton.**
- There are six outcomes: pending, active, succeeded, failed, cancelled, **concluded**. Concluded is terminal and is neither success nor failure.
- Every kind state declares one outcome.
- A unit is in the pending queue *iff* its state's outcome is pending. Nothing else enqueues new attempts.
- A unit in an active state with no open attempt is idle. It holds nothing (a tenancy between reviews, a negotiation awaiting the vendor).

**Success rate.**
- Success rate = succeeded / (succeeded + failed), over units reaching a terminal state in the window.
- `n` = succeeded + failed, and is always returned.
- Cancelled and concluded are excluded from the rate. `metrics.outcomes()` reports them with per-state counts and `share(state)`.
- Example: "how often is an experiment inconclusive" is `outcomes(...).share(Inconclusive)`, with its own `n`.
- The scheduler treats every terminal outcome as terminal.
- "Loaded with warnings" is a succeeded-outcome state distinct from Loaded. It is success to the scheduler and distinct in `byState`.

**Flows emit labels, lanes map labels to states.**
- `.mark(label)` records progress mid-flow.
- `.exit(label, when)` ends the attempt early with `label` when the predicate holds. Later steps never run.
- `.ends(labels, pick)` ends the attempt.
- Every flow implicitly has the label `failed`. It fires on a step failure after retries, when `onFailure` is `'fail'`.
- The lane's `handler(flow, { states: {...} })` must map every label to one of the kind's states. The mapping is typed exhaustively.
- Mapping `failed` to a non-terminal state is allowed (a tenancy review that fails returns to Current).
- One flow serves Bug and Feature; their round counts come from `params`.

**Attributes from a flow.**
- `.sets(shape, make)` records a `unit.attributes` event that updates the unit's attributes (a classifier's category).
- The written keys join the flow's required input. The lane therefore checks at compile time that the kind declares them with matching types.
- `start()` checks that they are attributes, not fields.

**Suspension and capacity.**
- Halts, waits, spawns and preemption suspend the attempt. A suspended attempt:
  - releases its runner slot and account;
  - keeps lane WIP;
  - is persisted.
- Resumption is a queue entry (`reason: 'resume'`) that the scheduler admits like any other.
- Recorded step outputs replay, so a blocked attempt survives restart and resumes at the same step.
- Runner slots and accounts count as capacity only while running. WIP counts open (non-ended) attempts.

**Signals and timers.**
- Suppliers emit either `{ create }` or `{ key, signal, payload }`. A signal addresses an existing unit by key.
- A kind timer fires as a signal of the same name, with payload `{ firedAt }`.
- Timers are queue entries with a future `readyAt`. The scheduler owns the clock, and timers survive restarts.
- A lane reacts to a signal with `H.move(state).from([...])`:
  - the open attempt (if any) is cancelled;
  - the unit moves to the target state;
  - if the target state is pending, the unit is queued.
- `.from` lists the states the reaction applies in. It is typed against the kind's states, independently of the target.
- Signal payloads are recorded and visible to the next attempt as `c.signals`.
- Cancellation is a signal like any other.
- A signal to a unit in a terminal state is rejected unless the reaction's `.from` lists that state.

**Triggers.**
- Sources:
  - `H.on.transition`;
  - `H.on.streak` (N consecutive terminal outcomes per attribute value);
  - `H.on.step` (a recorded step output);
  - `H.on.signal` (including timers).
- Consequences: `.creates(lane)`, `.signals(lane, name)`, `.records(journal)`, `.invokes(executable)`.
- Every source is a recorded ledger event. Every firing is recorded with its source sequence number.
- A flow never names another kind.

**Steps.**
- `step(key, executable, input, { retry, timeoutMs, onFailure, runner })` serves commands, agents and external executables alike.
  - Retry is declared (`H.retry.exponential`) and executed by the engine.
  - `onFailure: 'halt'` turns a failure into a human block carrying the step output.
- `halt(key, { ask, decision, skip })` blocks for a human. `skip.when` is a gate policy; when it returns true, the engine records the given decision instead of blocking (the safe-category rule).
- `batch` submits items as one cloud batch when the agent's model supports it. Its invocations are priced at the batch rate.
- `spawn` creates children through a named outlet, which the lane maps with `H.child(lane, fn)`. It suspends until all children are terminal.
- `loop` repeats a body with typed carry until `again` returns null or the rounds run out.
- An agent with the `ask` intent may halt its own invocation.

**Budget.**
- `lane.budget({ maxUsdPerUnit, onExceed })` caps cumulative invocation cost per unit, across attempts.
- Drivers receive `remainingUsd`.
- Exceeding the cap halts or fails, as declared.

**Memory.**
- The kernel owns the envelope: id, created, kind, status, `when` scope, rule, because, source, mergedFrom.
- Agents `.recalls([...])` journals and `.records(journal)` into one.
  - Reads union all named journals.
  - Writes go to exactly one, because a write needs one destination. The asymmetry is deliberate.
- Recall gives the policy candidates pre-scored by:
  - specificity;
  - track record (present / succeeded attempts);
  - similarity to the step input, when the store supports it.
- The recall policy orders and cuts the candidates deterministically.
- A vector store is a `MemoryStore` that returns similarity.
- Items written by triggers into a `.curated()` kind are candidates until the owner accepts, merges or drops them (`curateMemory`).

**Accounts and quota.**
- By default, quota state is a partition of the ledger (`Ledger.quota`). An account may carry its own `Quota` backend instead.
- Two harnesses that declare the same account with the same quota backend share window and cooldown state.
- Each harness's share cap is per pool, and is checked with `harnessUtilization`.
- Eligibility is read from the quota backend at every decision and never cached across decisions.

**Scheduler.**
- The schedule policy orders candidates (new, resume, timer).
- It may name running attempts to preempt. They suspend at the next invocation boundary and requeue.
- The kernel then admits in order, subject to lane WIP, runner slots, preflight and account eligibility.
- Default policy: FIFO.

**Metrics.**
- Always `{ rate, hits, n }`.
- Built-in: success, outcomes, cost, spend.
- Owner metrics are `H.metric(name).step(flow, key).hit(...)` or `.transition(lane).hit(...)`, computed on demand from recorded events.
- A query naming both `agent` and `model` counts only attempts in which that agent ran that model (`AttemptView.models`).
- Every metric read inside a policy is recorded with the decision (`policy.decided`). A board can therefore show why a model was picked and on how many samples.

**Control API.**
- Clients are granted operations, not capabilities.
- Operations are built-ins (`H.ops.*`) or custom (`H.operation(name).input(...).invokes(executable, prepare)`).
- A client is an adapter that serves `ControlApi` for one `access`.
- Transport (MCP via a coding-agent session, or plain HTTP) is the client's backend.

**Startup validation.** `start()` fails on any of:
- two descriptors with one name;
- a lane whose kind has no states;
- an unmapped label, or a label mapped outside the kind's states;
- a `.sets` key that is a field rather than an attribute;
- a signal reaction or `from` state outside the kind;
- a trigger on an unregistered lane;
- an agent without a model or pool;
- a batch step whose model cannot batch.

`start()` warns on:
- a recurring timer on a kind none of whose lanes react to or trigger on it;
- an access granting an operation for which no client exists.

## Less obvious choices taken

1. Added `concluded` instead of forcing neutral endings onto succeeded or failed.
2. Flows know labels, not states; the lane maps them. This resolves known weaknesses 1 and 11: the flow's `requires` is checked against the kind at the lane.
3. Pending is derived from the state. There is no "re-enter" verb; signals only move states.
4. Halt, wait, spawn and preemption *suspend* the same attempt rather than ending it. The Epic has one attempt that sleeps on its children without holding a slot.
5. Timers are signals. One reaction mechanism covers the SLA breach, the 09:00 cutoff, the two-week expiry and the monthly review.
6. Instances are the backend implementations themselves; there is no descriptor wrapper layer.
7. Quota is a ledger partition that an account may relocate, rather than a second kernel store.
8. Triggers can fire on step outputs, so a command's output can become memory without the command knowing about journals.
9. Agent-initiated halts are an intent (`ask`) that the driver maps.
10. Skills are dropped from memory scope; attributes (e.g. `section`) scope instead.
11. Flows have no branching construct. A single `.exit` covers the cases the battery needs (rejected approval, certificate still valid, too few sources).

## What changed and why

**Versus the brief and the owner's seed:**
- Execution words are defined (weakness 10).
- Attempts suspend and resume (weakness 2, and restart survival).
- Signals and timers are first-class trigger sources and lane reactions (weaknesses 5, 6, 13).
- Cancellation from outside is a signal.
- Per-unit budget and SLA timers exist (weakness 7).
- Quota can be shared across harnesses through an account's quota backend (weakness 8).
- Triggers record memory (weakness 9).
- Roles name intents, not tools (weakness 3).
- Resources are entities (weakness 4).
- Flows are decoupled from states (weakness 1) and from the kind's input (weakness 11).
- The journal read/write asymmetry is stated (weakness 12).
- Perpetual and multi-outcome units fit through idle active states and `concluded` (weakness 13).
- Notifications are external executables invoked by triggers; projections remain the one subscriber shape (weakness 14).
- Transport lives in client adapters (weakness 15).
- Startup validation is specified (weakness 16).
- Journal is kept as the noun (weakness 17 unresolved); curation is an operation on a journal's items.

**Scenario pass (all eight scenarios written against the surface):**
- **`Move` from-states.** `H.move(to).from([...])` previously typed `from` with the target's own state type, so `H.move(New).from([AwaitingApproval])` could not compile. `Move` now carries a separate from-state parameter. The lane checks both the target and the from-states against the kind.
- **`FlowDraft.exit(label, when)`.** Scenario 5 must not load after a rejected approval. Scenario 3 parks before paying for synthesis. Scenario 4 skips renewal when a certificate is still valid. Without an early end, each of these needed a command pretending to be a branch.
- **`FlowDraft.sets(shape, make)`.**
  - Scenario 2's safe-category gate and its "approval rate by category" metric filter on an attribute that only the classifier knows.
  - Attributes could only be set by suppliers.
  - A flow can now write attributes; the lane type-checks the written keys against the kind.
  - The kernel gains the `unit.attributes` ledger event.
- **`H.on.transition` filter.** The filter is typed with `NoInfer`, so the filter list never narrows the lane's inferred state union.
- **`harness-dsl/zendesk.reply`.** An external executable that posts a reply. Sending is an action, not store state.
- **Metric queries.** Naming `agent` and `model` together now has defined semantics (scenario 6 compares two reviewers of one role).
- **Scenario 7.** Scenario files may import only `harness-dsl*`, so its "shared module" is written as the top section of the same file, with both harnesses below it importing nothing but those constants.

## Principles broken

- **12** (five outcomes): the skeleton gains `concluded`.
  - Reason: scenario 8 and the research "parked" outcome cannot be expressed without lying otherwise.
  - Success rate is redefined above: succeeded / (succeeded + failed), with cancelled and concluded excluded from the rate and always reported beside it with their own counts.
