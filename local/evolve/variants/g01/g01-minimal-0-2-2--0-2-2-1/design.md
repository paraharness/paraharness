# harness-dsl: minimal, scenario 12 fixed (child of g00-minimal-0-2-2)

The operator is scenario-fix. The worst scenario is 12, external jobs and locks. Four things were wrong with it:

- ordering derived by file-name arithmetic;
- a parked unit with no exit;
- a parked migration silently starving its database;
- a GPU job pinning locks.

This child fixes those. It also repairs the adversary's three sharpest critiques:

- the quota option on the ledger;
- strings standing in for entities;
- retry expressed three ways.

The cost is a small net change in surface. Added:

- `H.facet`
- `H.seat`, which renames agent
- `H.halts`
- `Command.retries` and `Command.locks`
- `Lane.retries` and `Lane.sequence`
- `sqlite.quota`
- `ControlApi.work.move` and `ControlApi.work.leases`

Removed:

- `KindDescriptor.failsTo`
- `H.policy.retry`, `RetryPolicy`, `RetryView` and `RunOptions.retry`
- `Lane.retry` and `Lane.after`
- `ctx.tag` and tag filters
- `byTag`
- `sqlite.ledger`'s options
- `Ledger.accountState`, `recordUsage` and `recordCooldown`
- `InvocationContext.lease`

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)` or `H.state(name, 'terminal', verdict)` | A shareable lifecycle position. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others)` | A data shape and its states. It declares nothing about failure. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, decision).about(z).timeout(after, resolve).policy(rule)` | A named outside decision. |
| Kind | **resource** | `H.resource(n)` | A named shared thing. Locks and memory scope reference it, and the metric column `resource` keys on it. |
| Kind | **facet** | `H.facet(n, valuesSchema)` | A declared metric dimension and memory-scope axis, for example `category` or `section`. A flow sets its value per attempt with `ctx.facet(f, v)`. |
| Instance | account, model, runner, store, memory store, supplier, ledger, quota partition, guard, observer, client | adapters only | A specific thing with its backend. |
| Pivot | **seat** | `H.seat(n, role).model(m \| policy)` | Role × model, chosen at attempt time. It is the executable that calls a model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow).suppliers().store().wip().maxUsdPerUnit().retries(n, {backoff, exhausted}).locks(f).sequence(f, parked)` | A work queue: kind × suppliers × store × handler, with its capacity, retry bound and ordering. |
| Pivot | **library** | `H.library(n, memory, store)` | A recall source: memory kind × store. |
| Pivot | **pool** | `H.pool(n, members, policy?)` | The account that serves a call. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | **flow**, **command**, **job**, **policy**, **operation**, **harness** | as in the parent | `command` gains `.retries(n, backoff?)` and `.locks(f)`. `H.policy.model` takes its candidate models. |

Kernel halts are halt entities that `H.halts` exports, so grants and filters can name them:

- `interrupted`
- `definitionChanged`
- `costCeiling`

They share one decision schema, `{ action: 'restart' | 'continue' | 'abandon' }`, and their facts carry what was recorded and which locks are held.

## Execution vocabulary

| Word | Meaning |
|---|---|
| **Run** | One process lifetime. |
| **Attempt** | One execution of a lane's flow for one unit. Its states are `running`, `blocked`, `waiting` and `ended`. An ended attempt has the outcome `succeeded`, `failed` or `cancelled`. |
| **Invocation** | One call of one executable. A job is one invocation. Each batch item and each command retry is its own invocation. |
| **Retry** | Running the same thing again after it failed, up to a declared count. A lane retries *attempts*; a command retries *invocations*. It is one concept attached at two levels, and each count is named for what it counts: `UnitRecord.attemptFailures`, and invocation entries with status `retrying`. |

"Step" is not used.

## Rules

### 1. Skeleton (principle 12)

**Positions.** A unit's position is derived as follows:

| Condition | Position |
|---|---|
| A running attempt | `active` |
| A blocked or waiting attempt, including a job or batch in flight | `waiting` |
| No live attempt | The position its state declares |

**Ending an attempt.**

- A flow ends by returning a state (attempt `succeeded`).
- It may instead return `ctx.fail` or throw (attempt `failed`).
- An outside move, a preemption or an abandon interrupts it (attempt `cancelled`). The one exception is the abandon of a parked attempt, below.

**Failure (the principle-12 default).**

- A failed attempt leaves the unit at pending under the lane's retry bound.
- `lane.retries(n, { backoff?, exhausted })` allows `n` further attempts. After that the unit moves to `exhausted`, a state of the lane's kind, and nowhere else.
- `retries(0, { exhausted })` is "do not retry" and needs no fake policy.
- A lane without `.retries` uses the kernel default: unbounded retries with backoff from 1 minute to 1 hour. That default never exhausts.
- Because `exhausted` is a required argument, "bounded with no end state" cannot be written.
- **`failsTo` is deleted.** Principle 12 now holds without exception.

**Command retries.** `command.retries(n, backoff?)` retries the invocation inside the attempt. Exhaustion returns `Result.ok === false` to the flow, and the flow decides what to do. It has no end state because it moves no unit. The two retries do look different, but each is declared where its count lives. This replaces `RunOptions.retry`, which let one policy value mean two things.

### 2. Waits, success rate, outside moves, supply

These are unchanged from the parent. The text is restated here only where it changed: `deferred` updates, `ctx.wait`, rates with `hits` and `samples`, and the rule that neutral states are excluded from `successRate`.

### 3. Entities, not strings

**Memory scope.** `MemoryDraft.when` takes descriptors:

- `kinds: KindRef[]`
- `roles: RoleRef[]`
- `resources: Resource[]`
- `facets: FacetValue[]`

`FacetValue` comes from `facet.of(v)`. The store persists names, and the kernel converts them.

**Recall scope.** It is the attempt's kind, the seat's role, the attempt's facet values, the attempt's locked resources, and `RunOptions.resources`.

**Skills.** The principle-14 envelope's "skills" are facet values. A harness that wants a skill axis declares `H.facet('skill', ...)`. There is no separate skill entity.

**Metric dimensions.** Every dimension is either a typed column or a declared facet:

- The columns are `kind`, `lane`, `state`, `model`, `seat`, `resource`, `halt` and `resolver`.
- `rateBy({ ..., by })` takes a column, a `Facet<V>`, or `{ modelOf: seat }`.
- `{ modelOf: seat }` means the model that seat used in the same attempt. This is how "approval rate by model" keys a halt resolution on the drafter's model without the flow tagging anything.
- Grouping by a facet returns `Partial<Record<V, Rate>>`.

**Facets on entries.** Facet values set by `ctx.facet` are stamped on every later entry of the attempt and on the attempt row. `EntryFilter.facets` filters by them.

**Facets checked at startup.**

- A facet named like a column is a startup error (principle 18).
- A value outside the facet's schema fails at `ctx.facet`.

**Seat.** The seat answers known weakness 1 by having one noun:

- An agent in principle 8's sense is a seat given one model.
- `seat` is the metric column, so swapping the model behind a seat keeps one series.
- `H.policy.model(name, candidates, decide)` declares its candidates, so startup can check that some pool serves each one.

**Scheduler views.** `SchedulerView.live` replaces `active`. It lists units with a live attempt, each carrying `position: 'active' | 'waiting'`. "Active" now means only a position (principle 22).

### 4. Halts (principle 17)

These are unchanged from the parent:

- the three resolvers: policy at raise, human by a grant naming the halt, clock from the recorded raise;
- `H.on.halted` for escalation;
- `decisionMs` by `halt` and `resolver`.

### 5. Triggers

These are unchanged from the parent. A grouped `on.metric` over a facet types its group as the facet's values.

### 6. Scheduler, capacity, locks, ordering (the scenario-12 repair)

**Capacity.** WIP and runner slots are held only by attempts at position `active`.

**Locks.** A lock is `{ resource, mode }`. Exclusive excludes everything on the resource; shared excludes only exclusive. Locks have two declared scopes:

| Declared on | Scope | Held | Used for |
|---|---|---|---|
| `command.locks(input => Lock[])` | invocation | From acquisition before the invocation until it ends. | Step-scoped work: a migration's `apply`, a canary's `drain` and `promote`. |
| `lane.locks(data => Lock[])` | attempt | From before the attempt starts until it ends, including its waits. | Work whose whole span must exclude others, such as a backfill holding a shared lock across all its batches. |

- A job's in-flight time is never under an invocation lock, because only its `submit` command can declare one. A GPU run pins nothing unless the author puts the lock on the lane.
- The scheduler starts a unit only if its lane locks are free.
- An invocation lock that is not free makes the attempt wait at position `waiting`, holding no WIP. The wait is a `lease requested` entry, and `lockWaitMs` is measured on `acquired`.

**Parked attempts keep their locks, visibly.**

- An attempt parked on `H.halts.interrupted` keeps every lock it held.
- A half-applied migration must not let backfills in, so releasing those locks would be the unsafe default.
- The holding is not hidden:
  - `HarnessView.leases()` and `ControlApi.work.leases()` list each lease with its holder, position and `parked: true`.
  - The board renders held resources.
  - The halt's facts carry `locksHeld`.
- When the supervisor resolves the halt:

| Action | What happens |
|---|---|
| `restart` | Reruns the interrupted invocation. |
| `continue` | Treats it as done. |
| `abandon` | Ends the attempt as `failed` with `abandoned: true`. The lane's retry bound then applies. Locks are released at once. |

- Abandon and crash are excluded from seat, model and runner rates, because no invocation failed.

**Ordering.** `lane.sequence(order, parked)` replaces `after`:

- Units of the lane are ordered by the string `order(data)`.
- A unit starts only when every unit of the lane with a lower order value, counting the latest unit per value, sits at a `success` terminal.
- There is no predecessor arithmetic, so a gap such as 0041 to 0043 is harmless.
- A unit read before its predecessors simply waits at pending.
- If a lower unit ends at `failure` or `neutral`, the unit moves to `parked`, which must be a waiting state. The transition carries a `reason` naming the blocking unit and its state.

**Ways out of `parked`.**

- **Automatic.** When a unit with the blocking order value later reaches success, the parked unit returns to its kind's initial state. That unit is a re-created 0041, created by the operator or re-supplied, and the latest unit per value counts.
- **Manual.** The supervisor may `work.move(key, state, reason)`, granted by `writeWork`.

**Placement.** Unchanged: the first runner with a free slot and a passing preflight.

### 7. Jobs

These are unchanged from the parent:

- submit, then the attempt waits;
- polling every interval;
- a remote failure is an invocation failure;
- on restart the job is collected, never resubmitted;
- `durationMs` is the time in flight, and `mode` is `job`.

### 8. Cost

`maxUsdPerUnit` is cumulative across a unit's attempts. Passing it blocks on `H.halts.costCeiling`.

### 9. Accounts and quota (principle 15)

**The partition.**

- Quota is a partition of append-only `QuotaEvent`s (`usage`, `cooldown`), folded at read time.
- `QuotaPartition` has two methods: `appendQuota` and `quotaEvents`.
- The account names its partition as part of its backend, for example `claude.subscription(n, { token, quota: sqlite.quota('~/.harness/quota.db') })`.
- The ledger carries no quota option.

**When an account names none.** Its events go to the harness ledger. `Ledger` extends `QuotaPartition`, so this is the ledger's own partition, not a second store under its name.

**Scenario 7.** Both harnesses import the same account entities from a shared module, and so the same partition. Each appends its own consumption and needs no lock over the other.

**Shares.** Shares stay on pools.

### 10. Memory

- The kernel owns the envelope.
- Candidates are not recalled until accepted.
- Recall is one deterministic kernel policy: scope match by descriptor identity, ranked by specificity and by track record.

### 11. Durability (scenario 10)

These are unchanged from the parent: replay by sequence number, `.recovery` per command, parking on `interrupted`, a changed fingerprint parking on `definitionChanged`, and a resumed attempt keeping its id.

**Single writer.** `Ledger.claimWriter` answers `claimed`, `took-over` (the previous writer's lease expired) or `refused`. `start()` fails on `refused`.

**Backfill resumption.** Each batch is one recorded invocation, so a restart resumes at the first batch with no recorded result. The lane's shared lock is reacquired before the attempt resumes.

### 12. Control API

- The API is made of operations, and grants name halts.
- `work.move` and `work.leases` are added. `writeWork` grants the first; `readWork` grants the second.

### 13. Startup validation

`start()` fails, with the offending name, on each of these:

**Names and references**

- duplicate descriptor names, across every entity sort;
- a facet named like a column;
- a trigger that references a lane not registered.

**States**

- a flow state that is not a state of the lane's kind;
- a `retries` exhausted state that is not a state of the lane's kind;
- a `sequence` parked state that is not a waiting state of the lane's kind;
- a `wait` target that is not a waiting state.

**Seats and models**

- a seat model, or a policy candidate, that no pool has an account for;
- a batch on a model without `submit` and `collect`.

**Executables and halts**

- a command without argv or runners;
- a job whose commands have no runner;
- a halt whose `.timeout` or `.policy` reads facts but has no `.about`.

**Harness**

- a missing ledger.

A harness with no pools, seats or models is valid.

## What changed and why

| Problem (critique) | Change |
|---|---|
| 12: ordering by `number - 1`, gaps strand units | `Lane.sequence(order, parked)`: order over the lane's own units. There is no predecessor key, so gaps are harmless. |
| 12: parked unit has no exit | Automatic release when the blocking order value later succeeds, plus `ControlApi.work.move`. |
| 12: parked migration starves its database invisibly | Locks gain a declared scope. A parked holder keeps its locks on purpose (safety), but the leases are listed with `parked: true` on the board, in the API and in the halt's facts. `abandon` releases them. |
| 12: shared `failed` and `neverRetry` exist to satisfy the type | `Lane.retries(0, { exhausted })` replaces the policy. Scenario files will give each kind its own exhausted state where the meanings differ. Sharing a state stays legal (principle 12 says states are shareable). |
| 12: GPU job holds locks | Invocation-scoped locks sit on commands, so a job's flight is unlocked unless the author chooses a lane lock. |
| Critique 1: quota partition as a ledger option | `Account.quota: QuotaPartition`, `sqlite.quota`, and `Ledger extends QuotaPartition` as the default. The three account methods are removed from `Ledger`. |
| Critique 2: strings in memory scope and metrics; no seat | `ScopeDraft` takes descriptors, plus `H.facet` with `ctx.facet` and facet-filtered entries. `rateBy.by` is a column, a facet or `{ modelOf }`. `H.seat` replaces `H.agent` and is a column. Tags are gone. |
| Critique 3: retry three ways, `failures` two counts | `failsTo`, `RunOptions.retry` and `H.policy.retry` are removed. There is one declarative `retries` on lane and on command, and the counts are named apart. `SchedulerView.active` becomes `live` with a position. |

### Weaknesses left open

- **Two gates of one halt in one flow are distinguishable only by sequence number.** This is known weakness 3, and scenario 13 is not in the battery. An address would be a step name, which this design does not have.
- **Batch and job remain two forms.** A batch is the priced, model-only case, and folding it into job would lose the batch discount in telemetry.

## Principles broken

None.

The parent's break of principle 12 (`failsTo`) is repaired by deletion. The parent's break of principle 15 (a quota option on the ledger) and its breaks of principles 8 and 18 (strings for resources and dimensions) are repaired as described above.
