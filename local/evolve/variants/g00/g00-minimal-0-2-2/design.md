# harness-dsl: minimal, cut again (child of g01-minimal-imal-0-2)

The operator for this child is surface-cut. It applies three changes:

- It removes methods, fields and options that the battery never reads, or that have one caller and can be a default.
- It repairs the adversary's three sharpest critiques. Two of the repairs also delete surface.
- It fixes the principle-12 gap the parent left open.

Scenarios 11 and 12 (run two) then forced a second, additive pass. That pass is recorded at the end of "What changed and why".

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)`, or `H.state(name, 'terminal', verdict)` | A shareable lifecycle position. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others)` | A data shape and a set of states. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, decision).about(z).timeout(after, resolve).policy(rule)` | A named outside decision. It declares what is asked, the shape of the answer, the facts it is raised with, and optionally a clock resolver and a policy resolver. |
| Kind | **resource** | `H.resource(n)` | A named shared thing that locks reference by identity. |
| Instance | account, model, runner, store, memory store, supplier, ledger, guard, observer, client | adapters only | Specific resources, each with its backend. |
| Pivot | **agent** | `H.agent(n, role).model(m \| policy)` | An executable: role × model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow).suppliers().store().wip().maxUsdPerUnit().retry(policy, exhausted).locks(f).after(f, onFailure)` | A work queue: kind × suppliers × store × handler, with its capacity and ordering. |
| Pivot | **library** | `H.library(n, memory, store)` | A recall source: memory kind × store. |
| Pivot | **pool** | `H.pool(n, members, policy?)` | The account that serves a call. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | **flow** | `H.flow(n).for(k1, k2?).params(z).does(ctx => state)` | A handler body. |
| Composite | **command** | `H.command(n).input(z).output(z).argv(f).on(...runners).recovery(r)` | A deterministic executable. |
| Composite | **job** | `H.job(n).output(z).submit(command).collect(command, every)` | An external executable: submitted now, polled until done, holding no capacity in between. |
| Composite | **policy** | `H.policy.{model, account, scheduler, retry, rule}` | A deterministic decision. |
| Composite | **operation** | `H.ops.*`, `H.ops.resolve(...halts)`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger().lanes().pools().triggers().scheduler().clients().observers()` | The running thing. |

These are values, not entities:

- `H.clock(...)` and `H.operator`, which are kernel suppliers.
- `H.env(name)`.
- `TimeSpec`, `Interval`, `Bound`, `MetricBounds`, `Lock`, `JobPoll`.
- `SupplyOf<K>`.
- `Children<T,S>`, the handle returned by `ctx.spawn`.

## Execution vocabulary

- **Run**: one lifetime of a harness process.
- **Attempt**: one execution of a lane's flow for one unit.
  - Its states are `running`, `blocked` (on a halt), `waiting` (in `ctx.wait`, or on a job or batch) and `ended`.
  - When ended, its outcome is `succeeded`, `failed` or `cancelled`.
- **Invocation**: one call of one executable inside an attempt.
  - Each retry and each batch item is its own invocation.
  - A job is one invocation, however many polls it takes.
- **Step** is not a word in this design.

## Rules

### 1. Skeleton (principle 12)

**Positions.** A unit has one of four positions:

| Condition | Position |
|---|---|
| A live attempt is running | `active` |
| A live attempt is blocked, waiting, or in a job or batch | `waiting` |
| No live attempt | The position its state declares |

The board and the scheduler read this position. Waiting on a human is recorded once, as the attempt's blocked state. No kind declares a state for it.

**Verdicts.** Each terminal state declares `success`, `failure` or `neutral`. The overload without a verdict does not type-check for terminal states.

**How a flow ends.**

| How the flow ends | Attempt outcome | What happens to the unit |
|---|---|---|
| Returns a state | `succeeded` | Moves to that state. |
| Returns `ctx.fail(reason)` or throws | `failed` | See the failure rule below. |
| Interrupted by an outside move, a preemption or a cost ceiling | `cancelled` | Handled by the rule that interrupted it. |

**The failure rule.**

- A failed attempt leaves the unit at pending under the lane's retry policy.
- `lane.retry(policy, exhausted)` declares that policy. When the policy returns `'stop'`, the unit moves to `exhausted`, which is a state of the lane's kind, and nowhere else.
- The kernel appends `attempt` entries with status `retrying` or `exhausted`.
- A lane without `.retry` uses the kernel default: exponential backoff from 1 minute, capped at 1 hour, with no limit. That default never exhausts, so it needs no end state.
- Because `exhausted` is a required argument, a bounded policy with no end state cannot be written.
- `KindDescriptor.failsTo` is kept for scenarios 1–10 only. See "Principles broken".

**Returning a waiting state.** The flow parks the unit with no wake time. A supply, trigger or operation must move it.

### 2. Durable waits

`ctx.wait(waitingState, { at })` and `ctx.wait(waitingState, { children })` suspend the attempt inside the flow:

- The unit moves to the waiting state.
- The attempt holds no runner slot and no WIP.
- On wake, the same attempt resumes by replay.

An attempt's `durationMs` excludes time spent blocked and waiting.

### 3. Success rate

- `successRate(kind)` is `success / (success + failure)` over terminal transitions.
- Neutral states are excluded from it, and stay countable by name.
- Every rate carries `hits` and `samples`. `value` is `null` when `samples` is 0.

### 4. Moves from outside

**Default.** Moving a unit that has a live attempt (running, blocked or waiting) cancels the attempt first.

**Deferred updates.** A supply `update` marked `deferred: true` is held while the attempt is *running*. It is applied when the attempt next blocks, waits or ends:

- If the attempt is blocked or waiting at that point, the move cancels it.
- If the attempt has ended, the move applies after the end.

A redline therefore never kills a draft in progress and is never lost (scenario 11).

### 5. Supply and keys

- A `create` whose key belongs to an open unit is ignored.
- An `update` addresses the open unit with that key.
- The ledger keeps a snapshot of every unit.
- `folder.files({ key })` sets keys from file names.

### 6. Entities in filters, not strings

**Filters take descriptors.** `EntryFilter` fields take descriptors (`kind`, `lane`, `halt`, `resource`, `trigger`, `executable`).

**Halt filters.** `halt.resolved(match?)` builds a typed filter for that halt's resolutions. `match` is `Partial<D>`.

**What remains a string.** Tags stay strings.

### 7. Halts (principle 17)

**Raising a halt.** `ctx.halt(halt, show, about)` raises the halt with typed facts `about`, which are declared by `.about(schema)`.

**Resolvers.** A halt has up to three resolvers, recorded on the resolution as `resolver`:

| Resolver | How it is declared | When it acts |
|---|---|---|
| `policy` | `.policy(rule)` | At raise. A `RulePolicy<C, D \| null>` runs first. A non-null result resolves the halt at once, and the entry carries the metric reads and sample counts. `null` falls through to the human. |
| `human` | A client granted `H.ops.resolve(halt)` | When that client resolves it. A grant names halts. `H.ops.resolveHalts` grants all of them. |
| `clock` | `.timeout(after, resolve)` | At `after` from the recorded `raised` entry, if the halt is still open. It resolves the halt with `resolve(about)`. The attempt continues; nothing is cancelled. |

**Escalation.** `H.on.halted(halt, after)` is a trigger source that fires once at `after` from the raise, if the halt is still open. It is used to page a deputy with `act.run(executable, input)`.

**Measure.** `decisionMs` is the time from raise to resolution. It is available to `mean`, `median` and `sum`, filtered by `halt` and `resolver`.

### 8. Triggers

**Unit sources:**

- `on.enters(kind, state, { times? })`. With `times: n`, it fires only on a unit's n-th entry into the state. This is the declared bound on re-entries.
- `on.streak`.
- `on.deadline`.

**Other sources:**

- `on.metric`, ungrouped or grouped, with hysteresis.
- `on.halted`.

**Firing order.** Triggers whose source is a transition run in the transaction that records the transition, before the scheduler sees the unit.

**Effects:** `create`, `move`, `remember`, `pause`, `resume`, `run`.

**Recording.** Every firing is a `firing` entry.

### 9. Scheduler, capacity, locks and ordering

**Scheduler.**

- The scheduler returns an ordered `start` list and an optional `preempt` list.
- The kernel starts units in that order while lane WIP, runner slots, account eligibility, lane pause, locks and ordering allow.
- WIP and runner slots are held only by attempts at position `active`. A unit waiting on counsel, on a GPU job or in `ctx.wait` holds neither.

**Locks.** `lane.locks(data => Lock[])` declares the locks a unit takes for the life of its attempt, before it starts.

- A lock is `{ resource, mode: 'exclusive' | 'shared' }`.
- Exclusive excludes everything on that resource. Shared excludes only exclusive.
- Leases are ledger entries (`lease` requested / acquired / released), and `lockWaitMs` is measured on `acquired`.
- A blocked or waiting attempt keeps its locks. A migration paused mid-run still owns its database.

**Ordering.** `lane.after(data => predecessorKey | null, onPredecessorFailure)` holds a unit until the predecessor unit reaches a `success` terminal.

- If the predecessor ends at `failure` or `neutral`, the unit moves to `onPredecessorFailure`. That state must be a waiting state.
- The move is a transition carrying `reason`.

**Placement.** `command.on(...runners)` places an invocation on the first runner with a free slot and a passing preflight.

### 10. Jobs (principle 3)

`H.job(n).output(z).submit(cmd).collect(cmd, every)` declares a job:

- `submit` returns a handle, recorded on an `invocation` entry with status `submitted`.
- The attempt then waits: it holds no WIP and no slot.
- The kernel runs `collect(handle)` every `every` until it returns `done` or `failed`.
- A remote `failed` is an invocation failure, and therefore an attempt failure if the flow fails on it.
- On restart, a submitted job is collected, never resubmitted.
- The invocation's `durationMs` is the job's time in flight, from submit to end. Its mode is `job`.

### 11. Cost

- `maxUsdPerUnit` is cumulative across a unit's attempts.
- An invocation that would pass it blocks on the kernel halt `cost-ceiling`.

### 12. Accounts and quota (principle 15)

- Quota is a ledger partition of append-only events, folded at read time.
- `sqlite.ledger(path, { sharedQuota })` places that partition in a shared file.
- Shares belong to pools.

### 13. Memory

- The kernel owns the envelope.
- Candidates are never recalled until accepted.
- Recall is one deterministic kernel policy.

### 14. Durability (scenario 10)

**Replay.**

- Every `run`, `batch`, `job`, `halt`, `decide`, `move`, `update`, `remember`, `spawn` and `wait` is a ledger entry with a sequence number.
- After a restart, recorded results are returned without invoking again.
- A loop of batch commands (scenario 12 backfill) resumes at the first batch with no recorded result. The one that was running follows its command's `.recovery`.

**Interrupted invocations.**

- Commands follow `.recovery`: `'rerun'`, `'park'` (the default), or a check command.
- A parked attempt is blocked on the kernel halt `interrupted`, with what was recorded.

**The attempt record.**

- A resumed attempt keeps its id.
- Interrupted invocations are excluded from model and agent rates.

**A changed definition.** A changed flow fingerprint blocks the attempt on the kernel halt `definition-changed`.

**Single writer.** `start()` holds a renewed ledger lease.

### 15. Control API

- The API is made of operations.
- `claude-code.supervisor` is one client. `http.control` is a plain-HTTP client.
- Grants are per client. Two clients may hold disjoint `resolve` grants over the same unit.

### 16. Startup validation

`start()` fails in each of these cases:

- duplicate descriptor names, including halts and resources;
- a flow whose states are not states of its lane's kind;
- a `wait`, `failsTo` or `after` target whose position is wrong;
- a `retry` exhausted state that is not a state of the lane's kind;
- an unregistered lane referenced by a trigger;
- an agent that no pool can serve;
- a command without argv or runners;
- a job whose submit or collect command has no runner;
- a missing ledger;
- a batch on a model without `submit` and `collect`;
- a halt with `.timeout` or `.policy` but no `.about` when its resolver reads facts.

A harness with no pools, agents or models is valid.

## What changed and why

### Repairs of the adversary's critiques (first pass)

| Critique | Repair |
|---|---|
| a. Raw strings | `H.halt` entity with `resolved(match)`. Descriptor-typed `EntryFilter` fields. `ModelChoice.agent` removed. |
| b. Fake groups | Ungrouped `on.metric` overload. |
| c. Phase dispatch | `ctx.wait` replaces `until`. `failsTo` replaces `unit.failures` branching. |
| Scenario 4 placement | `Command.on(...runners)`. |

The first pass also made a long list of cuts: `ctx.until`, `ctx.children`, `HaltRequest`, unread view fields, the `on.enters` array form, the `folder.files` `write` option, unread re-exports and the kernel `Recall` types.

### Second pass (scenarios 11 and 12)

| Addition | Scenario need | Why it is not an escape hatch |
|---|---|---|
| `Lane.retry(policy, exhausted)` | 11: EU retries 3× with backoff, US 1×, one kind. | Principle 12 puts the retry policy and its end state on the lane. The required `exhausted` argument makes "bounded and endless" unrepresentable. |
| Position derived from attempt state | 11: forty contracts waiting on counsel hold no WIP and are not active. | Principle 12: waiting on a human is the blocked state, recorded once. The parent counted blocked attempts toward WIP, which broke it. |
| `Halt.about`, `.timeout`, `.policy` | 11: the clock resolver ("approve under $500"), and skipping counsel by a registered policy with recorded reads. | Principle 17's three resolvers, each referencing the halt by identity. |
| `H.on.halted` and the `act.run` effect | 11: page a deputy at 20 minutes from the recorded raise. | Principle 13 lists running an executable as a trigger consequence. |
| `H.ops.resolve(...halts)` | 11: counsel and finance hold disjoint grants. | Principle 17: a grant names the halt. |
| `on.enters(..., { times })` | 11: the second return declines the contract, with no count in the flow. | A declared bound that the kernel enforces. |
| `Supply.deferred` | 11: a redline during `draft` is applied next round; during counsel it re-enters at `draft`. | One flag, resolved by the kernel. |
| `Metrics.median`, `Metrics.count`; measures `decisionMs`, `lockWaitMs`; `EntryFilter.resolver`, `.resource` | 11 and 12 telemetry. | Sample counts stay beside every rate and mean. |
| `H.resource`, `Lane.locks`, `LeaseEntry` | 12: exclusive migrations and shared backfills per database. | Principle 8: the resource is an entity and the lease is ledger state. |
| `Lane.after` and `TransitionEntry.reason` | 12: 0042 waits for 0041, and is parked with a reason if 0041 fails. | Ordering is a lane relationship, not on the kind (principle 10). |
| `H.job` and `JobPoll` | 12: a GPU job polled every 10 minutes, holding no capacity. | Principle 3's external job. Batch remains a separate model-only form; see known weakness 2. |
| `folder.files({ key })` | 12: migration keys come from file names, so `after` can address them. | One option. |

## Principles broken

- **12, partially.** `KindDescriptor.failsTo` lets a kind declare a failure move, which principle 12 now forbids ("the kind declares nothing about failure").
  - It is kept only because scenarios 1–10 of this variant were written against it.
  - `Lane.retry(policy, exhausted)` is the conforming form, and scenarios 11 and 12 use only it.
  - `failsTo` should be deleted when those scenarios migrate.

Everything else holds. The rule that blocked attempts sit at `waiting` replaces the parent's WIP rule, which broke principle 12.
