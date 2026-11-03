# harness-dsl: minimal, job and batch merged (child of g01-minimal-0-2-2--0-2-2-1)

The operator is **merge**. This child merges **batch into job**, which is known weakness 2. A batch of model calls was always a submit-and-collect job whose submitter and collector happen to be a model's batch API. It is now one step kind, built two ways.

The child also answers the adversary's three sharpest critiques of the parent:

- the unbounded retry default;
- "waiting" meaning four things;
- facets and model keys written as strings.

It repairs the scenario 11 and scenario 9 defects the critique named.

## Entities

| Sort | Entity | Builder | Produces / is |
|---|---|---|---|
| Kind | **state** | `H.state(name, position)` or `H.state(name, 'terminal', verdict)` | A shareable lifecycle position. |
| Kind | **kind** | `H.kind(n).data(z).states(initial, ...others)` | A data shape and its states. It declares nothing about failure. |
| Kind | **role** | `H.role(n).input().output().prompt().intents()` | What a model call is asked to do. |
| Kind | **memory** | `H.memory(n, 'experience' \| 'taste')` | A memory kind. |
| Kind | **halt** | `H.halt(n, decision).about().timeout().policy()` | A named outside decision. |
| Kind | **resource** | `H.resource(n)` | A named shared thing that locks, scope and the `resource` column reference. |
| Kind | **facet** | `H.facet(n, values)` | A declared metric dimension and memory-scope axis. |
| Instance | account, model, embedder, runner, store, memory store, supplier, ledger, quota partition, guard, observer, **client** | adapters only | A specific thing with its backend. A client now carries a name, so two supervisors are two entities. |
| Pivot | **seat** | `H.seat(n, role).model(m \| policy)` | Role × model chosen at attempt time. An agent is a seat with one model. |
| Pivot | **lane** | `H.lane(n, kind).handler(flow).retries(n, {exhausted})` and then `.suppliers() .store() .wip() .maxUsdPerUnit() .locks() .sequence() .reentries() .facet()` | A work queue: kind × suppliers × store × handler, with its bounds. |
| Pivot | **library** | `H.library(n, memory, store)` | A recall source. |
| Pivot | **pool** | `H.pool(n, members, policy?)` | The account that serves a call. |
| Pivot | **trigger** | `H.trigger(n, source, effect)` | A recorded consequence of recorded state. |
| Composite | **flow**, **command**, **job**, **policy**, **operation**, **harness** | — | A job is built as `H.job(n).output().submit().collect()` or as `H.job(n).batch(seat, every)`. |

Kernel halts (`H.halts.interrupted`, `definitionChanged`, `costCeiling`) are unchanged.

## Execution vocabulary

| Word | Meaning |
|---|---|
| **Run** | One process lifetime. |
| **Attempt** | One execution of a lane's flow for one unit. |
| **Invocation** | One call of one executable. A job is one invocation, and each item of a batch job is a child invocation row (`item: n`). |
| **Retry** | Running the same thing again after it failed, up to a declared count. A lane retries attempts; a command retries invocations. |

An attempt's status is one of:

| Status | Meaning |
|---|---|
| `running` | Holds capacity. |
| `blocked` | On a halt. This is principle 12's word for waiting on a human. |
| `asleep` | On a clock, on children, on a job in flight, or on a lock. |
| `ended` | Finished, with outcome `succeeded`, `failed` or `cancelled`. |

**Waiting is now only a position.** A unit is at `waiting` when its attempt is blocked or asleep, or when it has no live attempt and its state declares `waiting`. The flow verb is `ctx.sleep(until)`. It takes no state, because where a live unit stands is its attempt's current invocation, read from the ledger (principle 12). `LiveView.status` reports the attempt status, not a second position.

## Rules

### 1. Skeleton and retries (principle 12)

**Retries are mandatory.**

- `H.lane(...).handler(flow)` returns a `LaneRetries`. Its only method is `.retries(times, { backoff?, exhausted })`.
- A lane without a retry bound and an exhaustion state therefore cannot be written.
- There is no kernel default, and no lane can retry forever. `retries(0, { exhausted })` means "do not retry".

**Returns are bounded by the lane, not by a trigger.**

- `.reentries(state, { max, then })` is declared on the lane and counted on the ledger (`UnitRecord.reentries`).
- When a flow returns `state` for the `max`-th time, the kernel records the transition to `then` instead. The cause is `reentries` and the reason is the count.
- This happens in the same ledger transaction that ends the attempt.
- So there is no race with the scheduler, no cancelled attempt, and no count in the flow.
- `H.on.enters` loses its `times` option.

**Other attempt rules** are unchanged:

- An attempt ends with outcome `succeeded`, `failed` or `cancelled`.
- Cancelled and abandoned attempts, and crashes, are excluded from seat, model and runner rates, because no invocation failed.

### 2. Outside updates to live units

An update `Supply` declares what happens to a live attempt by naming the attempt's situation:

- **`whileRunning: 'defer' | 'cancel'`**, default `defer`. A deferred patch and state apply when the attempt ends. They do not cancel it and are not lost.
- **`whileWaiting: 'defer' | 'cancel'`**, default `cancel`. Cancel ends the blocked or asleep attempt as `cancelled`, with `cancelledBy: 'supply'`. It then applies the patch and the state, so a pending state re-queues the unit from the top of its flow.

This is how scenario 11 expresses "defer during `draft`, re-enter at `draft` while waiting on counsel" without inspecting anything. Scenario 2's customer reply while a draft awaits approval uses the default `whileWaiting: 'cancel'`.

### 3. Facets are declared, not stamped

- `lane.facet(category, data => data.category)` declares a facet value as a function of unit data.
- The kernel stamps the value on every entry about the unit: transitions, attempts, invocations, halts, leases, and firings caused by the unit. It evaluates the value at entry time, so a value written by `ctx.update` mid-attempt tags every later entry.
- A grouped metric trigger stamps its firing with `facet.of(group)`. So "Audits opened per category" counts firings that carry `category.of(value)`.
- `ctx.facet` is removed. A flow can no longer forget to tag.
- Recall scope includes the unit's declared facet values.

### 4. Groupings are keyed by entities

- `rateBy` returns `Grouped<K>`, which has `keys` and `get(key): Rate`.
- `get` never returns `undefined`: an absent key is `{ value: null, hits: 0, samples: 0 }`.
- Grouping is by a `Facet<V>` (keys are `V`), or by `{ seat, models }` (keys are the `Model` entities given).
- `byModel.get(sonnet)` replaces `byModel[sonnet.name]`.
- Grouping by a raw column string is removed. Columns remain filters.
- Model attribution is "the model the seat used in the same attempt", so a halt resolution keys on the drafter's model with no tagging.

### 5. Job, merged with batch (the operator)

**One job, two builders.**

- `H.job(n).output(z).submit(cmd).collect(cmd, every)` is an external job.
- `H.job(n).batch(seat, every)` is a batch: a `Job<readonly I[], readonly Result<O>[]>` whose submit and collect are the seat's model's `submit` and `collect`.
- Both run through `ctx.run`, and `ctx.batch` is gone.

**What a job does, either way.**

- Submit is recorded with its handle.
- The attempt goes `asleep` and holds no WIP and no runner slot.
- A poll runs every interval.
- On restart, `Recovered.collect` resumes polling, so a submitted job is collected and never resubmitted.
- A remote failure is an invocation failure.

**Startup check.** A batch job whose seat can resolve to a model without `submit` and `collect` is a startup error.

**Honesty cost, stated.**

1. **Pricing shows only at item level.** The job row has `mode: 'job'` whatever it wraps. The batch discount is visible only on the per-item child rows (`mode: 'batch'`, priced at `Price.batchDiscount`). Telemetry that sums cost "of jobs" must read item rows, or it double-counts the job row; the job row carries `costUsd: 0` for batches to keep sums right. A reader who sees `mode: 'job'` cannot tell a GPU run from a model batch without the `executable` column.
2. **Item failures stay item results.** A batch job succeeds when it is collected, even if every item failed. Item failures are `Result`s in the output. An external job has a single remote outcome. So "the job failed" means "collection failed" for a batch, but "the remote work failed" for an external job.
3. **The seat is selected once for the whole batch**, not per item. The policy decides once for the job.

We judge these smaller than keeping two step kinds and two context verbs for one mechanism.

### 6. Scheduler, capacity, locks, ordering

These are unchanged from the parent:

- Capacity is held only by `running` attempts.
- Invocation locks are declared on commands, and attempt locks on lanes.
- A lock that is not free puts the attempt `asleep`.
- A parked attempt keeps its locks, and they are listed with `parked: true`.
- `sequence` orders over the lane's own units, and a failed predecessor parks the unit with a reason.

`LeaseView.holderStatus` replaces `holderPosition`.

### 7. Trigger effects on keys

`act.create(lane, data, key)` behaves according to the unit already at that key:

| Unit at the key | Result |
|---|---|
| None | A new unit. |
| A unit whose position is not terminal | The firing is recorded `deduped`, with no effect. This is the scenario 9 dedup by group. |
| A terminal unit | A new **generation** of the key (`UnitRecord.generation`). The latest generation is the live one, so a withdrawn Audit for `refunds` does not block next month's. |

### 8. Halts and clients

Halts are unchanged from the parent:

- a policy resolves at raise;
- a human resolves through a client granted `H.ops.resolve(halt)`;
- a clock resolves from the recorded raise.

Clients now take a name: `claude.supervisor(name, …)` and `http.control(name, …)`.

- `HaltEntry.client` records who resolved, and `EntryFilter.client` filters by it.
- Two persons may resolve one halt by holding two clients that grant it. In scenario 11, finance and the deputy are two named clients, and the deputy is paged by the `H.on.halted` trigger.
- Median decision time per resolver keys on `resolver` and `client`.

### 9. Adapters take entities, not strings

- **Preflight.** `ssh.host({ preflight })` takes a command. The kernel runs it on the candidate runner before placement, records it as an invocation, and skips that runner if it fails. Startup exempts preflight commands from the "command without runners" check.
- **Embedder.** `qdrant.memory({ embedder })` takes an `Embedder` instance (`harness-dsl/voyage`). The vector store and the embedding model are two instances with two backends.
- **`http.store({ stateField })` stays a string, and we keep it.** It names a column in the vendor's schema, which is backend configuration, exactly what principle 5 says the kernel is indifferent to. No kernel entity is being replaced by a string.

### 10. Accounts, memory, durability, control API

These are unchanged from the parent:

- quota partitions, with the ledger as default partition;
- the memory envelope and deterministic recall;
- replay by sequence, per-command `recovery`, parking on `definitionChanged`, and `claimWriter`.

Backfill resumption still works because each batch of rows is one recorded invocation.

### 11. Startup validation

The parent's list, with these changes:

| Change | Rule |
|---|---|
| Removed | The retry-default case. It cannot be written. |
| Added | A `reentries` state or `then` that is not a state of the lane's kind. |
| Added | A `reentries` state that is terminal. |
| Added | A facet on a lane whose value function's codomain is outside the facet schema (checked at stamp time, recorded as an error on the entry, and failing the attempt). |
| Added | A batch job on a model without batch support. |
| Added | Two clients with one name. |

A harness with no pools, seats or models remains valid.

## What changed and why

| Problem | Change |
|---|---|
| Operator: batch and job rhyme | One `Job` entity, with `H.job().batch(seat, every)`. `ctx.batch` is removed. The honesty cost is in rule 5. |
| Critique 1: unbounded retry default breaks principle 12 and scenario 11 | `handler()` returns `LaneRetries`, so a bound and an exhausted state are required by type. There is no kernel default. |
| Critique 1 (scenario 11): return bound races the scheduler | `lane.reentries(state, { max, then })` is applied in the attempt-ending transaction. `on.enters({ times })` is removed. |
| Critique 2: "waiting" four ways | `waiting` is a position only. Attempt statuses are `running`, `blocked`, `asleep`, `ended`. `ctx.wait(state, …)` becomes `ctx.sleep(…)` with no state. `LiveView.position` becomes `status`. `Supply.deferred` becomes `whileRunning` and `whileWaiting`. |
| Scenario 11: redline during counsel must re-enter | `whileWaiting: 'cancel'` with `state: 'received'`. |
| Scenario 11: the deputy cannot resolve | Named clients. A second client grants `resolve(signoff)`. |
| Critique 3: facets imperative and attempt-bound | `lane.facet(f, data => v)`, stamped by the kernel on every entry, including firings. `ctx.facet` is removed. |
| Critique 3: model keys are strings | `Grouped<K>` with `get(model)`. Grouping is by facet or `{ seat, models }`. |
| Critique 3: shell and vendor strings | Preflight is a command; the embedder is an instance. `stateField` is argued as backend config. |
| Scenario 9: audit count always 0; key reuse unspecified | Grouped firings carry the facet value. Rule 7 defines dedup versus generation. |

**Surface changes.**

Added:

- `LaneRetries`
- `Lane.reentries` and `Lane.facet`
- `JobDraft.batch`
- `ctx.sleep`
- `Grouped`
- `Embedder` and `harness-dsl/voyage`
- `Supply.whileRunning` and `Supply.whileWaiting`
- client names

Removed:

- `ctx.batch`, `ctx.facet` and `ctx.wait`
- `on.enters` `times`
- `Supply.deferred`
- the `Column` grouping
- the kernel retry default

### Weaknesses left open

- **A halt asked twice in one flow** (the adversary's scenario 13) is still distinguished only by sequence number. Its grant, timeout and policy live on the halt entity. Two gates with different defaults need two halt entities. A per-call address is the obvious next change, but it is a step name, which this design deliberately lacks.
- **The lane carries nine concerns** (known weakness 6). This child adds two and removes the trigger workaround. A lane-bounds sub-entity was considered and rejected, because it would have no noun beyond "the lane's settings".

## Principles broken

None.

The parent claimed none while carrying an unbounded retry default that breaks principle 12. That default is removed. The facet-by-side-effect and string model keys that strained principles 8 and 18 are replaced by declared facets and entity-keyed groupings.
