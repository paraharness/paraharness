# harness-dsl: minimal, job deleted (child of g00-minimal-0-2-2)

The operator for this child is **delete**. The entity removed is **`job`** (`H.job`, `Job`, `JobDraft`, `JobShape`, `JobSubmitted`).

An external job is now a **collected command**: `H.command(n)...collect(poll, every)`. It is a command whose effect finishes outside the harness, and its result is polled until done.

The child also repairs the adversary's three sharpest critiques, and the principle-12 break the parent listed (`failsTo` is gone).

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)`, or `H.state(name, 'terminal', verdict)` | A shareable lifecycle position. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others)` | A data shape and a set of states. It declares nothing about failure. |
| Kind | **role** | `H.role(n).input(z).output(z).prompt(f).intents([...])` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, decision).about(z).timeout(after, resolve).policy(rule)` | A named outside decision, with up to three resolvers. |
| Kind | **resource** | `H.resource(n)` | A named shared thing that locks, memory scope and metrics reference by identity. |
| Kind | **facet** | `H.facet(n, z.enum([...]))` | A declared metric dimension. `facet.of(value)` produces a typed facet value. |
| Instance | account, model, runner, store, memory store, quota log, supplier, ledger, guard, observer, client | adapters only | Specific resources, each carrying its backend. |
| Pivot | **seat** | `H.seat(n, role).model(m \| policy)` | An executable: a role held by the model a policy picks at attempt time. A seat with a fixed model is what principle 8 calls an agent. |
| Pivot | **lane** | `H.lane(n, kind).handler().suppliers().store().wip().maxUsdPerUnit().retry().locks().ordered()` | A work queue: kind × suppliers × store × handler. |
| Pivot | **library** | `H.library(n, memory, store)` | A journal: memory kind × store, with the kernel's recall. |
| Pivot | **pool** | `H.pool(n, members, policy?)` | The account that serves a call: accounts × policy. |
| Pivot | **trigger** | `H.trigger(n, source, (event, act) => effects)` | A recorded consequence of recorded state. |
| Composite | **flow** | `H.flow(n).for(k1, k2?).params(z).does(ctx => state)` | A handler body. |
| Composite | **command** | `H.command(n).input().output().argv().on().recovery().retry().collect()` | A deterministic executable. With `.collect`, it is an external job. |
| Composite | **policy** | `H.policy.{model, account, scheduler, attemptRetry, invocationRetry, rule}` | A deterministic decision. |
| Composite | **operation** | `H.ops.*`, `H.ops.resolve(...halts)`, `H.operation(n, exec)` | A grantable unit of the control API. |
| Root | **harness** | `H.harness(n).ledger().lanes().pools().triggers().scheduler().clients().observers()` | The running thing. |

These are values, not entities:

- `H.clock(...)` and `H.operator`, which are kernel suppliers.
- `H.env(name)`.
- `When`, `Lock`, `FacetValue`, `TimeSpec`, `Interval`, `Bound`, `MetricBounds`, `JobPoll`, `Children`.

## Execution vocabulary

- **Run**: one lifetime of a harness process.
- **Attempt**: one execution of a lane's flow for one unit.
  - Its states are `running`, `blocked` (on a halt), `waiting` (in `ctx.wait`, on a collected command, or on a batch) and `ended`.
  - When ended, its outcome is `succeeded`, `failed` or `cancelled`.
- **Invocation**: one call of one executable inside an attempt.
  - Each retry and each batch item is its own invocation.
  - A collected command is one invocation (mode `job`), from submit to final poll.
- **Step** is not a word in this design. **Job** is only an invocation mode.

## Rules

### 1. Skeleton (principle 12)

**Positions.** A unit's position is derived as follows:

| Condition | Position |
|---|---|
| A live attempt is running | `active` |
| A live attempt is blocked or waiting | `waiting` |
| No live attempt | The position its state declares |

Every terminal state declares a verdict. There is no default.

**How a flow ends.**

| How the flow ends | Attempt outcome | What happens to the unit |
|---|---|---|
| Returns a state | `succeeded` | Moves to that state. |
| Returns `ctx.fail` or throws | `failed` | See the failure rule below. |
| Interrupted by an outside move, a preemption or a cost ceiling | `cancelled` | Handled by the rule that interrupted it. |

**The failure rule.** A failed attempt leaves the unit at pending under the lane's retry policy.

- `lane.retry(policy, exhausted)` sets the policy and the end state:
  - When the policy returns `'stop'`, the unit moves to `exhausted`, which is a state of the lane's kind, and nowhere else.
  - `lane.retry('never', exhausted)` moves it there on the first failure.
- A lane without `.retry` uses the kernel default: backoff from 1 minute, capped at 1 hour, unbounded. It never exhausts.
- The kind declares nothing about failure.

### 2. Two retries, two names (principle 22)

| | Attempt retry | Invocation retry |
|---|---|---|
| Policy builder | `H.policy.attemptRetry` | `H.policy.invocationRetry` |
| Attached with | `lane.retry` | `command.retry` |
| The policy reads | `failedAttempts` | `failedInvocations` |
| On `'stop'` | The unit moves to the declared exhausted state. | The flow receives `Result.ok = false`. |

The two types are distinct and cannot be swapped. `RunOptions.retry` is gone.

### 3. Durable waits

`ctx.wait` suspends the attempt:

- The unit moves to the waiting state.
- The attempt holds no WIP and no slot.
- On wake, the same attempt resumes by replay.

### 4. Moves from outside

- A move on a unit with a live attempt cancels the attempt.
- A supply marked `deferred: true` is held while the attempt is running. It is applied when the attempt next blocks, waits or ends.

### 5. Supply keys

- A `create` whose key belongs to an open unit is ignored.
- An `update` addresses the open unit with that key.

### 6. Entities, not strings (principles 8 and 18)

**Filters.** `EntryFilter` fields take entities: `kind`, `lane`, `state` (a `State`), `executable`, `seat`, `model`, `halt`, `resource`, `trigger`, and `facets` (facet values).

**Memory scope.** `When` takes `kinds: KindRef[]`, `roles: RoleRef[]`, `resources: Resource[]` and `skills: FacetValue[]`.

- A skill is a value of a declared facet, such as `category.of('refunds')`.
- The stored `ScopeRecord` holds names, because it is a serialization for backends.

**Dimensions.** A metric dimension is a typed column or a facet:

- The columns are `kind`, `lane`, `state`, `model`, `seat`, `resource`, `halt` and `resolver`.
- `ctx.tag(...facetValues)` marks the attempt. Every entry of that attempt matches the facet.
- `rateBy({ by: facet })` returns a record keyed by the facet's value type.
- A facet named like a column is a startup error.

**Seats.**

- `ModelChoice.seat` and the `seat` column key an A/B series on the seat.
- Swapping a seat's model keeps one series. The `model` column splits it when wanted.

### 7. Halts (principle 17)

Resolvers are recorded on the resolution:

| Resolver | How it acts |
|---|---|
| `policy` | `.policy(rule)` runs at raise. A non-null result resolves the halt, and the entry carries its reads and sample counts. |
| `human` | A client granted `H.ops.resolve(halt)` resolves it. |
| `clock` | `.timeout(after, resolve)` resolves it from the recorded raise. The attempt continues. |

`H.on.halted(halt, after)` fires once at `after` from the raise, if the halt is still open. It is used to page a deputy.

### 8. Triggers

**Sources:**

- `enters(kind, state, { times? })`
- `streak`
- `deadline`
- `metric(read, bounds)`, ungrouped
- `metric(facet, read, bounds)`, grouped by facet value, with hysteresis. Its firings carry the facet value, so "audits per category this month" is a `count` with `facets`.
- `halted`

**Firing order.** Transition triggers run in the transaction that records the transition.

**Recording.** Every firing is a `firing` entry.

### 9. Scheduler, locks, ordering

**Scheduler.**

- The scheduler receives `pending` and `live`. Each live unit has position `active` or `waiting`.
- It returns `start` and an optional `preempt`. Preempting a unit at `waiting` cancels it.
- `active` names a position only.
- WIP and slots are held only at `active`.

**Locks.** `lane.locks(data => Lock[])` declares locks held for the life of the attempt.

- Exclusive excludes everything on the resource. Shared excludes only exclusive.
- Leases are ledger entries, and `lockWaitMs` is measured on `acquired`.
- An attempt parked on `interrupted` keeps its locks, and the board shows the holder. See "Rebuttals" for why.

**Ordering.** `lane.ordered(key, held)` starts the lane's units in ascending `key` order. A unit starts only when every unit of the lane with a lower key is at a `success` terminal.

- Gaps in numbering are harmless, because no predecessor is computed.
- If a lower unit ends at `failure` or `neutral`, the unit moves to `held`, which must be a waiting state, with a `reason`.
- When that lower unit later reaches `success`, the kernel returns the held unit to its kind's initial state.
- The supervisor may also move it with `writeWork`.

### 10. Collected commands (principle 3)

`command.collect(poll, every)` is only allowed on a command whose output is a string, the handle.

- `submit` records the handle on an invocation with status `submitted`. The attempt then waits and holds no WIP and no slot.
- `poll(handle)` runs every `every` until it returns `done` or `failed`.
  - A remote `failed` is an invocation failure.
  - A crash while the job runs is not: on restart the handle is polled, never resubmitted.
- A crash *before* the handle was recorded follows the command's `.recovery`.
- `durationMs` is the time in flight. The mode is `job`.
- A batch of model calls is `ctx.batch(seat, inputs)`, the same submit-and-collect pattern over the model's `submit` and `collect`, with mode `batch`.

### 11. Cost

- `maxUsdPerUnit` is cumulative across a unit's attempts.
- An invocation that would pass it blocks on the kernel halt `cost-ceiling`.

### 12. Quota (principle 15)

- Each account names its quota partition: `subscription(n, { token, quota: sqlite.quota(path) })`.
- A `QuotaLog` is append-only. Each harness appends its own usage and cooldown events and folds the window at read time. There is no lock across harnesses.
- An account without `quota` keeps its events as `quota` entries in the harness's own ledger partition.
- The ledger has no quota option or method, and `sqlite.ledger(path)` takes only a path.
- Two harnesses that import one account module share its `QuotaLog` by entity, not by agreeing on a string.

### 13. Memory

- The kernel owns the envelope.
- Candidates are not recalled until accepted.
- Recall is a deterministic kernel policy, ranked by specificity of `When` and by track record. A similarity backend only supplies candidates.

### 14. Durability

**Replay.**

- Every `run`, `batch`, `halt`, `decide`, `move`, `update`, `remember`, `spawn` and `wait` is a ledger entry with a sequence number.
- Replay returns recorded results.

**Interrupted invocations.**

- They follow `.recovery`: `'rerun'`, `'park'` (the default) or a check command.
- Seats ask the model's `recover`.

**The attempt record.**

- A resumed attempt keeps its id.
- Interrupted invocations are excluded from model and seat rates.

**A changed definition.** A changed flow fingerprint blocks the attempt on the kernel halt `definition-changed`.

**Single writer.** `Ledger.claimWriter` is renewed while running. A second process refuses to start, or takes over from an expired claim.

### 15. Control API

- The API is made of operations, and each client is granted operations.
- `claude-code.supervisor` and `http.control` are two transports. A grant may name halts.

### 16. Startup validation

`start()` fails in each of these cases:

- duplicate names, including facets, halts and resources;
- a facet named like a column;
- flow states that are not states of the lane's kind;
- `wait` or `ordered` targets that are not waiting states;
- a `retry` exhausted state outside the lane's kind;
- a trigger on an unregistered lane;
- a seat whose model, or any of whose policy candidates, no pool serves;
- a command without argv or runners;
- `collect` on a command with no runner;
- a batch on a model without `submit` and `collect`;
- a missing ledger.

A harness with no pools, seats or models is valid.

## What changed and why

### Deletion: the job entity

`H.job` had one caller, scenario 12. That is principle 21's "an entity with one use is suspect". Its submit half was already a command, with `recovery`, runners and argv.

Folding it into `command.collect` changes three things:

- It removes five declarations.
- It puts the restart rule of an external job on the one object that owns the effect.
- It answers part of known weakness 2: the external job and the model batch are now one pattern, and differ only in who submits (a command or a model).

**Battery repair.** Scenario 12's `gpuEval` becomes `submitEval.collect(collectEval, { minutes: 10 })`. No other scenario used `H.job`.

### Critique 1: quota was an option on the ledger

The repair is as follows:

- `sqlite.ledger(path, { sharedQuota })` is removed, along with `Ledger.accountState`, `recordUsage` and `recordCooldown`.
- `Account.quota?: QuotaLog` is added, a backend instance that the account names.
- `sqlite.quota(path)` is added.

Scenario 7 declares the accounts and their quota log once, in the module both harnesses import.

### Critique 2: strings for entities

The repair is as follows:

- `H.facet` is added, and `ctx.tag(...FacetValue)` is now typed.
- `rateBy({ by: Column | Facet })` replaces `byTag: string`.
- `EntryFilter.facets`, `.seat`, `.model` and a `state` typed as a `State` are added.
- Memory `When` takes entities.
- Metric triggers take the facet they group by.

`agent` is renamed `seat`, because principle 8 names the seat as the general pivot and principle 18 names `seat` as a column. One noun remains (principle 22), and a model swap keeps the series.

`H.policy.model` now takes its candidate models, so startup can check that the pools serve them.

### Critique 3: retry three ways

The repair is as follows:

- `failsTo` is deleted.
- `RunOptions.retry` is deleted.
- Two typed policies replace the shared `RetryView { failures }`:
  - `attemptRetry` reads `failedAttempts` and is used on lanes.
  - `invocationRetry` reads `failedInvocations` and is used via `command.retry`.
- `lane.retry('never', state)` replaces the `neverRetry` policy that existed only to satisfy the type.
- `SchedulerView.active` becomes `live`, typed with its position. "Active" is now only a position.

### Scenario 12 critique points

- **Ordering by arithmetic.** It becomes `lane.ordered(key, held)`. It is gap-safe and computes no predecessor.
- **No way out of the held state.** There is now an automatic release when the lower unit succeeds, plus `writeWork`.

### Rebuttals

- **"A parked migration starves its database."** This is correct, and it is wanted. A migration interrupted mid-apply leaves its database in an unknown state. Releasing the exclusive lock would let a backfill run against a half-migrated schema. The repair is visibility: the board shows the lock holder and the `interrupted` halt. The lock is released when the supervisor resolves or abandons the attempt.
- **"One `failed` state shared by three kinds."** Principle 12 makes states shareable entities. Sharing one terminal `failed` across kinds is the intended use, not a defect.
- **"A GPU job holds locks."** Locks are held for the attempt life only when a lane declares them. The eval lane declares none.
- **Step-scoped locks and two addresses of one halt (critique scenario 13).** These are outside the battery. Per principle 21 no surface is added for them.

## Principles broken

none
