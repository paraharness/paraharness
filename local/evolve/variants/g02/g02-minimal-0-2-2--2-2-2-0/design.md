# harness-dsl: minimal, split (child of g01-minimal-0-2-2--0-2-2-2)

Operator: **split**.

## The split

**The lane did two jobs.**

- **Job one:** the principle-8 pivot. It says which work exists and how it is done: kind × suppliers × store × handler, plus how much runs at once (`wip`) and in what order (`order`).
- **Job two:** the bounds a single unit lives under. These are how many failed attempts it may have, where exhaustion leaves it, and how many dollars it may spend.

The second job had nothing to do with supply or handling. It was the reason the parent's lane carried ten concerns (known weakness 6, critique 3).

**The split:**

| Entity | Builder | Produces |
|---|---|---|
| **lane** | `H.lane(n, kind).handler().suppliers().store().wip().order().allowance()` | A stream of work of one kind, handled one way. |
| **allowance** | `H.allowance(n, kind).retry(policy, exhausted).maxUsd(limit, over?)` | What one unit of that kind may spend before the kernel moves or halts it. The spend is counted in failed attempts and in dollars. |

An allowance is typed by its kind:

- `exhausted` must be one of the kind's states. This is checked at compile time by `NoInfer<S>` and again at `start()`.
- One allowance may serve several lanes of the kind.
- Principle 12 still holds: the policy is the lane's, because the lane names the allowance it applies.

**Locks leave the lane.** They were a third job: they say which shared resource a step touches. They move onto the command: `command.locks(input => Lock[])`.

- A lease is held for the invocation, including its retries.
- It is released between retry delays and when the invocation ends.
- This is step scope, which the adversary's scenario 13 asked for. The lock on `prod` is released while `canary` runs.
- **Exception:** an interrupted invocation whose recovery is `park` keeps its leases until the park is resolved. A migration that crashed mid-run still excludes backfills from its database. The board shows the lease beside the `interrupted` halt.

**Surface the split adds and removes:**

| Added | Removed |
|---|---|
| `H.allowance` | `lane.retry` |
| `Allowance.retry` | `lane.maxUsdPerUnit` |
| `Allowance.maxUsd` | `lane.locks` |
| `lane.allowance` | |
| `command.locks` | |
| `LeaseEntry.invocation` | |

That is five methods added against three removed, a net of two methods and one entity. The lane drops from ten concerns to six: kind, handler, suppliers, store, wip and order, plus its runtime pause state.

## Entities

| Sort | Entity | Builder | Is |
|---|---|---|---|
| Kind | state | `H.state(name, position[, verdict])` | A shareable lifecycle position. Terminal states require a verdict. |
| Kind | kind | `H.kind(n).data(z).states(initial, ...)` | A data shape and its states. It declares nothing about failure. |
| Kind | role | `H.role(n).input().output().prompt().intents()` | What a model call is asked to do. |
| Kind | memory | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | halt | `H.halt(n, decision).about(z).timeout(after, f).policy(rule)` | A named outside decision. |
| Kind | resource | `H.resource(n)` | A named shared thing, referenced by locks and memory scope. |
| Kind | facet | `H.facet(n, schema)` | A declared metric dimension whose values come from data. |
| Instance | account, model, runner, store, memory store, quota partition, supplier, ledger, guard, observer, client | adapters | Each carries its backend. |
| Pivot | seat | `H.seat(n, role).model(m \| policy)…` | role × models × choice policy. |
| Pivot | lane | see above | kind × suppliers × store × handler. |
| Pivot | **allowance** | see above | kind × retry policy × exhausted state × cost ceiling. |
| Pivot | journal | `H.journal(n, memory, store)` | memory kind × store. |
| Pivot | pool | `H.pool(n, members, policy?)` | accounts × policy. |
| Pivot | trigger | `H.trigger(n, source, effects)` | A recorded consequence of recorded state. |
| Pivot | **report** | `H.report(n, (metrics, now) => rows)` | A named projection of metrics. Observers render it and clients read it. |
| Composite | flow, command, job, policy, operation | as named | Executables and decisions. |
| Root | harness | `H.harness(n)…start()` | The running thing. |

## Execution vocabulary

| Word | Definition |
|---|---|
| Run | One process lifetime. |
| Attempt | One execution of a lane's flow for one unit. Its states are running, blocked, waiting and ended. Its outcome is succeeded, failed or cancelled. |
| Invocation | One call of one executable. A job is one invocation. Each item of a batch job is an invocation with `batch: true`. |
| Grade | A flow's recorded judgement of one invocation's output: `accepted` or `rejected`. It is not an outcome. |
| Step | Not a word in this design. |

## Rules

### 1. Skeleton (principle 12)

**Position** comes from the live attempt, then from the unit's state:

| Condition | Position |
|---|---|
| A running attempt | `active` |
| A blocked or waiting attempt, or a job in flight | `waiting` |
| No live attempt | The position of the unit's state |

**How a flow ends:**

| How the flow ends | Attempt outcome | What happens to the unit |
|---|---|---|
| Returns a state | `succeeded` | Moves to that state. |
| `ctx.fail` or a throw | `failed` | Returns to pending under the allowance's retry policy. |
| An outside move, a preemption, or a ceiling without `over` | `cancelled` | Handled by the rule that interrupted it. |

**Retry defaults and exhaustion:**

- A lane with no allowance, or an allowance with no `.retry`, uses the kernel default: unbounded backoff from 1 minute, capped at 1 hour. It never exhausts, so it needs no end state.
- A bounded policy without an exhausted state cannot be written, because `.retry` requires one.

### 2. Retry has one meaning

`H.policy.retry(name, { retries, firstDelayMs, factor?, maxDelayMs? })`.

- `retries: N` means **N more tries after the first**. N = 3 is four tries. N = 0 is one try.
- `RetryView.retried` counts the retries already made.
- The meaning is the same at both attachment points:
  - On an allowance, a try is an attempt.
  - On a command, a try is an invocation.
- When a command's retries are spent, the flow receives the failed `Result`.
- The kernel derives the decision from the declared numbers. No author writes a boundary comparison.

### 3. Grades: judgement is not failure

`ctx.grade(ran, 'accepted' | 'rejected')` records a `grade` entry for the invocation `ran` came from. `ctx.run` returns `Ran<O> = Result<O> & { invocation }`.

- A grade carries the invocation's typed `seat`, `model` and `executable` columns, and the attempt's facets.
- A reviewer rejecting a draft is a rejected grade on the drafter's invocation. The flow continues. Nobody's attempt fails, and no failure is laundered into a neutral verdict.
- The metrics this serves:

| Scenario | Metric |
|---|---|
| 2 and 9 | Approval rate by model or category |
| 3 | Citation pass rate per synthesizer model |
| 6 | Editor uptake per reviewer seat and model |

### 4. Entities, not strings

**Filters.**

- `EntryFilter` is a union discriminated by `entry`.
- `status` is typed per entry type.
- `state` takes `State` descriptors.
- `trigger`, `lane`, `halt`, `seat`, `executable` and `resource` take descriptors.

**The control API.**

- It takes descriptors.
- A transport adapter maps wire names to descriptors once, through `ControlApi.entities`.
- `halts.resolve(raised, decision)` takes the id of the halt entry that was raised. The kernel checks that the caller's grant names that entry's halt, and refuses otherwise.

**Operations.**

- `Operation.methods` is a typed `ControlMethod` union.
- Every halt resolution is granted by `H.ops.resolve(first, ...rest)`, which names the halts.

**Kernel halts.** The kernel's own halts are entities a grant can name:

| Halt | Raised for | Decisions |
|---|---|---|
| `H.halts.changed` | A changed flow definition | restart or abandon |
| `H.halts.interrupted` | A parked interrupted invocation | finished, rerun or abandon |

**Dimensions.** Dimension columns are `kind`, `lane`, `state`, `model`, `seat`, `resource`, `halt`, `resolver` and `group`, plus declared facets. A facet that repeats a column is a startup error.

### 5. Halts (principle 17)

**Resolvers:**

| Resolver | How it resolves |
|---|---|
| `human` | A client granted `H.ops.resolve(halt)`. |
| `policy` | `.policy(rule)`, with its reads recorded on the halt entry. |
| `clock` | `.timeout`, measured from the recorded raise. The attempt continues. |

`H.on.halted(halt, after)` escalates.

**Address.** Every `HaltEntry` carries `ordinal`: the 1-based count of raises of that halt within the attempt. `HaltFilter.ordinal` selects one raise.

### 6. Allowance and cost

`allowance.maxUsd(limit)` cancels the attempt before an invocation that would pass the ceiling.

`allowance.maxUsd(limit, over)` raises `over` instead. Its decision is applied as follows:

| Decision | Effect |
|---|---|
| `continue: true` | Adds one more `limit` to the unit's ceiling. |
| `continue: false` | Cancels the attempt. |

### 7. Triggers and timers

**Sources** are `enters` (with `times`), `streak`, `deadline`, `metric` with hysteresis and `trippedAt`, and `halted`. Every firing is recorded.

**Deadlines re-arm.**

| Event | What the kernel records |
|---|---|
| The unit enters a `whileIn` state | `firing` with status `armed` and `dueAt`. |
| A recorded data update changes the due date | `rearmed` with the new `dueAt`. The previous due date is void in the same entry. |
| The unit leaves `whileIn` | `withdrawn`. |

Only the latest armed `dueAt` can fire.

### 8. Scheduler, order, locks

**The scheduler view** is `{ pending, active, waiting }`. WIP and runner slots are held only at position `active`.

**`lane.order(by, onEarlierFailure)`.**

- A unit waits until every lower-`by` unit of the lane has reached a `success` terminal.
- If an earlier unit ends at failure or neutral, the unit moves to `onEarlierFailure`, a `waiting` state, with a `reason`.

**The back door is not silent.** A supervisor's `work.move` is a granted operation. It is recorded with `cause: 'operation'`, the client and a required `reason`.

**Locks.** See "The split". The lease is kernel state on the ledger, and `lockWaitMs` is a measure.

### 9. Jobs and batches: one step kind

`H.job(n).output(z).submit(cmd).collect(poll, every)` is an external job.

`H.job(n).batch(seat)` is a job whose submit and collect are the seat's model driver's. It returns `Job<readonly I[], readonly Result<O>[]>`.

- A batch is `ctx.run(batchJob, inputs)`.
- Both hold no capacity in flight.
- Both are collected, not resubmitted, after a restart.
- Batch item invocations are priced at `Price.batchDiscount` and flagged `batch: true`.

### 10. Reports

`H.report(name, read)` registered with `harness.reports(...)` is the telemetry projection.

- The `markdown.telemetry` observer renders every report.
- `ControlApi.telemetry.report(r)` returns its rows. Every rate comes with its samples.

### 11. Durability, accounts, quota

- Replay from the ledger.
- `.recovery` per command:

| `.recovery` | After a crash mid-invocation |
|---|---|
| `rerun` | The invocation runs again. |
| `park` | The attempt is parked on `H.halts.interrupted`. |
| A probe returning `true` | The invocation is recorded as finished. |
| A probe returning `false` | The attempt is parked on `H.halts.interrupted`. |

- A seat's recovery is its driver's `recover`.
- A changed fingerprint parks on `H.halts.changed`.
- `claimWriter` enforces a single writer.
- The account names its `QuotaPartition`. The partition is append-only and folded at read time. The ledger has no quota option.

### 12. Startup validation

`start()` fails on each of these:

- duplicate descriptor names;
- a facet that repeats a column;
- flow states outside the lane's kind;
- an allowance whose kind is not the lane's;
- a `retry` exhausted state outside the kind;
- a `wait` or `order` target at the wrong position;
- a trigger on an unregistered lane;
- a seat no pool serves;
- a command without argv or runners;
- a batch job on a model without `submit` and `collect`;
- a lock on a command whose recovery is a probe that cannot see the lease;
- a halt with a resolver reading facts but no `.about`;
- an author or kernel halt that no client is granted, when the halt has no timeout or policy;
- a missing ledger.

A harness with no pools, seats or models is valid.

### 13. Supply while an attempt is live

A supply that updates an existing unit is applied according to the unit's live attempt and its `deferred` flag:

| Live attempt | `deferred` absent | `deferred: true` |
|---|---|---|
| None | Patch and move apply now. | Patch and move apply now. |
| Running (position `active`) | The patch applies now. A `state` is an outside move, and it cancels the attempt. | Patch and move are held on the ledger. They apply when the attempt ends, or when it next blocks or waits, whichever comes first. |
| Blocked or waiting (position `waiting`) | Patch and move apply now. A `state` cancels the attempt. | Patch and move apply now. A `state` cancels the attempt. |

- A held supply is recorded as a `transition` with `cause: 'supply'` and `reason: 'deferred'` when it applies.
- The supply is never lost and never fatal to a running invocation.
- A move that cancels a blocked attempt re-enters the flow from the top in a new attempt. That attempt sees the patched data.

## What changed and why

| Change | Reason |
|---|---|
| Lane split into lane + **allowance**. Locks moved to `command.locks`. | Operator: the lane did two jobs, and locks were a third. |
| `H.policy.retry(name, { retries, … })`, `RetryView.retried`. | Critique 2: one declared number means "tries after the first" everywhere. |
| `ctx.grade` and `GradeEntry`. | Rejection is a judgement, not a failure. |
| Descriptor-typed filters and control API. | Critique 1: strings at the client boundary. |
| `H.ops.resolveHalts` deleted. `H.halts.changed` and `H.halts.interrupted` added. | A blanket grant named no halt. |
| `H.report`. `ctx.decide` deleted. | Metrics were being stuffed into prompts for lack of a telemetry projection. |
| Deadline arm, re-arm and withdraw entries. | Scenario 9: an SLA extension voids the old deadline. |
| `HaltEntry.ordinal`. | Two raises of one halt can be measured separately. |
| `H.job(n).batch(seat)`. | One submit-and-collect step kind. |
| `Ledger.lease` takes a `Resource`. | Principle 8: a string must not stand in for a resource. |
| Rule 13: the meaning of `Supply.deferred`. | Scenario 11, while writing the battery. A redline arriving while `draft` runs must neither cancel nor be lost. A redline arriving while counsel's halt is pending must re-enter at `draft`. `Supply.deferred` existed in the kernel with no stated meaning. The rule gives it one, and no surface was added. |

**Left open:**

- **Counted resources.** They are not in the battery, so they are left out.
- **One supervisor session over two harnesses.** Each harness registers its own client.

## Principles broken

None.
